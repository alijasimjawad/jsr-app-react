/**
 * phase4-06-audit-delta-sync.ts — Phase 4.5 Full Delta Sync Audit (READ-ONLY)
 *
 * Compares every migrated business table between the old JSR production database
 * (source) and the new JSR React staging database (destination), identifying all
 * rows that are missing, extra, or changed since the original Phase 4 migration
 * (2026-08-04).
 *
 * SAFETY GUARANTEES — this script is strictly read-only:
 *   - Zero writes to either database.
 *   - No schema changes, no RLS modifications, no migrations.
 *   - Identity guard prevents source === destination.
 *   - Hardcoded project-ref pins reject unexpected databases.
 *   - Source password column is never fetched or printed.
 *   - Service-role keys are never printed.
 *
 * KNOWN MIGRATION HISTORY (preserved in comparisons):
 *   - 10 section IDs excluded via skipIds — not counted as "missing".
 *   - 2 section_id column remaps in `rows` (55f63cb0→e8ee675d, b393a48e→3d88c00c).
 *   - Revenue 5-column backfill via phase4-04 (section_name, invoice_date, status,
 *     notes, added_by) — all 12 revenue columns are now comparable.
 *   - 2 post-migration revenue rows inserted via phase4-05 (created 2026-08-05).
 *   - users.password intentionally NULL in destination — never compared.
 *   - users.auth_user_id is destination-only — never compared.
 *   - team_members.username is destination-only — never compared.
 *   - expense_claims: 5 car-trip columns (is_car_trip, daily_activity_id, car_id,
 *     car_trip_distance_km, car_trip_rate_iqd) are destination-only — never compared.
 *
 * OUTPUTS:
 *   - Console: human-readable summary table + per-table detail for tables with deltas.
 *   - File:    scripts/delta-sync-report.json (full ID lists; no passwords or keys).
 *
 * USAGE:
 *   source .env.phase4.local        # or ensure env vars are set in your shell
 *   npx tsx scripts/phase4-06-audit-delta-sync.ts
 *
 * TABLES AUDITED (17 total, same scope as Phase 4 migration):
 *   Tier 0: users, team_members, clients, sections, activity_log,
 *           general_expenses, daily_activities, revenue, project_expenses
 *   Tier 1: employee_documents, expense_claims, salary_adjustments,
 *           push_subscriptions, invoices, rows
 *   Tier 2: invoice_items, invoice_payments
 *
 * LEGACY TABLES (not migrated, not used by React app — checked for row count only):
 *   expenses, expense_budgets, work_log
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 0. Load .env.phase4.local (same loader used by all phase4 scripts) ────────
function loadDotEnvLocal(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(scriptDir, '..', '.env.phase4.local');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnvLocal();

// ── 1. Constants ──────────────────────────────────────────────────────────────
const MIGRATION_DATE = '2026-08-04T00:00:00.000Z'; // original Phase 4 migration date
const OLD_JSR_REF   = 'tltbkjvrhqsxdspdfeqk';       // old JSR production project ref
const TAC_REF       = 'gauejhgitzcqjvzalshf';        // TAC project ref — safety guard
const PAGE_SIZE     = 500;

// ── 2. Env vars + safety guards ───────────────────────────────────────────────
const SRC_URL = process.env.SOURCE_SUPABASE_URL;
const SRC_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const DST_URL = process.env.DEST_SUPABASE_URL;
const DST_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const EXP_SRC = process.env.EXPECTED_SOURCE_PROJECT_REF;
const EXP_DST = process.env.EXPECTED_DEST_PROJECT_REF;

for (const [k, v] of Object.entries({
  SOURCE_SUPABASE_URL: SRC_URL,
  SOURCE_SUPABASE_SERVICE_ROLE_KEY: SRC_KEY,
  DEST_SUPABASE_URL: DST_URL,
  DEST_SUPABASE_SERVICE_ROLE_KEY: DST_KEY,
})) {
  if (!v) { console.error(`ABORT: missing env var ${k} — source .env.phase4.local`); process.exit(1); }
}

function extractRef(url: string): string {
  return url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? '';
}

const srcRef = extractRef(SRC_URL!);
const dstRef = extractRef(DST_URL!);

if (!srcRef || !dstRef)       { console.error('ABORT: cannot extract project refs from URLs.');                                       process.exit(1); }
if (srcRef === dstRef)        { console.error(`ABORT: source and destination are the same project (${srcRef}).`);                    process.exit(1); }
if (srcRef === TAC_REF)       { console.error(`ABORT: source ref is the TAC project (${TAC_REF}), not old JSR production.`);         process.exit(1); }
if (srcRef !== OLD_JSR_REF)   { console.error(`ABORT: source ref "${srcRef}" ≠ expected old-JSR ref "${OLD_JSR_REF}".`);            process.exit(1); }
if (EXP_SRC && srcRef !== EXP_SRC) { console.error(`ABORT: source ref "${srcRef}" ≠ EXPECTED_SOURCE_PROJECT_REF "${EXP_SRC}".`);   process.exit(1); }
if (EXP_DST && dstRef !== EXP_DST) { console.error(`ABORT: dest ref "${dstRef}" ≠ EXPECTED_DEST_PROJECT_REF "${EXP_DST}".`);       process.exit(1); }

// ── 3. Known migration facts ──────────────────────────────────────────────────

/**
 * 10 section IDs that were intentionally excluded from migration because they
 * collide with the destination's UNIQUE(project_name, section_name) constraint.
 * Not counted as "missing" in the audit.
 */
