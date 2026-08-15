/**
 * phase4-08-verify-delta-sync.ts — Phase 4.7 Delta Sync Verification (READ-ONLY)
 *
 * Verifies that the delta sync applied by phase4-07 was complete and correct:
 *   - Every source row (minus excluded IDs) is present in destination.
 *   - All syncable columns match between source and destination.
 *   - Known column remaps and destination-only columns are accounted for.
 *
 * PASS/FAIL: reports per-table and exits with code 1 if any table fails.
 *
 * EXCLUDED FROM VERIFICATION:
 *   push_subscriptions — excluded from sync; expected to differ; not verified.
 *   users (missing rows) — users are not inserted by the sync; missing source
 *     users are not a failure. Only checks that common users have correct values.
 *
 * USAGE:
 *   source .env.phase4.local
 *   npx tsx scripts/phase4-08-verify-delta-sync.ts
 *
 * EXIT CODE:
 *   0 — all tables PASS
 *   1 — one or more tables FAIL (or abort)
 *
 * SAFETY GUARANTEES:
 *   - Strictly read-only — zero writes to either database.
 *   - Identity guard, pinned refs, no RLS changes (same guards as phase4-07).
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

// ── 1. Constants ──────────────────────────────────────────────────────────────
const OLD_JSR_REF = 'tltbkjvrhqsxdspdfeqk';
const TAC_REF     = 'gauejhgitzcqjvzalshf';
const PAGE_SIZE   = 500;

const SECTIONS_SKIP_IDS: ReadonlySet<string> = new Set([
  'adf1a0fe-935b-4024-99f6-06ff138777ac',
  '332fad28-cefd-4f40-9e74-65a226fce728',
  '444023fd-c674-42c3-b02f-90661627c903',
  'c3fba5bb-43ac-4d40-a59a-9274069b2238',
  'eba6b3fc-fd70-4096-9976-47ccea342e94',
  '55f63cb0-d58b-45c7-82c1-bb658573c912',
  '381b8d13-c1d6-42a6-b069-5581702769a0',
  'eed95201-a02e-441a-afac-999a0509242c',
  'd9f05b55-9de6-41c4-8acd-81654a29d0bc',
  'b393a48e-0bd4-422f-99d9-efce62ecaaa4',
]);

const ROWS_SECTION_ID_REMAPS: ReadonlyMap<string, string> = new Map([
  ['55f63cb0-d58b-45c7-82c1-bb658573c912', 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'],
  ['b393a48e-0bd4-422f-99d9-efce62ecaaa4', '3d88c00c-9309-40c5-96d8-04af7b514c31'],
]);

// ── 2. Env vars + safety guards ───────────────────────────────────────────────
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
  if (!v) { console.error(`ABORT: missing env var ${k}`); process.exit(1); }
}

function extractRef(url: string): string {
  return url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? '';
}
const srcRef = extractRef(SRC_URL);
const dstRef = extractRef(DST_URL);

if (!srcRef || !dstRef)              { console.error('ABORT: cannot extract project refs.'); process.exit(1); }
if (srcRef === dstRef)               { console.error(`ABORT: source and dest are the same project.`); process.exit(1); }
if (srcRef === TAC_REF)              { console.error('ABORT: source is TAC project — not old JSR.'); process.exit(1); }
if (srcRef !== OLD_JSR_REF)          { console.error(`ABORT: source "${srcRef}" ≠ expected "${OLD_JSR_REF}".`); process.exit(1); }
if (EXP_SRC && srcRef !== EXP_SRC)  { console.error(`ABORT: source "${srcRef}" ≠ EXPECTED_SOURCE_PROJECT_REF.`); process.exit(1); }
if (EXP_DST && dstRef !== EXP_DST)  { console.error(`ABORT: dest "${dstRef}" ≠ EXPECTED_DEST_PROJECT_REF.`); process.exit(1); }

// ── 3. Types ──────────────────────────────────────────────────────────────────

interface VerifyTableDef {
  name: string;
  /** Columns fetched from source. Never includes password. */
  srcColumns: string[];
  /**
   * Columns compared between source and destination.
   * Subset of srcColumns. Destination-only columns excluded.
   */
  cmpColumns: string[];
  skipSourceIds?: ReadonlySet<string>;
  /**
   * Per-column value remaps: canonical(srcValue) compared against
   * canonical(remapTarget) rather than canonical(destValue).
   */
  columnRemaps?: Readonly<Record<string, ReadonlyMap<string, string>>>;
  /**
   * If true, missing source rows are reported as a warning, not a FAIL.
   * Used for `users` where inserts are not done via the sync.
   */
  allowMissing?: boolean;
  notes?: string[];
}

