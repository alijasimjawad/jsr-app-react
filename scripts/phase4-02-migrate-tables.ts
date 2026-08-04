/**
 * Phase 4 — Step 2: migrate application data tables from old JSR → destination.
 *
 * RUN ONLY AFTER `scripts/phase4-01-migrate-auth-users.ts --execute` completes
 * with 0 failures. Source is strictly read-only — nothing is ever written back.
 *
 * TABLES MIGRATED (16 total, dependency-safe tier order):
 *
 *   Tier 0 — no FK dependencies on other migrated tables:
 *     team_members, clients, sections, activity_log, general_expenses,
 *     daily_activities, revenue, project_expenses
 *
 *   Tier 1 — FK dependencies on Tier 0 (or on users, migrated in Step 1):
 *     employee_documents, expense_claims, salary_adjustments,
 *     push_subscriptions, invoices, rows
 *
 *   Tier 2 — FK dependencies on Tier 1:
 *     invoice_items, invoice_payments
 *
 * TABLES NOT MIGRATED HERE (by design):
 *   users             — completed in Step 1
 *   expenses          — legacy table, superseded by project_expenses/expense_claims
 *   expense_budgets   — legacy table, not used by the React app
 *   work_log          — legacy table, no FK constraint in staging schema
 *   sites, app_settings, projects, saved_points,
 *   cars, field_trips, trip_participants, attendance — React-only / seed tables
 *
 * IDEMPOTENCY:
 *   Any row whose `id` already exists in the destination is skipped. Safe to
 *   re-run after Ctrl-C or a partial failure — already-inserted rows are
 *   detected per table and skipped automatically.
 *
 * SECTION DUPLICATE HANDLING (sections table only):
 *   The destination has UNIQUE(project_name, section_name) on `sections`. The
 *   source has 10 rows that collide with already-migrated rows because the source
 *   contains both soft-deleted and active versions of the same section name in the
 *   same project (no such constraint existed in the source). These 10 rows are
 *   explicitly excluded via `skipIds` — they will never be attempted again.
 *   Two of them (55f63cb0 and b393a48e) have dependent rows in the `rows` table;
 *   those rows are migrated with `section_id` remapped to the active winner in
 *   the destination via `columnRemaps` on the `rows` TableDef.
 *
 * DRY RUN vs EXECUTE:
 *   Default: dry run — reads source, validates schemas and FKs, prints the
 *   per-table plan (source rows / excluded / to-insert / already-present), writes
 *   nothing. Pass `--execute` to perform the actual inserts.
 *
 * PRE-WRITE VALIDATION (done upfront for all 16 tables before any writes):
 *   1. Source table is reachable and all expected columns exist.
 *   2. Destination table is reachable and all expected columns exist.
 *   Any schema mismatch → the whole script aborts immediately, nothing written.
 *
 *   Per-table, just before writing:
 *   3. All non-null FK values from source rows (after remapping) exist in the
 *      relevant parent table. In dry-run mode the check runs against SOURCE.
 *      In execute mode it runs against DESTINATION.
 *   FK risk detected → the whole script aborts immediately, nothing further written.
 *
 * Usage:
 *   npx tsx scripts/phase4-02-migrate-tables.ts             # dry run
 *   npx tsx scripts/phase4-02-migrate-tables.ts --execute   # writes
 *
 * Credentials loaded from .env.phase4.local at the repo root (same file used
 * by phase4-00 and phase4-01 — see those scripts for the expected format).
 * Values already set in the shell environment take precedence over the file.
 *
 * SCOPE — this script touches only the destination tables listed above.
 * It never modifies source data, never creates Auth users, and never enables
 * or modifies Row-Level Security on any table.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 0. Load .env.phase4.local (never overrides real env vars) ───────────────
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

// ── 1. Hardcoded protected refs (same pinning as phase4-00 / phase4-01) ──────
const OLD_JSR_PROJECT_REF = 'tltbkjvrhqsxdspdfeqk';
const TAC_PROJECT_REF     = 'gauejhgitzcqjvzalshf';

// ── 2. Env vars ───────────────────────────────────────────────────────────────
const SOURCE_SUPABASE_URL              = process.env.SOURCE_SUPABASE_URL;
const SOURCE_SUPABASE_SERVICE_ROLE_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_SUPABASE_URL                = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_SERVICE_ROLE_KEY   = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_SOURCE_PROJECT_REF      = process.env.EXPECTED_SOURCE_PROJECT_REF;
const EXPECTED_DEST_PROJECT_REF        = process.env.EXPECTED_DEST_PROJECT_REF;

// ── 3. CLI ────────────────────────────────────────────────────────────────────
const EXECUTE           = process.argv.includes('--execute');
const PAGE_SIZE         = 500;
const INSERT_BATCH_SIZE = 200;
const FK_CHUNK_SIZE     = 400;

// ── 4. Table definitions ──────────────────────────────────────────────────────
interface FKDef { column: string; parentTable: string; }

interface TableDef {
  name: string;
  columns: string[];
  fks: FKDef[];
  /** Source row IDs to always skip — never attempted in destination. */
  skipIds?: ReadonlySet<string>;
  /**
   * Per-column value remaps applied before insert.
   * Map<column, Map<sourceValue, destValue>>.
   * Applied after skipIds filtering, before FK validation and insert.
   */
  columnRemaps?: Readonly<Record<string, ReadonlyMap<string, string>>>;
}