const SECTIONS_SKIP_IDS: ReadonlySet<string> = new Set([
  'adf1a0fe-935b-4024-99f6-06ff138777ac', // zain/tdd      active dup   0 rows
  '332fad28-cefd-4f40-9e74-65a226fce728', // nokia/ftk     active dup   0 rows
  '444023fd-c674-42c3-b02f-90661627c903', // huawei/tdd    active dup   0 rows
  'c3fba5bb-43ac-4d40-a59a-9274069b2238', // nokia/tdd     soft-del     0 rows
  'eba6b3fc-fd70-4096-9976-47ccea342e94', // nokia/addsec  soft-del     0 rows
  '55f63cb0-d58b-45c7-82c1-bb658573c912', // zain/ftk      soft-del   467 rows → remapped
  '381b8d13-c1d6-42a6-b069-5581702769a0', // zain/addsec   soft-del     0 rows
  'eed95201-a02e-441a-afac-999a0509242c', // huawei/ftk    soft-del     0 rows
  'd9f05b55-9de6-41c4-8acd-81654a29d0bc', // huawei/addsec soft-del     0 rows
  'b393a48e-0bd4-422f-99d9-efce62ecaaa4', // ipt/tdd       active dup   4 rows → remapped
]);

/**
 * Known section_id remaps applied during phase4-02.
 * Source rows referencing these section_ids had their FK remapped in the destination.
 * When comparing `rows.section_id`, these remaps are treated as equivalent — not a change.
 */
