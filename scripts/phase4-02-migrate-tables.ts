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
 * DRY RUN vs EXECUTE:
 *   Default: dry run — reads source, validates schemas and FKs, prints the
 *   per-table plan (source rows / to-insert / already-present), writes nothing.
 *   Pass `--execute` to perform the actual inserts.
 *
 * PRE-WRITE VALIDATION (done upfront for all 16 tables before any writes):
 *   1. Source table is reachable and all expected columns exist.
 *   2. Destination table is reachable and all expected columns exist.
 *   Any schema mismatch → the whole script aborts immediately, nothing written.
 *
 *   Per-table, just before writing:
 *   3. All non-null FK values from source rows exist in the relevant parent
 *      table. In dry-run mode the check runs against SOURCE (data-quality
 *      sanity check). In execute mode it runs against DESTINATION (confirms
 *      parent tier was fully migrated before touching this child table).
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
const PAGE_SIZE         = 500;   // rows per paginated read
const INSERT_BATCH_SIZE = 200;   // rows per insert call
const FK_CHUNK_SIZE     = 400;   // max IDs per .in() query (URL-length safety)

// ── 4. Table definitions ──────────────────────────────────────────────────────
// Column lists match REQUIRED_COLUMNS in phase4-00-preflight.ts exactly.
// FKs list only enforced FK constraints (from docs/schema-audit-results/foreign_keys.csv).

interface FKDef { column: string; parentTable: string; }

interface TableDef {
  name: string;
  columns: string[];
  fks: FKDef[];
}

const TIERS: readonly TableDef[][] = [
  // ── Tier 0: no FK dependencies on other migrated tables ─────────────────
  [
    {
      name: 'team_members',
      // `username` exists in the destination staging schema but not in the
      // source old-JSR table — omit it here so the SELECT from source succeeds.
      // The destination column will be NULL for migrated rows (nullable by design).
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
      // Source has 12 columns (invoice_date, notes, added_by, status, section_name
      // plus the 7 below). Destination staging schema only has these 7 — copy
      // the intersection; the extra source columns are intentionally not migrated.
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
  // ── Tier 1: FK dependencies on Tier 0 (or on users, already done in Step 1)
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
  toInsert: number;
  inserted: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// ── 6. Helpers ────────────────────────────────────────────────────────────────
function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

/** Pages through a table, returning every row for the given columns. */
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

/** Returns the set of `id` values currently in a destination table. */
async function fetchDestIds(client: SupabaseClient, table: string): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string }>(client, table, ['id']);
  return new Set(rows.map(r => r.id));
}

/** Returns only the specified columns from a row object. */
function pickColumns(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of columns) out[col] = row[col] ?? null;
  return out;
}

/**
 * Validates that all expected columns exist on the given table in `client`.
 * Uses a HEAD+count query (no rows transferred). Throws on any mismatch.
 */
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
  // Any other error (column missing, permission, etc.) is also a schema problem.
  throw new Error(`SCHEMA MISMATCH [${label}]: table "${table}" — ${msg}`);
}

/**
 * Validates that every non-null FK value appearing in `sourceRows` exists as
 * a primary key in the parent table on `checkClient`.
 *
 * Queries only the specific IDs referenced (not a full table scan), chunked to
 * stay within PostgREST URL limits. Throws with details on any missing parent.
 */