// Column lists match REQUIRED_COLUMNS in phase4-00-preflight.ts exactly,
// except where noted. FKs list only enforced constraints from foreign_keys.csv.
const TIERS: readonly TableDef[][] = [
  // ── Tier 0: no FK dependencies on other migrated tables ─────────────────
  [
    {
      name: 'team_members',
      // `username` exists in destination staging schema but not in source —
      // omitted so the SELECT from source succeeds; destination column = null.
      columns: [
        'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at',
        'phone', 'notes', 'national_id', 'date_of_birth', 'address',
        'emergency_contact_name', 'emergency_contact_phone', 'start_date',
        'profile_photo_url', 'activated_at', 'deactivated_at',
      ],
      fks: [],
    },
    {
      name: 'clients',
      columns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
      fks: [],
    },
    {
      name: 'sections',
      columns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
      fks: [],
      // These 10 source IDs collide with the destination's UNIQUE(project_name,
      // section_name) constraint. The source has both soft-deleted and active
      // versions of the same section name within the same project — duplicates
      // the destination constraint was specifically designed to prevent going
      // forward. All 10 are excluded here; the 2 with dependent rows
      // (55f63cb0 → 467 rows, b393a48e → 4 rows) are handled via the
      // `columnRemaps` on the `rows` table below.
      skipIds: new Set([
        'adf1a0fe-935b-4024-99f6-06ff138777ac', // zain/tdd       active dup  0 rows
        '332fad28-cefd-4f40-9e74-65a226fce728', // nokia/ftk      active dup  0 rows
        '444023fd-c674-42c3-b02f-90661627c903', // huawei/tdd     active dup  0 rows
        'c3fba5bb-43ac-4d40-a59a-9274069b2238', // nokia/tdd      soft-del    0 rows
        'eba6b3fc-fd70-4096-9976-47ccea342e94', // nokia/addsec   soft-del    0 rows
        '55f63cb0-d58b-45c7-82c1-bb658573c912', // zain/ftk       soft-del  467 rows → remapped
        '381b8d13-c1d6-42a6-b069-5581702769a0', // zain/addsec    soft-del    0 rows
        'eed95201-a02e-441a-afac-999a0509242c', // huawei/ftk     soft-del    0 rows
        'd9f05b55-9de6-41c4-8acd-81654a29d0bc', // huawei/addsec  soft-del    0 rows
        'b393a48e-0bd4-422f-99d9-efce62ecaaa4', // ipt/tdd        active dup  4 rows → remapped
      ]),
    },
    {
      name: 'activity_log',
      columns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
      fks: [],
    },
    {
      name: 'general_expenses',
      columns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
      fks: [],
    },
    {
      name: 'daily_activities',
      columns: [
        'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
        'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
      ],
      fks: [],
    },
    {
      name: 'revenue',
      // Source has 12 columns; destination staging schema has only these 7.
      columns: ['id', 'project_name', 'site_id', 'amount', 'month', 'year', 'created_at'],
      fks: [],
    },
    {
      name: 'project_expenses',
      columns: [
        'id', 'project_name', 'description', 'category', 'amount', 'expense_date',
        'month', 'year', 'notes', 'added_by', 'created_at', 'activity_date',
        'site_id', 'employee_ids', 'accommodation', 'submitted_by', 'approved_by',
      ],
      fks: [],
    },
  ],
  // ── Tier 1: FK dependencies on Tier 0 (or users, already done in Step 1) ─
  [
    {
      name: 'employee_documents',
      columns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
      fks: [{ column: 'member_id', parentTable: 'team_members' }],
    },
    {
      name: 'expense_claims',
      columns: [
        'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
        'activity_date', 'transport_amount', 'food_amount', 'accommodation',
        'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
        'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
      ],
      fks: [{ column: 'member_id', parentTable: 'team_members' }],
    },
    {
      name: 'salary_adjustments',
      columns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
      fks: [{ column: 'member_id', parentTable: 'team_members' }],
    },
    {
      name: 'push_subscriptions',
      columns: ['id', 'user_id', 'subscription', 'created_at'],
      fks: [{ column: 'user_id', parentTable: 'users' }],
    },
    {
      name: 'invoices',
      columns: [
        'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
        'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
      ],
      fks: [{ column: 'client_id', parentTable: 'clients' }],
    },
    {
      name: 'rows',
      columns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
      fks: [{ column: 'section_id', parentTable: 'sections' }],
      // Remap section_id for rows referencing the two excluded (failed) sections.
      // Both remaps point to the active winner for the same (project, section_name) pair.
      //   55f63cb0 = zain/ftk (soft-deleted)  → e8ee675d = zain/ftk (active)   [467 rows]
      //   b393a48e = ipt/tdd  (active dup)     → 3d88c00c = ipt/tdd  (active)   [  4 rows]
      columnRemaps: {
        section_id: new Map([
          ['55f63cb0-d58b-45c7-82c1-bb658573c912', 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'],
          ['b393a48e-0bd4-422f-99d9-efce62ecaaa4', '3d88c00c-9309-40c5-96d8-04af7b514c31'],
        ]),
      },
    },
  ],
  // ── Tier 2: FK dependencies on Tier 1 ───────────────────────────────────
  [
    {
      name: 'invoice_items',
      columns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
      fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
    },
    {
      name: 'invoice_payments',
      columns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
      fks: [{ column: 'invoice_id', parentTable: 'invoices' }],
    },
  ],
];

// ── 5. Result type ────────────────────────────────────────────────────────────
interface TableResult {
  table: string;
  sourceRows: number;
  excluded: number;   // explicitly skipped via skipIds
  remapped: number;   // rows with at least one column value remapped
  toInsert: number;   // planned for insert (after exclusion + idempotency)
  inserted: number;
  skipped: number;    // already present in destination
  failed: number;
  errors: string[];
}

// ── 6. Helpers ────────────────────────────────────────────────────────────────
function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

async function fetchAllRows<T extends Record<string, unknown>>(
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
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchDestIds(client: SupabaseClient, table: string): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string }>(client, table, ['id']);
  return new Set(rows.map(r => r.id));
}