const ROWS_SECTION_ID_REMAPS: ReadonlyMap<string, string> = new Map([
  ['55f63cb0-d58b-45c7-82c1-bb658573c912', 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'], // zain/ftk  (467 rows)
  ['b393a48e-0bd4-422f-99d9-efce62ecaaa4', '3d88c00c-9309-40c5-96d8-04af7b514c31'], // ipt/tdd   (  4 rows)
]);

/**
 * Revenue rows inserted by phase4-05 (created in source on 2026-08-05, the day
 * after migration). These should exist in both source and destination. Used for
 * labelling in the report — not special-cased in the comparison logic.
 */
const KNOWN_POST_MIGRATION_REVENUE_IDS: ReadonlySet<string> = new Set([
  'afae4065-bcdd-4c32-ac7a-1a579ffe3916', // TAC Project / site 9644
  '50f353e4-50f6-4fef-9cd3-210b2f2a837e', // TAC Project / site 8616
]);

// ── 4. Table definitions ──────────────────────────────────────────────────────

interface FKDef { column: string; parentTable: string; }

interface AuditTableDef {
  name: string;
  /** Columns to SELECT from source. Must never include `password`. */
  srcColumns: string[];
  /**
   * Columns to compare value-by-value between source and destination.
   * Must be a subset of srcColumns.  Destination is queried with these
   * same columns (destination-only columns are excluded automatically).
   */
  cmpColumns: string[];
  fks: FKDef[];
  /** Source IDs intentionally excluded from migration — not flagged as missing. */
  skipSourceIds?: ReadonlySet<string>;
  /**
   * Known column value remaps applied during phase4-02.
   * columnRemaps[column].get(srcValue) === expectedDestValue.
   * Differences matching a remap are not counted as changes.
   */
  columnRemaps?: Readonly<Record<string, ReadonlyMap<string, string>>>;
  /** Whether this table has a `created_at` column (used for post-migration detection). */
  hasCreatedAt: boolean;
  /** Human-readable notes appended to the report for this table. */
  notes?: string[];
}

const TABLES: readonly AuditTableDef[] = [
  // ── Tier 0: no FK dependencies on other migrated tables ──────────────────────
  {
    name: 'users',
    // password never fetched — intentionally NULL in destination.
    // auth_user_id: destination-only (React Auth integration) — never compared.
    // 9 profile columns (phone, national_id, date_of_birth, address,
    //   emergency_contact_name, emergency_contact_phone, start_date, notes,
    //   profile_photo_url): destination-only (old JSR users table had none of these).
    srcColumns: ['id', 'username', 'full_name', 'role', 'permissions', 'created_at'],
    cmpColumns: ['id', 'username', 'full_name', 'role', 'permissions', 'created_at'],
    fks: [],
    hasCreatedAt: true,
    notes: [
      'password: never fetched — intentionally NULL in dest',
      'auth_user_id: not compared — destination-only React Auth column',
      '9 profile columns (phone, national_id, …): not compared — destination-only, filled via My Profile',
    ],
  },
  {
    name: 'team_members',
    // username: destination-only (source team_members had no username column).
    srcColumns: [
      'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at', 'phone',
      'notes', 'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at', 'deactivated_at',
    ],
    cmpColumns: [
      'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at', 'phone',
      'notes', 'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at', 'deactivated_at',
    ],
    fks: [],
    hasCreatedAt: true,
    notes: ['username: not compared — destination-only column (source had no username field on team_members)'],
  },
  {
    name: 'clients',
    srcColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    cmpColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    fks: [],
    hasCreatedAt: true,
  },
  {
    name: 'sections',
    srcColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    cmpColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    fks: [],
    skipSourceIds: SECTIONS_SKIP_IDS,
    hasCreatedAt: true,
    notes: [
      '10 source IDs excluded (UNIQUE constraint collisions) — intentionally absent from dest, not counted as missing',
      'Extra dest sections (above source count) are likely seed/React-only sections — informational only',
    ],
  },
  {
    name: 'activity_log',
    srcColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
    cmpColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
    fks: [],
    hasCreatedAt: true,
  },
  {
    name: 'general_expenses',
    srcColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
    cmpColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
    fks: [],
    hasCreatedAt: true,
  },
  {
    name: 'daily_activities',
    srcColumns: [
      'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
      'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
    ],
    cmpColumns: [
      'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
      'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
    ],
    fks: [],
    hasCreatedAt: true,
  },
  {
    name: 'revenue',
    // All 12 source columns — phase4-04 backfilled the 5 that were absent from
    // the destination at migration time (section_name, invoice_date, status,
    // notes, added_by). Both sides should now have all 12 columns.
    srcColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
    ],
    cmpColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
    ],
    fks: [],
    hasCreatedAt: true,
    notes: [
      'phase4-04 backfilled 5 columns for all originally-migrated rows — all 12 columns now comparable',
      'phase4-05 inserted 2 known post-migration rows (afae4065, 50f353e4) created 2026-08-05',
      'Any source rows still missing from dest beyond those 2 are new production delta',
    ],
  },
  {
    name: 'project_expenses',
    srcColumns: [
      'id', 'project_name', 'description', 'category', 'amount', 'expense_date',
      'month', 'year', 'notes', 'added_by', 'created_at', 'activity_date',
      'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
    ],
    cmpColumns: [
      'id', 'project_name', 'description', 'category', 'amount', 'expense_date',
      'month', 'year', 'notes', 'added_by', 'created_at', 'activity_date',
      'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
    ],
    fks: [],
    hasCreatedAt: true,
  },
  // ── Tier 1: FK dependencies on Tier 0 (or users) ─────────────────────────────
  {
    name: 'employee_documents',
    srcColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    cmpColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
    hasCreatedAt: false,
  },
  {
    name: 'expense_claims',
    // 5 car-trip columns (is_car_trip, daily_activity_id, car_id,
    // car_trip_distance_km, car_trip_rate_iqd) exist only in destination —
    // not selected from dest; not compared.
    srcColumns: [
      'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
      'activity_date', 'transport_amount', 'food_amount', 'accommodation',
      'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
      'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
    ],
    cmpColumns: [
      'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
      'activity_date', 'transport_amount', 'food_amount', 'accommodation',
      'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
      'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
    ],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
    hasCreatedAt: false,
    notes: [
      '5 car-trip columns not compared (destination-only schema extension: is_car_trip, daily_activity_id, car_id, car_trip_distance_km, car_trip_rate_iqd)',
    ],
  },
  {
    name: 'salary_adjustments',
    srcColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
    cmpColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
    hasCreatedAt: true,
  },
  {
    name: 'push_subscriptions',
    srcColumns: ['id', 'user_id', 'subscription', 'created_at'],
    cmpColumns: ['id', 'user_id', 'subscription', 'created_at'],
    fks: [{ column: 'user_id', parentTable: 'users' }],
    hasCreatedAt: true,
  },
  {
    name: 'invoices',
    srcColumns: [
      'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
      'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
    ],
    cmpColumns: [
      'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
      'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
    ],
    fks: [{ column: 'client_id', parentTable: 'clients' }],
    hasCreatedAt: true,
  },
  {
    name: 'rows',
    srcColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    cmpColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    fks: [{ column: 'section_id', parentTable: 'sections' }],
    columnRemaps: { section_id: ROWS_SECTION_ID_REMAPS },
    hasCreatedAt: true,
    notes: [
      '471 rows had section_id remapped during migration (55f63cb0→e8ee675d: 467 rows; b393a48e→3d88c00c: 4 rows)',
      'section_id differences matching the known remaps are not counted as changes',
    ],
  },
  // ── Tier 2: FK dependencies on Tier 1 ────────────────────────────────────────
  {
    name: 'invoice_items',
    // No created_at column — post-migration detection skipped.
    srcColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    cmpColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
    hasCreatedAt: false,
  },
  {
    name: 'invoice_payments',
    srcColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    cmpColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
    hasCreatedAt: true,
  },
];