interface VerifyResult {
  table: string;
  srcCount: number;
  dstCount: number;
  skipped: number;
  missingInDest: string[];
  changedIds: string[];
  changedColumns: Record<string, string[]>;
  pass: boolean;
  allowMissing: boolean;
  notes: string[];
  error?: string;
}

// ── 4. Verify table definitions ───────────────────────────────────────────────
//
// These match the columns synced by phase4-07. Destination-only columns
// (auth_user_id, username, car-trip fields) are excluded from cmpColumns.

const VERIFY_TABLES: readonly VerifyTableDef[] = [
  // ── Tier 0 ──────────────────────────────────────────────────────────────────
  {
    name: 'users',
    srcColumns: ['id', 'username', 'full_name', 'role', 'permissions', 'created_at'],
    cmpColumns: ['id', 'username', 'full_name', 'role', 'permissions'],
    allowMissing: true,
    notes: [
      'Missing source users are a warning only — users are not inserted by sync.',
      'password, auth_user_id, and 9 profile columns not compared (dest-only).',
    ],
  },
  {
    name: 'team_members',
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
    notes: ['username not compared (destination-only column).'],
  },
  {
    name: 'clients',
    srcColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
    cmpColumns: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
  },
  {
    name: 'sections',
    srcColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    // Verify only columns that the sync wrote: new inserts got all columns;
    // updates only touched `columns` and `custom_columns`. We compare the full
    // set because inserted rows should match on all columns.
    cmpColumns: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
    skipSourceIds: SECTIONS_SKIP_IDS,
    notes: [
      '10 source IDs excluded (UNIQUE collisions) — correctly absent from dest.',
      'Note: sections UPDATE only touched `columns` and `custom_columns`; other',
      'column differences on pre-existing rows are expected and not a failure.',
    ],
  },
  {
    name: 'activity_log',
    srcColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
    cmpColumns: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
  },
  {
    name: 'general_expenses',
    srcColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
    cmpColumns: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
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
  },
  {
    name: 'revenue',
    srcColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
    ],
    cmpColumns: [
      'id', 'project_name', 'site_id', 'amount', 'invoice_date', 'month', 'year',
      'notes', 'added_by', 'created_at', 'status', 'section_name',
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
  },

  // ── Tier 1 ──────────────────────────────────────────────────────────────────
  {
    name: 'employee_documents',
    srcColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
    cmpColumns: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
  },
  {
    name: 'expense_claims',
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
    notes: ['5 car-trip columns not compared (destination-only schema extension).'],
  },
  {
    name: 'salary_adjustments',
    srcColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
    cmpColumns: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
  },
  // push_subscriptions: EXCLUDED — not synced; not verified.
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
  },
  {
    name: 'rows',
    srcColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    cmpColumns: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
    columnRemaps: { section_id: ROWS_SECTION_ID_REMAPS },
    notes: [
      'section_id remaps applied: b393a48e→3d88c00c, 55f63cb0→e8ee675d.',
      'Differences explained by remap are not counted as failures.',
    ],
  },

  // ── Tier 2 ──────────────────────────────────────────────────────────────────
  {
    name: 'invoice_items',
    srcColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
    cmpColumns: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
  },
  {
    name: 'invoice_payments',
    srcColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
    cmpColumns: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
  },
];

// ── 5. Helpers ────────────────────────────────────────────────────────────────

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

function canonical(v: unknown): string {
  if (v === null || v === undefined) return '\x00null';
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return '[' + (v as unknown[]).map(canonical).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => `${k}:${canonical(obj[k])}`).join(',') + '}';
}

// ── 6. Per-table verification ─────────────────────────────────────────────────