/** Applies columnRemaps to a single row, returning a new object. Source unchanged. */
function applyRemaps(
  row: Record<string, unknown>,
  columnRemaps: Readonly<Record<string, ReadonlyMap<string, string>>>,
): Record<string, unknown> {
  const out = { ...row };
  for (const [col, remap] of Object.entries(columnRemaps)) {
    const val = out[col];
    if (typeof val === 'string') {
      const mapped = remap.get(val);
      if (mapped !== undefined) out[col] = mapped;
    }
  }
  return out;
}

function pickColumns(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) out[col] = row[col] ?? null;
  return out;
}

async function validateSchema(
  client: SupabaseClient,
  table: string,
  columns: string[],
  label: string,
): Promise<void> {
  const { error } = await client
    .from(table)
    .select(columns.join(','), { head: true, count: 'exact' });
  if (!error) return;
  const msg  = error.message ?? String(error);
  const code = (error as { code?: string }).code;
  if (
    code === '42P01' ||
    /relation .* does not exist/i.test(msg) ||
    /could not find the table/i.test(msg)
  ) {
    throw new Error(`SCHEMA MISMATCH [${label}]: table "${table}" not found — ${msg}`);
  }
  throw new Error(`SCHEMA MISMATCH [${label}]: table "${table}" — ${msg}`);
}