// ── 5. Result types ───────────────────────────────────────────────────────────

interface TableAuditResult {
  table: string;
  sourceCount: number;
  destCount: number;
  /** Source IDs in skipSourceIds — intentionally absent from dest; not flagged as missing. */
  knownExcluded: number;
  /** Source IDs missing from dest (excluding skipSourceIds) — need INSERT in sync. */
  missingInDest: string[];
  /** Dest IDs not present in source at all — may be seed/staging/React-only rows. */
  extraInDest: string[];
  /** IDs present in both databases but with ≥1 column value difference. */
  changedIds: string[];
  /** Maps each changed ID to the list of columns that differ. */
  changedColumns: Record<string, string[]>;
  /** Source rows in missingInDest where created_at > MIGRATION_DATE. */
  postMigrationNewIds: string[];
  needsInsert: number;
  needsUpdate: number;
  noAction: number;
  fkWarnings: string[];
  notes: string[];
  error?: string;
}

// ── 6. Helpers ────────────────────────────────────────────────────────────────

async function fetchAll<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  columns: string[],
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(columns.join(','))
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * Canonical string representation for stable comparison of any value.
 * Handles null, primitives, arrays, and objects (JSON) with sorted keys.
 * PostgreSQL jsonb columns return as parsed JS objects — this normalises them.
 */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return '\x00null';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) {
    return '[' + (v as unknown[]).map(canonical).join(',') + ']';
  }
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => `${k}:${canonical(obj[k])}`).join(',') + '}';
}