async function validateFKs(
  checkClient: SupabaseClient,
  table: string,
  fks: FKDef[],
  sourceRows: Record<string, unknown>[],
): Promise<void> {
  for (const fk of fks) {
    const unique = [...new Set(
      sourceRows
        .map(r => r[fk.column] as string | null | undefined)
        .filter((v): v is string => v != null && v !== ''),
    )];

    if (unique.length === 0) continue;

    // Chunk to avoid URL-length limits on very large .in() lists.
    const foundIds = new Set<string>();
    for (let i = 0; i < unique.length; i += FK_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + FK_CHUNK_SIZE);
      const { data, error } = await checkClient
        .from(fk.parentTable)
        .select('id')
        .in('id', chunk);
      if (error) throw new Error(`FK validation: querying ${fk.parentTable}: ${error.message}`);
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
  const { name: table, columns, fks } = tableDef;
  const result: TableResult = {
    table, sourceRows: 0, toInsert: 0, inserted: 0, skipped: 0, failed: 0, errors: [],
  };

  // a. Read all source rows.
  const sourceRows = await fetchAllRows<Record<string, unknown>>(source, table, columns);
  result.sourceRows = sourceRows.length;

  if (sourceRows.length === 0) {
    console.log(`  ${table}: 0 source rows — nothing to do.`);
    return result;
  }

  // b. FK validation.
  //    Dry run → check against source (data-quality sanity check).
  //    Execute  → check against destination (confirms parent tier was migrated).
  if (fks.length > 0) {
    await validateFKs(EXECUTE ? dest : source, table, fks, sourceRows);
  }

  // c. Identify which rows already exist in destination (idempotency).
  const destIds  = await fetchDestIds(dest, table);
  const toInsert = sourceRows.filter(r => !destIds.has(r.id as string));
  result.skipped  = sourceRows.length - toInsert.length;
  result.toInsert = toInsert.length;

  console.log(
    `  ${table}: ${sourceRows.length} source rows | ` +
    `${toInsert.length} to insert | ${result.skipped} already present (skip)`,
  );

  if (!EXECUTE || toInsert.length === 0) return result;

  // d. Insert in batches. On batch failure, fall back to one-by-one so we can
  //    identify exactly which rows failed without aborting the whole table.
  for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
    const batch = toInsert
      .slice(i, i + INSERT_BATCH_SIZE)
      .map(r => pickColumns(r, columns));

    const { error } = await dest.from(table).insert(batch);

    if (!error) {
      result.inserted += batch.length;
      continue;
    }

    // Batch failed — retry individually to isolate bad rows.
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
    console.error('Set them in .env.phase4.local — see scripts/README.md.');
    process.exit(1);
  }

  // 8b. Identity guard — independent of phase4-00-preflight.ts.
  const sourceRef = extractProjectRef(SOURCE_SUPABASE_URL);
  const destRef   = extractProjectRef(DEST_SUPABASE_URL);
  const guardFailures: string[] = [];

  if (sourceRef !== OLD_JSR_PROJECT_REF)
    guardFailures.push(`SOURCE ref "${sourceRef ?? '(unresolved)'}" is not the known old-JSR ref (${OLD_JSR_PROJECT_REF})`);
  if (sourceRef !== EXPECTED_SOURCE_PROJECT_REF)
    guardFailures.push(`SOURCE ref "${sourceRef ?? '(unresolved)'}" does not match EXPECTED_SOURCE_PROJECT_REF ("${EXPECTED_SOURCE_PROJECT_REF ?? ''}")`);
  if (destRef !== EXPECTED_DEST_PROJECT_REF)
    guardFailures.push(`DEST ref "${destRef ?? '(unresolved)'}" does not match EXPECTED_DEST_PROJECT_REF ("${EXPECTED_DEST_PROJECT_REF ?? ''}")`);
  if (destRef === OLD_JSR_PROJECT_REF)
    guardFailures.push('DEST resolves to the live old-JSR project — refusing to write to it.');
  if (destRef === TAC_PROJECT_REF)
    guardFailures.push("DEST resolves to TAC's project — refusing to write to it.");
  if (sourceRef !== null && destRef !== null && sourceRef === destRef)
    guardFailures.push('SOURCE and DEST resolve to the same project — refusing to proceed.');

  if (guardFailures.length) {
    console.error('ERROR: identity guard failed — nothing was read or written:');
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

  // 8c. Upfront schema validation for all 16 tables.
  //     A single mismatch aborts the whole run — nothing is written.
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
        // Unexpected error (network, PostgREST, etc.) — record and continue.
        allResults.push({ table: tableDef.name, sourceRows: 0, toInsert: 0, inserted: 0, skipped: 0, failed: 1, errors: [msg] });
        anyFailed = true;
      }
    }
    console.log('');
  }

  // 8e. Summary table.
  const COL = { table: 24, src: 7, plan: 10, ins: 10, skip: 8, fail: 7 };
  const sep = `  ${'-'.repeat(COL.table)} ${'-'.repeat(COL.src)} ${'-'.repeat(COL.plan)} ${'-'.repeat(COL.ins)} ${'-'.repeat(COL.skip)} ${'-'.repeat(COL.fail)}`;

  console.log('\n── Summary ──────────────────────────────────────────────────────────');
  console.log(
    `  ${'Table'.padEnd(COL.table)} ` +
    `${'Source'.padStart(COL.src)} ` +
    `${'ToInsert'.padStart(COL.plan)} ` +
    `${'Inserted'.padStart(COL.ins)} ` +
    `${'Skipped'.padStart(COL.skip)} ` +
    `${'Failed'.padStart(COL.fail)}`,
  );
  console.log(sep);

  let totSrc = 0, totPlan = 0, totIns = 0, totSkip = 0, totFail = 0;
  for (const r of allResults) {
    totSrc  += r.sourceRows;
    totPlan += r.toInsert;
    totIns  += r.inserted;
    totSkip += r.skipped;
    totFail += r.failed;
    console.log(
      `  ${r.table.padEnd(COL.table)} ` +
      `${String(r.sourceRows).padStart(COL.src)} ` +
      `${String(r.toInsert).padStart(COL.plan)} ` +
      `${String(r.inserted).padStart(COL.ins)} ` +
      `${String(r.skipped).padStart(COL.skip)} ` +
      `${String(r.failed).padStart(COL.fail)}`,
    );
  }
  console.log(sep);
  console.log(
    `  ${'TOTAL'.padEnd(COL.table)} ` +
    `${String(totSrc).padStart(COL.src)} ` +
    `${String(totPlan).padStart(COL.plan)} ` +
    `${String(totIns).padStart(COL.ins)} ` +
    `${String(totSkip).padStart(COL.skip)} ` +
    `${String(totFail).padStart(COL.fail)}`,
  );
  console.log('─────────────────────────────────────────────────────────────────────');

  if (!EXECUTE) {
    console.log('\nDRY RUN complete — no writes were made. Re-run with --execute to apply.');
    process.exit(0);
  }

  if (anyFailed) {
    console.log('\nMigration completed with failures.');
    console.log('Re-run with --execute to resume — rows already inserted will be skipped automatically.');
    process.exit(1);
  }

  console.log('\nMigration complete — all tables migrated successfully.');
  process.exit(0);
}

main().catch(e => {
  console.error('Migration script crashed unexpectedly:', e instanceof Error ? e.message : e);
  process.exit(1);
});