async function validateFKs(
  checkClient: SupabaseClient,
  table: string,
  fks: FKDef[],
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const fk of fks) {
    const unique = [...new Set(
      rows
        .map(r => r[fk.column] as string | null | undefined)
        .filter((v): v is string => v != null && v !== ''),
    )];
    if (unique.length === 0) continue;

    const foundIds = new Set<string>();
    for (let i = 0; i < unique.length; i += FK_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + FK_CHUNK_SIZE);
      const { data, error } = await checkClient
        .from(fk.parentTable)
        .select('id')
        .in('id', chunk);
      if (error) throw new Error(`FK validation querying ${fk.parentTable}: ${error.message}`);
      for (const row of (data ?? []) as { id: string }[]) foundIds.add(row.id);
    }

    const missing = unique.filter(v => !foundIds.has(v));
    if (missing.length > 0) {
      throw new Error(
        `FK RISK: ${table}.${fk.column} → ${fk.parentTable}.id — ` +
        `${missing.length} value(s) not found in parent: ` +
        missing.slice(0, 5).join(', ') +
        (missing.length > 5 ? ` … (${missing.length - 5} more)` : ''),
      );
    }
  }
}

// ── 7. Per-table migration ────────────────────────────────────────────────────
async function migrateTable(
  source: SupabaseClient,
  dest: SupabaseClient,
  tableDef: TableDef,
): Promise<TableResult> {
  const { name: table, columns, fks, skipIds, columnRemaps } = tableDef;
  const result: TableResult = {
    table, sourceRows: 0, excluded: 0, remapped: 0,
    toInsert: 0, inserted: 0, skipped: 0, failed: 0, errors: [],
  };

  // a. Read all source rows.
  const sourceRows = await fetchAllRows<Record<string, unknown>>(source, table, columns);
  result.sourceRows = sourceRows.length;

  if (sourceRows.length === 0) {
    console.log(`  ${table}: 0 source rows — nothing to do.`);
    return result;
  }

  // b. Apply skipIds — remove rows that are explicitly excluded.
  const afterSkip = skipIds
    ? sourceRows.filter(r => !skipIds.has(r.id as string))
    : sourceRows;
  result.excluded = sourceRows.length - afterSkip.length;

  // c. Apply columnRemaps — rewrite column values before FK check and insert.
  //    Count how many rows have at least one value remapped (for reporting).
  let remappedRows: Record<string, unknown>[];
  if (columnRemaps) {
    remappedRows = afterSkip.map(r => applyRemaps(r, columnRemaps));
    for (let i = 0; i < afterSkip.length; i++) {
      for (const [col, remap] of Object.entries(columnRemaps)) {
        const v = afterSkip[i][col];
        if (typeof v === 'string' && remap.has(v)) { result.remapped++; break; }
      }
    }
  } else {
    remappedRows = afterSkip;
  }

  // d. FK validation.
  //    Dry run  → validate ORIGINAL source values against source parent
  //               (confirms source data is internally consistent pre-remap).
  //    Execute  → validate REMAPPED values against destination parent
  //               (confirms parent tier was fully migrated and remaps are valid).
  if (fks.length > 0) {
    await validateFKs(
      EXECUTE ? dest : source,
      table,
      fks,
      EXECUTE ? remappedRows : afterSkip,
    );
  }

  // e. Idempotency — fetch existing destination IDs and filter.
  const destIds  = await fetchDestIds(dest, table);
  const toInsert = remappedRows.filter(r => !destIds.has(r.id as string));
  result.skipped  = remappedRows.length - toInsert.length;
  result.toInsert = toInsert.length;

  const remapNote = result.remapped > 0 ? ` (${result.remapped} section_id remapped)` : '';
  const skipNote  = result.excluded > 0  ? `, ${result.excluded} excluded (dup constraint)` : '';
  console.log(
    `  ${table}: ${result.sourceRows} source rows` +
    `${skipNote}` +
    ` | ${result.toInsert} to insert${remapNote}` +
    ` | ${result.skipped} already present (skip)`,
  );

  if (!EXECUTE || toInsert.length === 0) return result;

  // f. Insert in batches. On batch failure, fall back to one-by-one.
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = toInsert
      .slice(i, i + INSERT_BATCH_SIZE)
      .map(r => pickColumns(r, columns));

    const { error } = await dest.from(table).insert(batch);
    if (!error) {
      result.inserted += batch.length;
      continue;
    }

    console.warn(
      `  ${table}: batch [${i}–${i + batch.length - 1}] failed ` +
      `(${error.message}) — retrying individually…`,
    );
    for (const row of batch) {
      const { error: rowErr } = await dest.from(table).insert(row);
      if (rowErr) {
        result.failed++;
        const msg = `id=${String(row.id)}: ${rowErr.message}`;
        result.errors.push(msg);
        console.error(`    FAIL  ${msg}`);
      } else {
        result.inserted++;
      }
    }
  }

  return result;
}