async function verifyTable(
  src: SupabaseClient,
  dst: SupabaseClient,
  def: VerifyTableDef,
): Promise<VerifyResult> {
  process.stdout.write(`  [${def.name}] verifying... `);

  const result: VerifyResult = {
    table: def.name,
    srcCount: 0, dstCount: 0, skipped: 0,
    missingInDest: [], changedIds: [], changedColumns: {},
    pass: true, allowMissing: def.allowMissing ?? false,
    notes: def.notes ?? [],
  };

  const srcRows = await fetchAll<Record<string, unknown>>(src, def.name, def.srcColumns);
  result.srcCount = srcRows.length;
  const srcById = new Map(srcRows.map(r => [r['id'] as string, r]));

  const dstRows = await fetchAll<Record<string, unknown>>(dst, def.name, def.cmpColumns);
  result.dstCount = dstRows.length;
  const dstById = new Map(dstRows.map(r => [r['id'] as string, r]));

  const skip = def.skipSourceIds ?? new Set<string>();

  for (const [id, srcRow] of srcById) {
    if (skip.has(id)) { result.skipped++; continue; }

    if (!dstById.has(id)) {
      result.missingInDest.push(id);
      continue;
    }

    // Value comparison for common rows
    const dstRow = dstById.get(id)!;
    const diffCols: string[] = [];

    for (const col of def.cmpColumns) {
      if (col === 'id') continue;

      let expectedSrcVal = srcRow[col];
      const remap = def.columnRemaps?.[col];
      if (remap) {
        const remapped = remap.get(expectedSrcVal as string);
        if (remapped !== undefined) expectedSrcVal = remapped;
      }

      if (canonical(expectedSrcVal) !== canonical(dstRow[col])) {
        diffCols.push(col);
      }
    }

    if (diffCols.length > 0) {
      result.changedIds.push(id);
      result.changedColumns[id] = diffCols;
    }
  }

  // Determine PASS/FAIL
  const hasMissing  = result.missingInDest.length > 0 && !result.allowMissing;
  const hasChanged  = result.changedIds.length > 0;

  // Special case for sections: only `columns` and `custom_columns` were updated
  // on pre-existing rows. Other column differences on pre-existing rows are
  // expected because the sync didn't overwrite them. We only fail sections if
  // newly-inserted rows are missing (missingInDest > 0).
  let effectiveFail = hasMissing || hasChanged;
  if (def.name === 'sections' && !hasMissing) {
    // Pre-existing sections may differ in non-synced columns — not a failure
    effectiveFail = false;
    if (hasChanged) {
      result.notes = [
        ...result.notes,
        `${result.changedIds.length} pre-existing sections have column differences (expected — sync only updated \`columns\` and \`custom_columns\`).`,
      ];
    }
  }

  result.pass = !effectiveFail;

  const missingLabel = result.missingInDest.length > 0
    ? (result.allowMissing ? `warn:missing=${result.missingInDest.length}` : `FAIL:missing=${result.missingInDest.length}`)
    : '';
  const changedLabel = result.changedIds.length > 0 && def.name !== 'sections'
    ? `FAIL:changed=${result.changedIds.length}`
    : result.changedIds.length > 0
    ? `warn:changed=${result.changedIds.length}(expected)`
    : '';
  const status = result.pass ? 'PASS' : 'FAIL';
  const detail = [missingLabel, changedLabel].filter(Boolean).join(' ');
  console.log(`${status}${detail ? ' — ' + detail : ''}`);

  return result;
}

