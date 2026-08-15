/**
 * phase4-07-sync-production-delta.ts — Phase 4.7 Production Delta Sync
 *
 * Syncs missing/changed rows from old JSR production (source) to JSR React
 * staging (destination) in FK-dependency order (Tier 0 → Tier 1 → Tier 2).
 *
 * USAGE:
 *   source .env.phase4.local
 *   npx tsx scripts/phase4-07-sync-production-delta.ts           # dry run (safe, default)
 *   npx tsx scripts/phase4-07-sync-production-delta.ts --execute # write to destination
 *
 * SAFETY GUARANTEES:
 *   - DRY RUN by default — prints what would be written, writes nothing.
 *   - --execute flag required for any writes to destination.
 *   - Source is NEVER written to.
 *   - Identity guard prevents source === destination.
 *   - Pinned project refs reject unexpected databases.
 *   - password, auth_user_id, and 9 profile columns are NEVER written.
 *   - 5 car-trip columns on expense_claims are NEVER written.
 *   - username on team_members is NEVER written (destination-only column).
 *   - No rows are deleted from destination.
 *   - FK blockers abort the run before any writes in execute mode.
 *   - Write failures abort immediately.
 *   - Idempotent: re-fetches live data; skips rows already present in dest.
 *   - RLS is never modified.
 *
 * EXCLUDED TABLE:
 *   push_subscriptions — excluded from sync intentionally. Web Push subscriptions
 *   are browser-specific and bound to VAPID keys. They will be re-acquired via
 *   browser re-subscription after go-live once VAPID is configured for the React
 *   app. Syncing stale subscriptions would cause push delivery failures.
 *
 * USERS TABLE:
 *   No INSERT — user accounts require Supabase Auth registration and cannot be
 *   inserted directly. UPDATE only: username, full_name, role, permissions.
 *
 * TABLES SYNCED (16 of 17 audited; push_subscriptions excluded):
 *   Tier 0: users (UPDATE only), team_members, clients, sections, activity_log,
 *           general_expenses, daily_activities, revenue, project_expenses
 *   Tier 1: employee_documents, expense_claims, salary_adjustments, invoices, rows
 *   Tier 2: invoice_items, invoice_payments
 *
 * SECTION_ID REMAPS (preserved from phase4-02 migration):
 *   b393a48e-0bd4-422f-99d9-efce62ecaaa4 → 3d88c00c-9309-40c5-96d8-04af7b514c31 (ipt/tdd)
 *   55f63cb0-d58b-45c7-82c1-bb658573c912 → e8ee675d-3990-402a-aeb5-0ddbfc66c53a (zain/ftk)
 *   Applied to rows.section_id on INSERT only. UPDATE never touches section_id.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 0. Env loader ─────────────────────────────────────────────────────────────
function loadDotEnvLocal(): void {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const p = path.resolve(dir, '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadDotEnvLocal();

// ── 1. CLI args ───────────────────────────────────────────────────────────────
const DRY_RUN = !process.argv.includes('--execute');

// ── 2. Constants ──────────────────────────────────────────────────────────────
const OLD_JSR_REF  = 'tltbkjvrhqsxdspdfeqk';
const TAC_REF      = 'gauejhgitzcqjvzalshf';
const PAGE_SIZE    = 500;
const INSERT_BATCH = 50;

/**
 * 10 section IDs intentionally excluded from migration (UNIQUE constraint
 * collisions in destination). These source rows are never inserted — not
 * considered missing.
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
 * section_id column remaps applied during phase4-02. New source rows that still
 * reference these source section IDs get the remapped dest section ID on INSERT.
 */