// ── 8. Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n── Phase 4 Step 2 — Table migration (${EXECUTE ? 'EXECUTE' : 'DRY RUN'}) ──\n`);

  // 8a. Env presence.
  const missing = (
    ['SOURCE_SUPABASE_URL', 'SOURCE_SUPABASE_SERVICE_ROLE_KEY',
     'DEST_SUPABASE_URL', 'DEST_SUPABASE_SERVICE_ROLE_KEY',
     'EXPECTED_SOURCE_PROJECT_REF', 'EXPECTED_DEST_PROJECT_REF'] as const
  ).filter(k => !process.env[k]);
  if (missing.length) {
    console.error('ERROR: missing required env vars:', missing.join(', '));
    process.exit(1);
  }

  // 8b. Identity guard.
  const sourceRef = extractProjectRef(SOURCE_SUPABASE_URL);
  const destRef   = extractProjectRef(DEST_SUPABASE_URL);
  const guardFailures: string[] = [];

  if (sourceRef !== OLD_JSR_PROJECT_REF)
    guardFailures.push(`SOURCE ref "${sourceRef ?? '(unresolved)'}" is not the known old-JSR ref (${OLD_JSR_PROJECT_REF})`);
  if (sourceRef !== EXPECTED_SOURCE_PROJECT_REF)
    guardFailures.push(`SOURCE ref "${sourceRef ?? '(unresolved)'}" does not match EXPECTED_SOURCE_PROJECT_REF`);
  if (destRef !== EXPECTED_DEST_PROJECT_REF)
    guardFailures.push(`DEST ref "${destRef ?? '(unresolved)'}" does not match EXPECTED_DEST_PROJECT_REF`);
  if (destRef === OLD_JSR_PROJECT_REF)
    guardFailures.push('DEST resolves to the live old-JSR project — refusing to write to it.');
  if (destRef === TAC_PROJECT_REF)
    guardFailures.push("DEST resolves to TAC's project — refusing to write to it.");
  if (sourceRef !== null && destRef !== null && sourceRef === destRef)
    guardFailures.push('SOURCE and DEST resolve to the same project.');

  if (guardFailures.length) {
    console.error('ERROR: identity guard failed:');
    guardFailures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log(`Source (read-only): ${sourceRef}`);
  console.log(`Destination:        ${destRef}\n`);

  const source = createClient(SOURCE_SUPABASE_URL!, SOURCE_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const dest = createClient(DEST_SUPABASE_URL!, DEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 8c. Upfront schema validation — any mismatch aborts before any data moves.
  console.log('Validating schemas (all 16 tables, source + destination)…');
  for (const tier of TIERS) {
    for (const tableDef of tier) {
      try {
        await validateSchema(source, tableDef.name, tableDef.columns, 'source');
        await validateSchema(dest,   tableDef.name, tableDef.columns, 'destination');
        console.log(`  [OK] ${tableDef.name}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  [FAIL] ${msg}`);
        console.error('\nSchema mismatch — stopping immediately. No data was written.');
        process.exit(1);
      }
    }
  }
  console.log('All schemas valid.\n');

  // 8d. Migrate tier by tier.
  const allResults: TableResult[] = [];
  let anyFailed = false;

  for (let tierIdx = 0; tierIdx < TIERS.length; tierIdx++) {
    console.log(`── Tier ${tierIdx} ─────────────────────────────────────────────────────`);
    for (const tableDef of TIERS[tierIdx]) {
      process.stdout.write(`\n${tableDef.name}…\n`);
      try {
        const result = await migrateTable(source, dest, tableDef);
        allResults.push(result);
        if (result.failed > 0) anyFailed = true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  ERROR: ${msg}`);
        if (msg.startsWith('SCHEMA MISMATCH') || msg.startsWith('FK RISK')) {
          console.error('Stopping immediately — no further tables will be processed.');
          process.exit(1);
        }
        allResults.push({ table: tableDef.name, sourceRows: 0, excluded: 0, remapped: 0, toInsert: 0, inserted: 0, skipped: 0, failed: 1, errors: [msg] });
        anyFailed = true;
      }
    }
    console.log('');
  }

  // 8e. Summary table.
  const C = { tbl: 24, src: 7, excl: 8, remap: 7, plan: 10, ins: 10, skip: 8, fail: 7 };
  const sep = `  ${'-'.repeat(C.tbl)} ${'-'.repeat(C.src)} ${'-'.repeat(C.excl)} ${'-'.repeat(C.remap)} ${'-'.repeat(C.plan)} ${'-'.repeat(C.ins)} ${'-'.repeat(C.skip)} ${'-'.repeat(C.fail)}`;

  console.log('\n── Summary ───────────────────────────────────────────────────────────────');
  console.log(
    `  ${'Table'.padEnd(C.tbl)} ` +
    `${'Source'.padStart(C.src)} ` +
    `${'Excluded'.padStart(C.excl)} ` +
    `${'Remapped'.padStart(C.remap)} ` +
    `${'ToInsert'.padStart(C.plan)} ` +
    `${'Inserted'.padStart(C.ins)} ` +
    `${'Skipped'.padStart(C.skip)} ` +
    `${'Failed'.padStart(C.fail)}`,
  );
  console.log(sep);

  let totSrc = 0, totExcl = 0, totRemap = 0, totPlan = 0, totIns = 0, totSkip = 0, totFail = 0;
  for (const r of allResults) {
    totSrc   += r.sourceRows;
    totExcl  += r.excluded;
    totRemap += r.remapped;
    totPlan  += r.toInsert;
    totIns   += r.inserted;
    totSkip  += r.skipped;
    totFail  += r.failed;
    console.log(
      `  ${r.table.padEnd(C.tbl)} ` +
      `${String(r.sourceRows).padStart(C.src)} ` +
      `${String(r.excluded  || '').padStart(C.excl)} ` +
      `${String(r.remapped  || '').padStart(C.remap)} ` +
      `${String(r.toInsert).padStart(C.plan)} ` +
      `${String(r.inserted).padStart(C.ins)} ` +
      `${String(r.skipped).padStart(C.skip)} ` +
      `${String(r.failed   || '').padStart(C.fail)}`,
    );
  }
  console.log(sep);
  console.log(
    `  ${'TOTAL'.padEnd(C.tbl)} ` +
    `${String(totSrc).padStart(C.src)} ` +
    `${String(totExcl  || '').padStart(C.excl)} ` +
    `${String(totRemap || '').padStart(C.remap)} ` +
    `${String(totPlan).padStart(C.plan)} ` +
    `${String(totIns).padStart(C.ins)} ` +
    `${String(totSkip).padStart(C.skip)} ` +
    `${String(totFail  || '').padStart(C.fail)}`,
  );
  console.log('─────────────────────────────────────────────────────────────────────────');

  if (!EXECUTE) {
    console.log('\nDRY RUN complete — no writes were made. Re-run with --execute to apply.');
    process.exit(0);
  }

  if (anyFailed) {
    console.log('\nMigration completed with failures. Re-run with --execute to resume.');
    process.exit(1);
  }

  console.log('\nMigration complete — all tables migrated successfully.');
  process.exit(0);
}

main().catch(e => {
  console.error('Migration script crashed unexpectedly:', e instanceof Error ? e.message : e);
  process.exit(1);
});