// ── 7. Per-table audit ────────────────────────────────────────────────────────

async function auditTable(
  src: SupabaseClient,
  dst: SupabaseClient,
  def: AuditTableDef,
  dstParentIdSets: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<TableAuditResult> {
  process.stdout.write(`  auditing ${def.name}... `);

  const srcRows = await fetchAll<Record<string, unknown>>(src, def.name, def.srcColumns);
  const dstRows = await fetchAll<Record<string, unknown>>(dst, def.name, def.cmpColumns);

  const srcById = new Map(srcRows.map(r => [r['id'] as string, r]));
  const dstById = new Map(dstRows.map(r => [r['id'] as string, r]));

  const srcIds = new Set(srcById.keys());
  const dstIds = new Set(dstById.keys());
  const skip   = def.skipSourceIds ?? new Set<string>();

  const knownExcludedIds  = [...srcIds].filter(id => skip.has(id));
  const missingInDest     = [...srcIds].filter(id => !dstIds.has(id) && !skip.has(id));
  const extraInDest       = [...dstIds].filter(id => !srcIds.has(id));
  const commonIds         = [...srcIds].filter(id => dstIds.has(id));

  // Value comparison for common rows
  const changedIds: string[] = [];
  const changedColumns: Record<string, string[]> = {};

  for (const id of commonIds) {
    const srcRow = srcById.get(id)!;
    const dstRow = dstById.get(id)!;
    const diffCols: string[] = [];

    for (const col of def.cmpColumns) {
      if (col === 'id') continue;

      let expectedSrcVal = srcRow[col];

      // If the migration remapped this column's value, treat the remap target
      // as the "expected source value" for comparison purposes.
      if (def.columnRemaps?.[col]) {
        const remapped = def.columnRemaps[col].get(expectedSrcVal as string);
        if (remapped !== undefined) expectedSrcVal = remapped;
      }

      if (canonical(expectedSrcVal) !== canonical(dstRow[col])) {
        diffCols.push(col);
      }
    }

    if (diffCols.length > 0) {
      changedIds.push(id);
      changedColumns[id] = diffCols;
    }
  }

  // Identify post-migration new rows: source rows missing from dest where created_at > MIGRATION_DATE
  const postMigrationNewIds: string[] = [];
  if (def.hasCreatedAt) {
    for (const id of missingInDest) {
      const ts = srcById.get(id)?.['created_at'] as string | null | undefined;
      if (ts && ts > MIGRATION_DATE) postMigrationNewIds.push(id);
    }
  }

  // FK dependency check: for missing source rows, flag if their FK parent is also absent from dest
  const fkWarnings: string[] = [];
  for (const fk of def.fks) {
    const parentSet = dstParentIdSets.get(fk.parentTable);
    if (!parentSet || missingInDest.length === 0) continue;

    let orphanCount = 0;
    for (const id of missingInDest) {
      const fkVal = srcById.get(id)?.[fk.column] as string | null | undefined;
      if (fkVal && !parentSet.has(fkVal)) orphanCount++;
    }
    if (orphanCount > 0) {
      fkWarnings.push(`FK ${fk.column}→${fk.parentTable}: ${orphanCount} of ${missingInDest.length} missing rows have a parent not yet in dest — must insert ${fk.parentTable} first`);
    }
  }

  console.log(`src=${srcRows.length} dst=${dstRows.length} missing=${missingInDest.length} changed=${changedIds.length} extra=${extraInDest.length}`);

  return {
    table: def.name,
    sourceCount: srcRows.length,
    destCount: dstRows.length,
    knownExcluded: knownExcludedIds.length,
    missingInDest,
    extraInDest,
    changedIds,
    changedColumns,
    postMigrationNewIds,
    needsInsert: missingInDest.length,
    needsUpdate: changedIds.length,
    noAction: commonIds.length - changedIds.length,
    fkWarnings,
    notes: def.notes ?? [],
  };
}

// ── 8. Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(112);
  const line = '─'.repeat(112);

  console.log(`\n${LINE}`);
  console.log('  Phase 4.5 — Full Delta Sync Audit  (READ-ONLY)');
  console.log(LINE);
  console.log(`  Source (old JSR production)   : ${srcRef}`);
  console.log(`  Destination (JSR React staging): ${dstRef}`);
  console.log(`  Migration reference date      : ${MIGRATION_DATE.slice(0, 10)}`);
  console.log(`  Run at                        : ${new Date().toISOString()}\n`);

  const src = createClient(SRC_URL!, SRC_KEY!, { auth: { persistSession: false } });
  const dst = createClient(DST_URL!, DST_KEY!, { auth: { persistSession: false } });

  // Pre-fetch destination ID sets for FK dependency checks
  const parentTableNames = [...new Set(TABLES.flatMap(t => t.fks.map(fk => fk.parentTable)))];
  console.log(`  Pre-fetching dest ID sets for FK checks: ${parentTableNames.join(', ')}...`);
  const dstParentIdSets = new Map<string, Set<string>>();
  for (const pt of parentTableNames) {
    const rows = await fetchAll<{ id: string }>(dst, pt, ['id']);
    dstParentIdSets.set(pt, new Set(rows.map(r => r.id)));
  }
  console.log();

  // ── Audit all tables ─────────────────────────────────────────────────────────
  const results: TableAuditResult[] = [];
  for (const def of TABLES) {
    try {
      results.push(await auditTable(src, dst, def, dstParentIdSets));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR auditing ${def.name}: ${msg}`);
      results.push({
        table: def.name, sourceCount: -1, destCount: -1, knownExcluded: 0,
        missingInDest: [], extraInDest: [], changedIds: [], changedColumns: {},
        postMigrationNewIds: [], needsInsert: 0, needsUpdate: 0, noAction: 0,
        fkWarnings: [], notes: [], error: msg,
      });
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────────
  const c = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const r = (s: string, w: number) => s.slice(0, w).padStart(w);

  console.log(`\n${LINE}`);
  console.log('  DELTA SYNC AUDIT SUMMARY');
  console.log(LINE);
  console.log(
    c('Table', 22) + ' │ ' + r('Source', 7) + ' │ ' + r('Dest', 7) + ' │ ' +
    r('Excl', 5) + ' │ ' + r('Missing', 8) + ' │ ' + r('Changed', 8) + ' │ ' +
    r('Extra', 6) + ' │ Action',
  );
  console.log(line);

  let totalInsert = 0, totalUpdate = 0, totalExtra = 0;
  const tablesWithAction: string[] = [];

  for (const res of results) {
    if (res.error) {
      console.log(c(res.table, 22) + ' │ ' + r('ERROR', 7) + ' │ ' + r('—', 7) + ' │ ' + r('—', 5) + ' │ ' + r('—', 8) + ' │ ' + r('—', 8) + ' │ ' + r('—', 6) + ' │ ' + res.error.slice(0, 40));
      continue;
    }

    const actionParts = [
      res.needsInsert > 0 ? `+${res.needsInsert} INSERT` : '',
      res.needsUpdate > 0 ? `~${res.needsUpdate} UPDATE` : '',
    ].filter(Boolean);
    const action = actionParts.length > 0 ? actionParts.join(', ') : 'NO ACTION';

    console.log(
      c(res.table, 22) + ' │ ' +
      r(String(res.sourceCount), 7) + ' │ ' +
      r(String(res.destCount), 7) + ' │ ' +
      r(res.knownExcluded > 0 ? String(res.knownExcluded) : '—', 5) + ' │ ' +
      r(res.missingInDest.length > 0 ? String(res.missingInDest.length) : '—', 8) + ' │ ' +
      r(res.changedIds.length    > 0 ? String(res.changedIds.length)    : '—', 8) + ' │ ' +
      r(res.extraInDest.length   > 0 ? String(res.extraInDest.length)   : '—', 6) + ' │ ' + action,
    );

    totalInsert += res.needsInsert;
    totalUpdate += res.needsUpdate;
    totalExtra  += res.extraInDest.length;
    if (res.needsInsert > 0 || res.needsUpdate > 0) tablesWithAction.push(res.table);
  }

  console.log(line);
  console.log(`\n  Total rows needing INSERT : ${totalInsert}`);
  console.log(`  Total rows needing UPDATE : ${totalUpdate}`);
  console.log(`  Total extra in dest       : ${totalExtra} (informational — may include seed/staging-only rows)`);
  console.log(`  Tables requiring action   : ${tablesWithAction.length > 0 ? tablesWithAction.join(', ') : 'NONE'}`);

  // ── Proposed sync order ───────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  PROPOSED DEPENDENCY-SAFE SYNC ORDER');
  console.log(LINE);
  console.log('  Tier 0 (no FK deps):');
  console.log('    users, team_members, clients, sections, activity_log,');
  console.log('    general_expenses, daily_activities, revenue, project_expenses');
  console.log('  Tier 1 (FK → Tier 0 / users):');
  console.log('    employee_documents, expense_claims, salary_adjustments,');
  console.log('    push_subscriptions, invoices, rows');
  console.log('  Tier 2 (FK → Tier 1):');
  console.log('    invoice_items, invoice_payments');

  // ── Per-table detail (only tables with deltas) ────────────────────────────────
  const hasDelta = results.filter(r => r.needsInsert > 0 || r.needsUpdate > 0 || r.extraInDest.length > 0 || r.fkWarnings.length > 0 || r.error);
  if (hasDelta.length > 0) {
    console.log(`\n${LINE}`);
    console.log('  PER-TABLE DETAIL (tables with delta or warnings only)');
    console.log(LINE);

    for (const res of hasDelta) {
      console.log(`\n  ── ${res.table} ──`);

      if (res.error) {
        console.log(`  ERROR: ${res.error}`);
        continue;
      }

      if (res.missingInDest.length > 0) {
        const postMigSet = new Set(res.postMigrationNewIds);
        const printCount = Math.min(res.missingInDest.length, 25);
        console.log(`  MISSING IN DEST — need INSERT (${res.missingInDest.length} rows):`);
        for (let i = 0; i < printCount; i++) {
          const id = res.missingInDest[i];
          const postTag = postMigSet.has(id) ? ' ← post-migration new row' : '';
          const revTag  = res.table === 'revenue' && KNOWN_POST_MIGRATION_REVENUE_IDS.has(id) ? ' [phase4-05 known]' : '';
          console.log(`    ${id}${postTag}${revTag}`);
        }
        if (res.missingInDest.length > printCount) {
          console.log(`    … and ${res.missingInDest.length - printCount} more (see delta-sync-report.json)`);
        }
      }

      if (res.changedIds.length > 0) {
        const printCount = Math.min(res.changedIds.length, 25);
        console.log(`  CHANGED — need UPDATE (${res.changedIds.length} rows):`);
        for (let i = 0; i < printCount; i++) {
          const id = res.changedIds[i];
          const cols = (res.changedColumns[id] ?? []).join(', ');
          console.log(`    ${id}  [${cols}]`);
        }
        if (res.changedIds.length > printCount) {
          console.log(`    … and ${res.changedIds.length - printCount} more (see delta-sync-report.json)`);
        }
      }

      if (res.extraInDest.length > 0) {
        const printCount = Math.min(res.extraInDest.length, 10);
        console.log(`  EXTRA IN DEST — informational (${res.extraInDest.length} rows, not in source):`);
        for (let i = 0; i < printCount; i++) console.log(`    ${res.extraInDest[i]}`);
        if (res.extraInDest.length > printCount) console.log(`    … and ${res.extraInDest.length - printCount} more`);
      }

      if (res.fkWarnings.length > 0) {
        console.log('  FK DEPENDENCY WARNINGS:');
        res.fkWarnings.forEach(w => console.log(`    ⚠  ${w}`));
      }

      if (res.notes.length > 0) {
        res.notes.forEach(n => console.log(`  NOTE: ${n}`));
      }
    }
  }

  // ── Legacy table check ────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  LEGACY TABLES IN SOURCE (not migrated — used by React app? No → informational only)');
  console.log(LINE);
  for (const lt of ['expenses', 'expense_budgets', 'work_log']) {
    try {
      const { count, error } = await src.from(lt).select('id', { head: true, count: 'exact' });
      if (error) {
        console.log(`  ${lt.padEnd(20)}: ${error.message}`);
      } else {
        console.log(`  ${lt.padEnd(20)}: ${count ?? 0} rows in source — not used by React app, dest table not in scope`);
      }
    } catch {
      console.log(`  ${lt.padEnd(20)}: unreachable`);
    }
  }

  // ── Write JSON report ─────────────────────────────────────────────────────────
  const reportPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'delta-sync-report.json');

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      sourceProject: srcRef,
      destProject: dstRef,
      migrationDate: MIGRATION_DATE.slice(0, 10),
      script: 'phase4-06-audit-delta-sync.ts',
      note: 'Contains business row IDs. No passwords, no service-role keys.',
    },
    tables: Object.fromEntries(results.map(res => [res.table, {
      sourceCount:        res.sourceCount,
      destCount:          res.destCount,
      knownExcluded:      res.knownExcluded,
      needsInsert:        res.needsInsert,
      needsUpdate:        res.needsUpdate,
      noAction:           res.noAction,
      missingInDest:      res.missingInDest,
      extraInDest:        res.extraInDest,
      changedIds:         res.changedIds,
      changedColumns:     res.changedColumns,
      postMigrationNewIds: res.postMigrationNewIds,
      fkWarnings:         res.fkWarnings,
      error:              res.error ?? null,
    }])),
    totals: {
      totalNeedsInsert: totalInsert,
      totalNeedsUpdate: totalUpdate,
      totalExtraInDest: totalExtra,
      tablesRequiringAction: tablesWithAction,
    },
    proposedSyncOrder: {
      tier0: ['users', 'team_members', 'clients', 'sections', 'activity_log', 'general_expenses', 'daily_activities', 'revenue', 'project_expenses'],
      tier1: ['employee_documents', 'expense_claims', 'salary_adjustments', 'push_subscriptions', 'invoices', 'rows'],
      tier2: ['invoice_items', 'invoice_payments'],
    },
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log(`\n${LINE}`);
  console.log('  OUTPUTS');
  console.log(LINE);
  console.log(`  JSON report : ${reportPath}`);
  console.log('  The report contains business row IDs only — no passwords, no service-role keys.');
  console.log('  Add scripts/delta-sync-report.json to .gitignore before committing.');
  console.log(`\n${LINE}`);
  console.log('  AUDIT COMPLETE — READ-ONLY. No data was modified in either database.');
  console.log(`${LINE}\n`);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
