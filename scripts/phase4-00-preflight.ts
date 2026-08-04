/**
 * Phase 4 — Step 0: preflight safety gate.
 *
 * RUN ONCE PER MIGRATION ATTEMPT, LOCALLY, BEFORE any other Phase 4 script.
 * This script is READ-ONLY end to end: it never inserts, updates, deletes,
 * or creates anything in either project, and it never calls
 * `supabase.auth.admin.createUser()`. It only reads — table/column
 * existence, row counts, and the Auth user list — and prints a PASS/FAIL
 * report. No other Phase 4 script (auth migration, table migration) should
 * be built or run until this one prints PREFLIGHT: PASS.
 *
 * What it checks, in order:
 *   1. SOURCE_SUPABASE_URL resolves to the original, live JSR project.
 *   2. DEST_SUPABASE_URL resolves to the project named in
 *      EXPECTED_DEST_PROJECT_REF (the new "JSR Network Tracker React"
 *      staging project).
 *   3. Destination is never the live JSR project or TAC's project, and
 *      source/destination are never the same project — regardless of what
 *      the *_PROJECT_REF env vars say. These two comparisons are pinned to
 *      hardcoded constants below, not just to each other's env vars, so a
 *      typo in .env.phase4.local can't silently redefine what "safe" means.
 *   4. All 25 required destination tables exist, with all required columns
 *      (existence only — see the note above REQUIRED_COLUMNS for why
 *      nullability/FK/trigger/index shape are intentionally NOT re-checked
 *      here).
 *   5. Every migrated production table (the 17 in MIGRATED_TABLES) is
 *      empty in the destination.
 *   6. Destination auth.users is empty.
 *
 * Usage:
 *   npx tsx scripts/phase4-00-preflight.ts
 *
 * Credentials come from `.env.phase4.local` at the repo root (create it
 * yourself locally — see docs/phase4-migration/PHASE4_MIGRATION_PLAN.md
 * section 5 for the expected contents). Values already present in the
 * shell environment take precedence over the file, same convention as
 * scripts/migrate-users-to-auth.ts. This script never prints a service
 * role key, a full URL with an embedded key, or the .env file's contents —
 * only project refs (the public subdomain segment) and row counts.
 *
 * Optional: set ALLOW_RESUME=true to downgrade the "must be empty" checks
 * (migrated tables + auth.users) from FAIL to WARN, for a deliberate resume
 * after a partial migration failure. Off by default — leave it unset for a
 * normal preflight run.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 0. Load .env.phase4.local (best-effort, never overrides real env vars) ──
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
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnvLocal();

// ── 1. Hardcoded protected refs — never trust an env var alone for these ────
const OLD_JSR_PROJECT_REF = 'tltbkjvrhqsxdspdfeqk';
const TAC_PROJECT_REF = 'gauejhgitzcqjvzalshf';

// ── 2. Required env vars ─────────────────────────────────────────────────────
const SOURCE_SUPABASE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_SUPABASE_SERVICE_ROLE_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_SERVICE_ROLE_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_SOURCE_PROJECT_REF = process.env.EXPECTED_SOURCE_PROJECT_REF;
const EXPECTED_DEST_PROJECT_REF = process.env.EXPECTED_DEST_PROJECT_REF;
const ALLOW_RESUME = process.env.ALLOW_RESUME === 'true';

// ── 3. Schema expectations ───────────────────────────────────────────────────
// Full column lists, transcribed directly from docs/phase3-staging-schema/
// 01-04 and the Phase 4 schema patch (07_patch_existing_staging_schema.sql).
// This check confirms EXISTENCE of every table and column only. It
// deliberately does NOT re-derive NOT NULL depth, FK ON DELETE CASCADE, the
// rows_updated_at trigger, or the composite rows_section_order_idx shape —
// those were already confirmed directly against information_schema via
// verify_existing_staging_patch.sql and verify_staging_schema.sql (which you
// just ran and confirmed passing). Re-deriving that here would need a direct
// Postgres connection (a new credential + a new npm dependency neither of
// which exist in this repo today) rather than the PostgREST client already
// in use everywhere else in this script — flagging the scope choice
// explicitly rather than silently narrowing it.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  users: [
    'id', 'username', 'password', 'role', 'created_at', 'full_name', 'permissions',
    'auth_user_id', 'phone', 'national_id', 'date_of_birth', 'address',
    'emergency_contact_name', 'emergency_contact_phone', 'start_date', 'notes',
    'profile_photo_url',
  ],
  team_members: [
    'id', 'full_name', 'monthly_salary', 'role', 'is_active', 'created_at', 'phone',
    'notes', 'national_id', 'date_of_birth', 'address', 'emergency_contact_name',
    'emergency_contact_phone', 'start_date', 'profile_photo_url', 'activated_at',
    'deactivated_at', 'username',
  ],
  clients: ['id', 'created_at', 'company_name', 'contact_person', 'email', 'phone', 'address', 'notes'],
  activity_log: ['id', 'user_full_name', 'action', 'project_name', 'section_name', 'details', 'created_at'],
  general_expenses: ['id', 'description', 'category', 'amount', 'expense_date', 'month', 'year', 'notes', 'added_by', 'created_at'],
  project_expenses: [
    'id', 'project_name', 'description', 'category', 'amount', 'expense_date', 'month',
    'year', 'notes', 'added_by', 'created_at', 'activity_date', 'site_id', 'employee_ids',
    'accommodation', 'submitted_by', 'approved_by',
  ],
  daily_activities: [
    'id', 'date', 'site_id', 'activity_type', 'team_member_ids', 'team_member_names',
    'notes', 'status', 'created_by', 'created_at', 'governate', 'project',
  ],
  sections: ['id', 'project_name', 'section_name', 'section_label', 'columns', 'custom_columns', 'is_custom', 'is_deleted', 'created_at'],
  revenue: ['id', 'project_name', 'site_id', 'amount', 'month', 'year', 'created_at'],
  sites: [
    'id', 'operator', 'site_code', 'site_name', 'governorate', 'city', 'latitude',
    'longitude', 'site_type', 'cabina_type', 'installation_type', 'tower_height',
    'topology', 'antenna', 'vendor', 'status', 'created_at',
  ],
  app_settings: ['key', 'value', 'updated_at'],
  projects: ['id', 'key', 'display_name', 'has_sections', 'sort_order', 'is_active', 'created_at'],
  saved_points: ['id', 'name', 'latitude', 'longitude', 'is_active', 'created_at'],
  employee_documents: ['id', 'member_id', 'file_name', 'file_url', 'file_type', 'uploaded_by', 'uploaded_at'],
  expense_claims: [
    'id', 'member_id', 'project_name', 'site_id', 'governorate', 'description',
    'activity_date', 'transport_amount', 'food_amount', 'accommodation',
    'extra_categories', 'total_amount', 'status', 'rejection_comment', 'submitted_at',
    'reviewed_at', 'reviewed_by', 'notes', 'rejection_reason', 'employee_ids',
  ],
  salary_adjustments: ['id', 'member_id', 'month', 'year', 'adjusted_amount', 'reason', 'created_at', 'adj_type'],
  push_subscriptions: ['id', 'user_id', 'subscription', 'created_at'],
  invoices: [
    'id', 'created_at', 'invoice_number', 'client_id', 'project_name', 'issue_date',
    'due_date', 'total_amount', 'amount_received', 'status', 'notes', 'created_by',
  ],
  rows: ['id', 'section_id', 'data', 'row_order', 'created_at', 'updated_at'],
  invoice_items: ['id', 'invoice_id', 'site_id', 'section_name', 'description', 'amount', 'revenue_id'],
  invoice_payments: ['id', 'created_at', 'invoice_id', 'payment_date', 'amount', 'reference', 'notes', 'recorded_by'],
  cars: ['id', 'name', 'plate_number', 'owner_id', 'is_active', 'created_at'],
  field_trips: [
    'id', 'daily_activity_id', 'date', 'project', 'site_id', 'governate', 'notes',
    'team_member_ids', 'team_member_names', 'status', 'created_by', 'started_at',
    'started_by', 'started_by_name', 'departed_at', 'completed_at',
  ],
  trip_participants: [
    'id', 'trip_id', 'member_id', 'member_name', 'status', 'joined_at', 'delay_minutes',
    'last_lat', 'last_lng', 'last_location_at',
  ],
  attendance: [
    'id', 'member_id', 'date', 'clock_in', 'clock_out', 'hours_worked', 'status', 'notes',
    'clock_in_lat', 'clock_in_lng', 'clock_out_lat', 'clock_out_lng', 'updated_by', 'updated_at',
  ],
};

// The subset of REQUIRED_COLUMNS that Phase 4 actually migrates production
// rows into (Tier 0-2 from PHASE4_MIGRATION_PLAN.md section 3, plus `users`
// for Step 1/2). Every other table (sites, app_settings, projects,
// saved_points, cars, field_trips, trip_participants, attendance) is
// React-only / seed-only and is intentionally excluded from the "must be
// empty" check below — app_settings and projects are expected to already
// hold their seed rows from file 01.
const MIGRATED_TABLES = [
  'users', 'team_members', 'clients', 'activity_log', 'general_expenses',
  'project_expenses', 'daily_activities', 'sections', 'revenue',
  'employee_documents', 'expense_claims', 'salary_adjustments',
  'push_subscriptions', 'invoices', 'rows', 'invoice_items', 'invoice_payments',
];

// ── 4. Report plumbing ───────────────────────────────────────────────────────
type Status = 'PASS' | 'FAIL' | 'WARN';
interface CheckResult {
  name: string;
  status: Status;
  detail: string;
}
const results: CheckResult[] = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
}

function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

function isMissingTableError(message: string, code?: string): boolean {
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    /relation .* does not exist/i.test(message) ||
    /could not find the table/i.test(message)
  );
}

function isMissingColumnError(message: string, code?: string): boolean {
  return code === '42703' || /column .* does not exist/i.test(message);
}

// ── 5. Checks ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // 5a. Env presence — every other check depends on these, so fail fast per
  // missing var but keep going so the report is complete in one run.
  const requiredEnv: Record<string, string | undefined> = {
    SOURCE_SUPABASE_URL,
    SOURCE_SUPABASE_SERVICE_ROLE_KEY,
    DEST_SUPABASE_URL,
    DEST_SUPABASE_SERVICE_ROLE_KEY,
    EXPECTED_SOURCE_PROJECT_REF,
    EXPECTED_DEST_PROJECT_REF,
  };
  for (const [key, value] of Object.entries(requiredEnv)) {
    record(
      `env: ${key} is set`,
      value ? 'PASS' : 'FAIL',
      value ? '(value present, not printed)' : 'missing — set it in .env.phase4.local or the shell environment',
    );
  }

  const sourceRef = extractProjectRef(SOURCE_SUPABASE_URL);
  const destRef = extractProjectRef(DEST_SUPABASE_URL);

  record(
    'SOURCE_SUPABASE_URL parses to a valid project ref',
    sourceRef ? 'PASS' : 'FAIL',
    sourceRef ?? `could not extract a ref from "${SOURCE_SUPABASE_URL ?? '(unset)'}"`,
  );
  record(
    'DEST_SUPABASE_URL parses to a valid project ref',
    destRef ? 'PASS' : 'FAIL',
    destRef ?? `could not extract a ref from "${DEST_SUPABASE_URL ?? '(unset)'}"`,
  );

  // 5b. Identity checks — pinned to hardcoded constants, not just env vars.
  record(
    'EXPECTED_SOURCE_PROJECT_REF is pinned to the real old-JSR ref',
    EXPECTED_SOURCE_PROJECT_REF === OLD_JSR_PROJECT_REF ? 'PASS' : 'FAIL',
    EXPECTED_SOURCE_PROJECT_REF === OLD_JSR_PROJECT_REF
      ? OLD_JSR_PROJECT_REF
      : `EXPECTED_SOURCE_PROJECT_REF ("${EXPECTED_SOURCE_PROJECT_REF ?? '(unset)'}") does not match the known old-JSR ref`,
  );
  record(
    'Source project is the original JSR project',
    sourceRef !== null && sourceRef === EXPECTED_SOURCE_PROJECT_REF ? 'PASS' : 'FAIL',
    `source ref: ${sourceRef ?? '(unresolved)'} vs expected: ${EXPECTED_SOURCE_PROJECT_REF ?? '(unset)'}`,
  );
  record(
    'Destination project matches EXPECTED_DEST_PROJECT_REF',
    destRef !== null && destRef === EXPECTED_DEST_PROJECT_REF ? 'PASS' : 'FAIL',
    `destination ref: ${destRef ?? '(unresolved)'} vs expected: ${EXPECTED_DEST_PROJECT_REF ?? '(unset)'}`,
  );
  record(
    'Destination is not the live old-JSR project',
    destRef !== OLD_JSR_PROJECT_REF ? 'PASS' : 'FAIL',
    destRef === OLD_JSR_PROJECT_REF ? 'destination ref equals the old-JSR ref — refusing to proceed' : `destination ref: ${destRef ?? '(unresolved)'}`,
  );
  record(
    'Destination is not TAC\'s project',
    destRef !== TAC_PROJECT_REF ? 'PASS' : 'FAIL',
    destRef === TAC_PROJECT_REF ? 'destination ref equals the TAC ref — refusing to proceed' : `destination ref: ${destRef ?? '(unresolved)'}`,
  );
  record(
    'Source and destination are different projects',
    sourceRef !== null && destRef !== null && sourceRef !== destRef ? 'PASS' : 'FAIL',
    `source: ${sourceRef ?? '(unresolved)'}, destination: ${destRef ?? '(unresolved)'}`,
  );

  // If we don't have working destination credentials, there's no point
  // attempting the schema/emptiness/auth checks below — record them as
  // skipped-as-FAIL rather than throwing, so the report still prints in
  // full.
  if (!DEST_SUPABASE_URL || !DEST_SUPABASE_SERVICE_ROLE_KEY) {
    record('Destination table/column/emptiness checks', 'FAIL', 'skipped — DEST_SUPABASE_URL or DEST_SUPABASE_SERVICE_ROLE_KEY not set');
    record('auth.users is empty', 'FAIL', 'skipped — DEST_SUPABASE_URL or DEST_SUPABASE_SERVICE_ROLE_KEY not set');
    printReportAndExit();
    return;
  }

  const dest = createClient(DEST_SUPABASE_URL, DEST_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 5c. Table + column existence, and (for migrated tables) row count —
  // one query per table serves both purposes.
  const rowCounts: Record<string, number> = {};

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    try {
      const { error, count } = await dest
        .from(table)
        .select(columns.join(','), { head: true, count: 'exact' });

      if (error) {
        const msg = error.message ?? String(error);
        const code = (error as { code?: string }).code;
        if (isMissingTableError(msg, code)) {
          record(`table exists: ${table}`, 'FAIL', `table not found (${msg})`);
        } else if (isMissingColumnError(msg, code)) {
          record(`required columns exist: ${table}`, 'FAIL', msg);
        } else {
          record(`table/columns check: ${table}`, 'FAIL', msg);
        }
        continue;
      }

      record(`table + required columns exist: ${table}`, 'PASS', `${columns.length} columns confirmed`);
      if (typeof count === 'number') {
        rowCounts[table] = count;
      }
    } catch (e) {
      record(`table/columns check: ${table}`, 'FAIL', e instanceof Error ? e.message : String(e));
    }
  }

  // 5d. Emptiness — migrated tables only.
  for (const table of MIGRATED_TABLES) {
    const count = rowCounts[table];
    if (count === undefined) {
      record(`empty: ${table}`, 'FAIL', 'row count unavailable — table/column check above did not succeed');
      continue;
    }
    if (count === 0) {
      record(`empty: ${table}`, 'PASS', '0 rows');
    } else if (ALLOW_RESUME) {
      record(`empty: ${table}`, 'WARN', `${count} rows present — allowed because ALLOW_RESUME=true`);
    } else {
      record(`empty: ${table}`, 'FAIL', `${count} rows present — expected 0 (set ALLOW_RESUME=true to deliberately resume)`);
    }
  }

  // 5e. auth.users empty.
  try {
    const { data, error } = await dest.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) {
      record('auth.users is empty', 'FAIL', error.message);
    } else {
      const n = data.users.length;
      if (n === 0) {
        record('auth.users is empty', 'PASS', '0 users');
      } else if (ALLOW_RESUME) {
        record('auth.users is empty', 'WARN', `${n} users present — allowed because ALLOW_RESUME=true`);
      } else {
        record('auth.users is empty', 'FAIL', `${n} users present — expected 0 (set ALLOW_RESUME=true to deliberately resume)`);
      }
    }
  } catch (e) {
    record('auth.users is empty', 'FAIL', e instanceof Error ? e.message : String(e));
  }

  printReportAndExit();
}

function printReportAndExit(): void {
  const failed = results.filter(r => r.status === 'FAIL');
  const warned = results.filter(r => r.status === 'WARN');

  console.log('\n── Phase 4 Step 0 — Preflight report ───────────────────────');
  for (const r of results) {
    const tag = r.status === 'PASS' ? 'PASS' : r.status === 'WARN' ? 'WARN' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log('─────────────────────────────────────────────────────────────');
  if (warned.length) {
    console.log(`  ${warned.length} check(s) WARN (ALLOW_RESUME override in effect).`);
  }

  if (failed.length === 0) {
    console.log('PREFLIGHT: PASS — safe to proceed to the next Phase 4 script.');
    process.exit(0);
  } else {
    console.log(`PREFLIGHT: FAIL — ${failed.length} check(s) failed. Do not proceed.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Preflight crashed unexpectedly:', e instanceof Error ? e.message : e);
  process.exit(1);
});