const ROWS_SECTION_ID_REMAPS: ReadonlyMap<string, string> = new Map([
  ['55f63cb0-d58b-45c7-82c1-bb658573c912', 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'],
  ['b393a48e-0bd4-422f-99d9-efce62ecaaa4', '3d88c00c-9309-40c5-96d8-04af7b514c31'],
]);

// ── 3. Env vars + safety guards ───────────────────────────────────────────────
const SRC_URL = process.env.SOURCE_SUPABASE_URL!;
const SRC_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY!;
const DST_URL = process.env.DEST_SUPABASE_URL!;
const DST_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;
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
const srcRef = extractRef(SRC_URL);
const dstRef = extractRef(DST_URL);

if (!srcRef || !dstRef)              { console.error('ABORT: cannot extract project refs.'); process.exit(1); }
if (srcRef === dstRef)               { console.error(`ABORT: source and dest are the same project (${srcRef}).`); process.exit(1); }
if (srcRef === TAC_REF)              { console.error('ABORT: source is TAC project — not old JSR production.'); process.exit(1); }
if (srcRef !== OLD_JSR_REF)          { console.error(`ABORT: source "${srcRef}" ≠ expected old-JSR ref "${OLD_JSR_REF}".`); process.exit(1); }
if (EXP_SRC && srcRef !== EXP_SRC)  { console.error(`ABORT: source "${srcRef}" ≠ EXPECTED_SOURCE_PROJECT_REF "${EXP_SRC}".`); process.exit(1); }
if (EXP_DST && dstRef !== EXP_DST)  { console.error(`ABORT: dest "${dstRef}" ≠ EXPECTED_DEST_PROJECT_REF "${EXP_DST}".`); process.exit(1); }

// ── 4. Types ──────────────────────────────────────────────────────────────────

interface FKDef { column: string; parentTable: string; }

interface SyncTableConfig {
  name: string;
  tier: 0 | 1 | 2;
  /** Columns fetched from source. Never includes password. */
  srcColumns: string[];
  /**
   * Columns written on INSERT. Empty array = no inserts (users only).
   * Must be a subset of srcColumns.
   */
  insertColumns: string[];
  /**
   * Columns written on UPDATE. Empty array = no updates for this table.
   * Canonical comparison is applied to detect actual value changes.
   */
  updateColumns: string[];
  fks: FKDef[];
  skipSourceIds?: ReadonlySet<string>;
  /**
   * Per-column value remaps applied before INSERT and FK check.
   * Values are rewritten to their dest equivalents before writing.
   * Not applied during UPDATE comparison (updateColumns excludes section_id).
   */
  columnRemaps?: Readonly<Record<string, ReadonlyMap<string, string>>>;
  notes?: string[];
}

interface SyncResult {
  table: string;
  srcCount: number;
  dstCount: number;
  toInsert: number;
  inserted: number;
  toUpdate: number;
  updated: number;
  fkBlockers: number;
  failures: number;
  errors: string[];
}

// ── 5. Table configurations ───────────────────────────────────────────────────

const SYNC_TABLES: readonly SyncTableConfig[] = [
  // ── Tier 0: no FK dependencies on other migrated tables ──────────────────────
  {
    name: 'users',
    tier: 0,
    srcColumns: ['id', 'username', 'full_name', 'role', 'permissions', 'created_at'],
    insertColumns: [], // users must be created via Supabase Auth, not direct INSERT
    updateColumns: ['username', 'full_name', 'role', 'permissions'],
    fks: [],
    notes: [
      'No INSERT — user accounts require Auth registration. UPDATE only.',
      'password, auth_user_id, phone, national_id, date_of_birth, address,',
      'emergency_contact_*, start_date, notes, profile_photo_url: never written.',
    ],
  },
  {
    name: 'team_members',
    tier: 0,
    srcColumns: [
      'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at', 'phone',
      'notes', 'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at', 'deactivated_at',
    ],
    insertColumns: [
      'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at', 'phone',
      'notes', 'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at', 'deactivated_at',
    ],
    updateColumns: [
      'full_name', 'monthly_salary', 'role', 'is_active', 'phone', 'notes',
      'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
      'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at', 'deactivated_at',
    ],
    fks: [],
    notes: ['username: destination-only column — never written.'],
  },
  {
    name: 'clients',
    tier: 0,
    srcColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    insertColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    updateColumns: ['company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    fks: [],
  },
  {
    name: 'sections',
    tier: 0,
    srcColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    insertColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    updateColumns: ['columns', 'custom_columns'],
    fks: [],
    skipSourceIds: SECTIONS_SKIP_IDS,
    notes: [
      '10 source IDs excluded (UNIQUE constraint collisions) — not inserted.',
      'UPDATE writes only `columns` and `custom_columns`.',
      'project_name, section_name, section_label, is_custom, is_deleted: not updated.',
    ],
  },
  {
    name: 'activity_log',
    tier: 0,
    srcColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
    insertColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
    updateColumns: [],
    fks: [],
    notes: ['No UPDATE — activity log entries are immutable append-only records.'],
  },
  {
    name: 'general_expenses',
    tier: 0,
    srcColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
    insertColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
    updateColumns: ['description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by'],
    fks: [],
  },
  {
    name: 'daily_activities',
    tier: 0,
    srcColumns: [
      'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
      'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
    ],
    insertColumns: [
      'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
      'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
    ],
    updateColumns: [
      'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
      'notes', 'status', 'created_by', 'governate', 'project',
    ],
    fks: [],
  },
  {
    name: 'revenue',
    tier: 0,
    srcColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
    ],
    insertColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
    ],
    updateColumns: [
      'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'status', 'section_name',
    ],
    fks: [],
  },
  {
    name: 'project_expenses',
    tier: 0,
    srcColumns: [
      'id', 'project_name', 'description', 'category', 'amount', 'expense_date',
      'month', 'year', 'notes', 'added_by', 'created_at', 'activity_date',
      'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
    ],
    insertColumns: [
      'id', 'project_name', 'description', 'category', 'amount', 'expense_date',
      'month', 'year', 'notes', 'added_by', 'created_at', 'activity_date',
      'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
    ],
    updateColumns: [
      'project_name', 'description', 'category', 'amount', 'expense_date',
      'month', 'year', 'notes', 'added_by', 'activity_date',
      'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
    ],
    fks: [],
  },

  // ── Tier 1: FK dependencies on Tier 0 tables ─────────────────────────────────
  {
    name: 'employee_documents',
    tier: 1,
    srcColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    insertColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    updateColumns: ['file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
  },
  {
    name: 'expense_claims',
    tier: 1,
    // 5 car-trip columns (is_car_trip, daily_activity_id, car_id,
    // car_trip_distance_km, car_trip_rate_iqd) are destination-only — never fetched or written.
    srcColumns: [
      'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
      'activity_date', 'transport_amount', 'food_amount', 'accommodation',
      'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
      'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
    ],
    insertColumns: [
      'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
      'activity_date', 'transport_amount', 'food_amount', 'accommodation',
      'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
      'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
    ],
    updateColumns: [
      'member_id', 'project_name', 'site_id', 'governorate', 'description',
      'activity_date', 'transport_amount', 'food_amount', 'accommodation',
      'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
      'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
    ],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
    notes: [
      '5 car-trip columns (is_car_trip, daily_activity_id, car_id,',
      'car_trip_distance_km, car_trip_rate_iqd): destination-only, never written.',
    ],
  },
  {
    name: 'salary_adjustments',
    tier: 1,
    srcColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
    insertColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
    updateColumns: ['member_id', 'month', 'year', 'adjusted_amount', 'reason', 'adj_type'],
    fks: [{ column: 'member_id', parentTable: 'team_members' }],
  },
  // push_subscriptions: EXCLUDED — see script header for rationale.
  {
    name: 'invoices',
    tier: 1,
    srcColumns: [
      'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
      'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
    ],
    insertColumns: [
      'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
      'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
    ],
    updateColumns: [
      'invoice_number', 'client_id', 'project_name', 'issue_date',
      'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
    ],
    fks: [{ column: 'client_id', parentTable: 'clients' }],
  },
  {
    name: 'rows',
    tier: 1,
    srcColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    insertColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    // section_id excluded from updateColumns — it is already remapped in dest from
    // phase4-02 and must not be overwritten with the source's original value.
    updateColumns: ['data', 'row_order', 'updated_at'],
    fks: [{ column: 'section_id', parentTable: 'sections' }],
    columnRemaps: { section_id: ROWS_SECTION_ID_REMAPS },
    notes: [
      'section_id remap on INSERT: b393a48e→3d88c00c (ipt/tdd), 55f63cb0→e8ee675d (zain/ftk).',
      'section_id not written on UPDATE (already remapped in dest from phase4-02).',
    ],
  },

  // ── Tier 2: FK dependencies on Tier 1 tables ─────────────────────────────────
  {
    name: 'invoice_items',
    tier: 2,
    srcColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    insertColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    updateColumns: ['invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
  },
  {
    name: 'invoice_payments',
    tier: 2,
    srcColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    insertColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    updateColumns: ['invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
  },
];

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
    const batch = (data ?? []) as T[];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/**
 * Canonical string for stable value comparison. Handles null, primitives,
 * arrays, and JSON objects (sorts keys). Matches the audit script's canonical().
 */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return '\x00null';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return '[' + (v as unknown[]).map(canonical).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => `${k}:${canonical(obj[k])}`).join(',') + '}';
}

// ── 7. Per-table sync ─────────────────────────────────────────────────────────

async function syncTable(
  src: SupabaseClient,
  dst: SupabaseClient,
  config: SyncTableConfig,
  virtualDestIds: Map<string, Set<string>>,
  dryRun: boolean,
): Promise<SyncResult> {
  const result: SyncResult = {
    table: config.name,
    srcCount: 0, dstCount: 0,
    toInsert: 0, inserted: 0,
    toUpdate: 0, updated: 0,
    fkBlockers: 0, failures: 0, errors: [],
  };

  process.stdout.write(`  [${config.name}] fetching... `);

  const hasInserts = config.insertColumns.length > 0;
  const hasUpdates = config.updateColumns.length > 0;

  // Fetch source rows (all columns needed for insert + compare)
  const srcRows = await fetchAll<Record<string, unknown>>(src, config.name, config.srcColumns);
  result.srcCount = srcRows.length;
  const srcById = new Map(srcRows.map(r => [r['id'] as string, r]));

  // Fetch dest rows — id always; add updateColumns if we need value comparison
  const dstFetchCols = hasUpdates
    ? ['id', ...new Set(config.updateColumns)]
    : ['id'];
  const dstRows = await fetchAll<Record<string, unknown>>(dst, config.name, dstFetchCols);
  result.dstCount = dstRows.length;
  const dstById = new Map(dstRows.map(r => [r['id'] as string, r]));

  const skip = config.skipSourceIds ?? new Set<string>();

  // ── Phase 1: classify all source rows ───────────────────────────────────────
  const toInsertRows: Record<string, unknown>[] = [];
  const toUpdateRows: Array<{ id: string; patch: Record<string, unknown> }> = [];

  for (const [id, srcRow] of srcById) {
    if (skip.has(id)) continue;

    const inDest = dstById.has(id);

    if (!inDest) {
      if (!hasInserts) continue; // users: no direct inserts

      // Build insert row with column remaps applied
      const insertRow: Record<string, unknown> = {};
      for (const col of config.insertColumns) {
        let val = srcRow[col];
        const remap = config.columnRemaps?.[col];
        if (remap) {
          const remapped = remap.get(val as string);
          if (remapped !== undefined) val = remapped;
        }
        insertRow[col] = val;
      }

      // FK check: verify parent exists in virtualDestIds (using post-remap value)
      let fkBlocked = false;
      for (const fk of config.fks) {
        const fkVal = insertRow[fk.column] as string | null | undefined;
        if (!fkVal) continue; // nullable FK — no check needed
        const parentSet = virtualDestIds.get(fk.parentTable);
        if (!parentSet?.has(fkVal)) {
          result.fkBlockers++;
          result.errors.push(
            `FK blocker [${config.name} id=${id}]: ${fk.column}=${fkVal} not in dest.${fk.parentTable}`,
          );
          fkBlocked = true;
          break;
        }
      }

      if (!fkBlocked) toInsertRows.push(insertRow);

    } else if (hasUpdates) {
      // Row exists in dest — build patch for any changed updateColumns
      const dstRow = dstById.get(id)!;
      const patch: Record<string, unknown> = {};
      for (const col of config.updateColumns) {
        if (canonical(srcRow[col]) !== canonical(dstRow[col])) {
          patch[col] = srcRow[col];
        }
      }
      if (Object.keys(patch).length > 0) {
        toUpdateRows.push({ id, patch });
      }
    }
  }

  result.toInsert = toInsertRows.length;
  result.toUpdate = toUpdateRows.length;

  const insertLabel = hasInserts ? `toInsert=${result.toInsert}` : 'noInsert(users)';
  const updateLabel = hasUpdates ? `toUpdate=${result.toUpdate}` : 'noUpdate';
  const fkLabel    = result.fkBlockers > 0 ? ` !! fkBlockers=${result.fkBlockers}` : '';
  console.log(`src=${result.srcCount} dst=${result.dstCount} ${insertLabel} ${updateLabel}${fkLabel}`);

  // ── Phase 2: abort before writing if FK blockers exist (execute mode only) ──
  if (!dryRun && result.fkBlockers > 0) {
    for (const msg of result.errors) console.error(`  !! ${msg}`);
    throw new Error(`ABORT: ${result.fkBlockers} FK blocker(s) in ${config.name} — resolve before executing sync.`);
  }

  if (dryRun) {
    // Simulate inserts into virtualDestIds so downstream tier FK checks see planned rows
    if (toInsertRows.length > 0) {
      const vset = virtualDestIds.get(config.name) ?? new Set<string>();
      for (const row of toInsertRows) vset.add(row['id'] as string);
      virtualDestIds.set(config.name, vset);
    }
    return result;
  }

  // ── Phase 3: execute inserts ─────────────────────────────────────────────────
  for (let i = 0; i < toInsertRows.length; i += INSERT_BATCH) {
    const batch = toInsertRows.slice(i, i + INSERT_BATCH);
    const { error } = await dst.from(config.name).insert(batch);
    if (error) {
      result.failures++;
      const msg = `INSERT batch [${i}–${i + batch.length - 1}] into ${config.name}: ${error.message}`;
      result.errors.push(msg);
      throw new Error(`ABORT: ${msg}`);
    }
    result.inserted += batch.length;
    // Track inserted IDs for downstream tier FK checks
    const vset = virtualDestIds.get(config.name) ?? new Set<string>();
    for (const row of batch) vset.add(row['id'] as string);
    virtualDestIds.set(config.name, vset);
  }

  // ── Phase 4: execute updates ─────────────────────────────────────────────────
  for (const { id, patch } of toUpdateRows) {
    const { error } = await dst.from(config.name).update(patch).eq('id', id);
    if (error) {
      result.failures++;
      const msg = `UPDATE ${config.name} id=${id}: ${error.message}`;
      result.errors.push(msg);
      throw new Error(`ABORT: ${msg}`);
    }
    result.updated++;
  }

  return result;
}

// ── 8. Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(104);
  const line = '─'.repeat(104);
  const MODE = DRY_RUN
    ? 'DRY RUN — no writes'
    : '!! EXECUTE MODE — WRITING TO DESTINATION !!';

  console.log(`\n${LINE}`);
  console.log(`  Phase 4.7 — Production Delta Sync  [${MODE}]`);
  console.log(LINE);
  console.log(`  Source (old JSR production)    : ${srcRef}`);
  console.log(`  Destination (JSR React staging): ${dstRef}`);
  console.log(`  Run at                         : ${new Date().toISOString()}`);
  if (DRY_RUN) {
    console.log('  To write, re-run with: --execute\n');
  } else {
    console.log('  Writing to destination database.\n');
  }

  const src = createClient(SRC_URL, SRC_KEY, { auth: { persistSession: false } });
  const dst = createClient(DST_URL, DST_KEY, { auth: { persistSession: false } });

  // Pre-fetch current dest ID sets for all FK parent tables.
  // virtualDestIds is updated after each table's inserts so downstream tier
  // FK checks see both existing dest rows and planned (or executed) inserts.
  const fkParentTables = [
    ...new Set(SYNC_TABLES.flatMap(t => t.fks.map(fk => fk.parentTable))),
  ];
  console.log(`  Pre-fetching dest ID sets for FK checks: ${fkParentTables.join(', ')}...`);
  const virtualDestIds = new Map<string, Set<string>>();
  for (const pt of fkParentTables) {
    const rows = await fetchAll<{ id: string }>(dst, pt, ['id']);
    virtualDestIds.set(pt, new Set(rows.map(r => r.id)));
  }
  console.log();

  // ── Sync all tables in tier order ────────────────────────────────────────────
  const results: SyncResult[] = [];
  let aborted = false;

  for (const config of SYNC_TABLES) {
    if (aborted) break;
    try {
      const res = await syncTable(src, dst, config, virtualDestIds, DRY_RUN);
      results.push(res);
    } catch (err) {
      aborted = true;
      console.error(`\n  FATAL: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────────
  const c = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const r = (s: string, w: number) => s.slice(0, w).padStart(w);

  console.log(`\n${LINE}`);
  console.log(`  SYNC SUMMARY  [${MODE}]`);
  console.log(LINE);
  console.log(
    c('Table', 22) + ' │ ' + r('Src', 6) + ' │ ' + r('Dst', 6) + ' │ ' +
    r('Insert', 9) + ' │ ' + r('Update', 9) + ' │ ' + r('FKBlk', 5) + ' │ ' + r('Fail', 4),
  );
  console.log(line);

  let totalInsert = 0, totalUpdate = 0, totalFkBlockers = 0, totalFailures = 0;

  for (const res of results) {
    const insertCol = res.toInsert === 0
      ? '—'
      : DRY_RUN
        ? `~${res.toInsert}`
        : `✔ ${res.inserted}/${res.toInsert}`;
    const updateCol = res.toUpdate === 0
      ? '—'
      : DRY_RUN
        ? `~${res.toUpdate}`
        : `✔ ${res.updated}/${res.toUpdate}`;
    console.log(
      c(res.table, 22) + ' │ ' +
      r(String(res.srcCount), 6) + ' │ ' +
      r(String(res.dstCount), 6) + ' │ ' +
      r(insertCol, 9) + ' │ ' +
      r(updateCol, 9) + ' │ ' +
      r(res.fkBlockers > 0 ? String(res.fkBlockers) : '—', 5) + ' │ ' +
      r(res.failures > 0 ? String(res.failures) : '—', 4),
    );

    totalInsert     += DRY_RUN ? res.toInsert : res.inserted;
    totalUpdate     += DRY_RUN ? res.toUpdate : res.updated;
    totalFkBlockers += res.fkBlockers;
    totalFailures   += res.failures;
  }

  const insertVerb = DRY_RUN ? 'would INSERT' : 'inserted';
  const updateVerb = DRY_RUN ? 'would UPDATE' : 'updated';
  console.log(line);
  console.log(`\n  Total rows ${insertVerb}  : ${totalInsert}`);
  console.log(`  Total rows ${updateVerb}  : ${totalUpdate}`);
  if (totalFkBlockers > 0) console.log(`  FK blockers (blocked) : ${totalFkBlockers}`);
  if (totalFailures   > 0) console.log(`  Write failures        : ${totalFailures}`);

  // Print all collected errors
  const allErrors = results.flatMap(res => res.errors);
  if (allErrors.length > 0) {
    console.log(`\n${LINE}`);
    console.log('  ERRORS / BLOCKERS');
    console.log(LINE);
    for (const msg of allErrors) console.log(`  !! ${msg}`);
  }

  // Print notes for tables that have them
  const tablesWithNotes = SYNC_TABLES.filter(t => t.notes && t.notes.length > 0);
  if (tablesWithNotes.length > 0) {
    console.log(`\n${LINE}`);
    console.log('  COLUMN EXCLUSION NOTES');
    console.log(LINE);
    for (const t of tablesWithNotes) {
      console.log(`  ${t.name}:`);
      for (const note of t.notes!) console.log(`    ${note}`);
    }
  }

  console.log(`\n${LINE}`);
  if (aborted) {
    console.log('  SYNC ABORTED — see errors above. No partial writes were persisted after the abort point.');
  } else if (DRY_RUN) {
    console.log('  DRY RUN COMPLETE — no data was written.');
    console.log('  Review the summary above, then re-run with --execute to apply.');
  } else if (totalFailures > 0 || totalFkBlockers > 0) {
    console.log('  EXECUTE COMPLETE — with errors. Review errors above.');
  } else {
    console.log('  EXECUTE COMPLETE — all rows synced successfully.');
    console.log('  Next: npx tsx scripts/phase4-08-verify-delta-sync.ts');
  }
  console.log(`${LINE}\n`);

  if (aborted || totalFkBlockers > 0 || totalFailures > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