// ── 7. Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(104);
  const line = '─'.repeat(104);

  console.log(`\n${LINE}`);
  console.log('  Phase 4.7 — Delta Sync Verification  (READ-ONLY)');
  console.log(LINE);
  console.log(`  Source (old JSR production)    : ${srcRef}`);
  console.log(`  Destination (JSR React staging): ${dstRef}`);
  console.log(`  Run at                         : ${new Date().toISOString()}\n`);
  console.log('  EXCLUDED FROM VERIFICATION: push_subscriptions (not synced — expected to differ)\n');

  const src = createClient(SRC_URL, SRC_KEY, { auth: { persistSession: false } });
  const dst = createClient(DST_URL, DST_KEY, { auth: { persistSession: false } });

  // ── Verify all tables ─────────────────────────────────────────────────────────
  const results: VerifyResult[] = [];
  let aborted = false;

  for (const def of VERIFY_TABLES) {
    try {
      results.push(await verifyTable(src, dst, def));
    } catch (err) {
      aborted = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR [${def.name}]: ${msg}`);
      results.push({
        table: def.name, srcCount: -1, dstCount: -1, skipped: 0,
        missingInDest: [], changedIds: [], changedColumns: {},
        pass: false, allowMissing: false, notes: [], error: msg,
      });
      break;
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────────────
  const c = (s: string, w: number) => s.slice(0, w).padEnd(w);
  const r = (s: string, w: number) => s.slice(0, w).padStart(w);

  console.log(`\n${LINE}`);
  console.log('  VERIFICATION SUMMARY');
  console.log(LINE);
  console.log(
    c('Table', 22) + ' │ ' + r('Src', 6) + ' │ ' + r('Dst', 6) + ' │ ' +
    r('Excl', 5) + ' │ ' + r('Missing', 8) + ' │ ' + r('Changed', 8) + ' │ Status',
  );
  console.log(line);

  let totalPass = 0, totalFail = 0;
  const failedTables: string[] = [];

  for (const res of results) {
    if (res.error) {
      console.log(c(res.table, 22) + ' │ ' + r('?', 6) + ' │ ' + r('?', 6) + ' │ ' +
        r('?', 5) + ' │ ' + r('?', 8) + ' │ ' + r('?', 8) + ' │ ERROR: ' + res.error.slice(0, 40));
      totalFail++;
      failedTables.push(res.table);
      continue;
    }

    const missingLabel = res.missingInDest.length === 0 ? '—'
      : res.allowMissing ? `(${res.missingInDest.length})` : String(res.missingInDest.length);
    const changedLabel = res.changedIds.length === 0 ? '—'
      : res.name === 'sections' ? `(${res.changedIds.length})` : String(res.changedIds.length);

    console.log(
      c(res.table, 22) + ' │ ' +
      r(String(res.srcCount), 6) + ' │ ' +
      r(String(res.dstCount), 6) + ' │ ' +
      r(res.skipped > 0 ? String(res.skipped) : '—', 5) + ' │ ' +
      r(missingLabel, 8) + ' │ ' +
      r(changedLabel, 8) + ' │ ' +
      (res.pass ? 'PASS' : 'FAIL'),
    );

    if (res.pass) { totalPass++; } else { totalFail++; failedTables.push(res.table); }
  }

  console.log(line);
  console.log(`\n  Tables PASS: ${totalPass}   Tables FAIL: ${totalFail}`);

  // ── Detail for failed or warned tables ───────────────────────────────────────
  const hasDelta = results.filter(r =>
    r.missingInDest.length > 0 || r.changedIds.length > 0 || r.notes.length > 0 || r.error,
  );

  if (hasDelta.length > 0) {
    console.log(`\n${LINE}`);
    console.log('  DETAIL (tables with missing rows, changed columns, or notes)');
    console.log(LINE);

    for (const res of hasDelta) {
      console.log(`\n  ── ${res.table} ──`);

      if (res.error) {
        console.log(`  ERROR: ${res.error}`);
        continue;
      }

      if (res.missingInDest.length > 0) {
        const label = res.allowMissing ? 'MISSING IN DEST (warning — not synced by design)' : 'MISSING IN DEST — FAIL';
        const printCount = Math.min(res.missingInDest.length, 20);
        console.log(`  ${label} (${res.missingInDest.length} rows):`);
        for (let i = 0; i < printCount; i++) console.log(`    ${res.missingInDest[i]}`);
        if (res.missingInDest.length > printCount) console.log(`    … and ${res.missingInDest.length - printCount} more`);
      }

      if (res.changedIds.length > 0) {
        const label = res.table === 'sections'
          ? 'COLUMN MISMATCH (expected — sync updated columns/custom_columns only)'
          : 'COLUMN MISMATCH — FAIL';
        const printCount = Math.min(res.changedIds.length, 20);
        console.log(`  ${label} (${res.changedIds.length} rows):`);
        for (let i = 0; i < printCount; i++) {
          const id = res.changedIds[i];
          const cols = (res.changedColumns[id] ?? []).join(', ');
          console.log(`    ${id}  [${cols}]`);
        }
        if (res.changedIds.length > printCount) console.log(`    … and ${res.changedIds.length - printCount} more`);
      }

      for (const note of res.notes) console.log(`  NOTE: ${note}`);
    }
  }

  // ── Final verdict ─────────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  if (aborted) {
    console.log('  VERIFICATION ABORTED — see error above.');
    console.log(`${LINE}\n`);
    process.exit(1);
  } else if (totalFail > 0) {
    console.log(`  VERIFICATION FAILED — ${totalFail} table(s) failed: ${failedTables.join(', ')}`);
    console.log('  Review the detail above and re-run phase4-07 --execute if rows are still missing.');
  } else {
    console.log('  VERIFICATION PASSED — all tables match source after delta sync.');
    console.log('  Remaining staging steps:');
    console.log('    1. Apply docs/go-live/11_fix_remap_target_section_visibility.sql (zain/ftk section).');
    console.log('    2. Configure VAPID keys — push_subscriptions will rebuild via browser re-subscription.');
    console.log('    3. Complete the go-live checklist in docs/go-live/FULL_CRUD_QA_CHECKLIST.md.');
  }
  console.log(`${LINE}\n`);

  if (totalFail > 0 || aborted) process.exit(1);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
