/**
 * Phase 4 — Step 3: post-migration verification.
 *
 * READ-ONLY end to end: connects to both source and destination with
 * service-role clients but makes zero writes — all checks are count queries,
 * single-row lookups, or exhaustive FK scans.
 *
 * Checks performed (in order):
 *   1. Row-count parity — source count vs destination count for every migrated
 *      table, accounting for the 10 sections rows intentionally excluded via
 *      skipIds in phase4-02. Any count mismatch is a FAIL.
 *   2. users integrity — every dest public.users row has auth_user_id IS NOT
 *      NULL and password IS NULL.
 *   3. auth.users parity — dest auth.users count equals the count of
 *      public.users rows with auth_user_id set.
 *   4. FK completeness — for every FK in the migrated schema, all non-null FK
 *      values in destination child rows must resolve to an existing parent row.
 *      Covers: push_subscriptions→users, rows→sections,
 *      employee_documents→team_members, expense_claims→team_members,
 *      salary_adjustments→team_members, invoices→clients,
 *      invoice_items→invoices, invoice_payments→invoices.
 *   5. Section remap verification — no destination rows row references any of
 *      the 10 excluded source section IDs (the two with dependents were remapped
 *      to their winners by phase4-02; the others had 0 dependents). Also confirms
 *      the two remap-target sections exist in the destination.
 *
 * Usage:
 *   npx tsx scripts/phase4-03-verify-migration.ts
 *
 * Credentials loaded from .env.phase4.local at the repo root (same file used
 * by 00-02). Values already set in the shell environment take precedence.
 * Exit code 0 = VERIFICATION: PASS. Exit code 1 = any FAIL.
 *
 * This script never prints a service-role key, a full URL with an embedded
 * key, or any source password value — only project refs, row counts, and UUIDs.
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

// ── 1. Hardcoded protected refs (same pinning as 00-02) ──────────────────────
const OLD_JSR_PROJECT_REF = 'tltbkjvrhqsxdspdfeqk';
const TAC_PROJECT_REF     = 'gauejhgitzcqjvzalshf';

// ── 2. Env vars ───────────────────────────────────────────────────────────────
const SOURCE_SUPABASE_URL              = process.env.SOURCE_SUPABASE_URL;
const SOURCE_SUPABASE_SERVICE_ROLE_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_SUPABASE_URL                = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_SERVICE_ROLE_KEY   = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_SOURCE_PROJECT_REF      = process.env.EXPECTED_SOURCE_PROJECT_REF;
const EXPECTED_DEST_PROJECT_REF        = process.env.EXPECTED_DEST_PROJECT_REF;

// ── 3. Migration facts — must stay in sync with phase4-02's TIERS ────────────

// Every table migrated by phase4-01 (users) and phase4-02 (all others).
// excludedCount = rows skipped via skipIds in phase4-02 that were never written
// to the destination. Expected dest count = source count − excludedCount.
const MIGRATED_TABLES: readonly { name: string; excludedCount: number }[] = [
  { name: 'users',               excludedCount: 0  },
  { name: 'team_members',        excludedCount: 0  },
  { name: 'clients',             excludedCount: 0  },
  { name: 'sections',            excludedCount: 10 }, // 10 excluded via skipIds
  { name: 'activity_log',        excludedCount: 0  },
  { name: 'general_expenses',    excludedCount: 0  },
  { name: 'daily_activities',    excludedCount: 0  },
  { name: 'revenue',             excludedCount: 0  },
  { name: 'project_expenses',    excludedCount: 0  },
  { name: 'employee_documents',  excludedCount: 0  },
  { name: 'expense_claims',      excludedCount: 0  },
  { name: 'salary_adjustments',  excludedCount: 0  },
  { name: 'push_subscriptions',  excludedCount: 0  },
  { name: 'invoices',            excludedCount: 0  },
  { name: 'rows',                excludedCount: 0  },
  { name: 'invoice_items',       excludedCount: 0  },
  { name: 'invoice_payments',    excludedCount: 0  },
];

// Every enforced FK in the migrated schema (from foreign_keys.csv).
// All checks run against the destination — verifying migrated data is intact.
const FK_CHECKS: readonly { child: string; column: string; parent: string }[] = [
  { child: 'push_subscriptions', column: 'user_id',    parent: 'users'        },
  { child: 'rows',               column: 'section_id', parent: 'sections'     },
  { child: 'employee_documents', column: 'member_id',  parent: 'team_members' },
  { child: 'expense_claims',     column: 'member_id',  parent: 'team_members' },
  { child: 'salary_adjustments', column: 'member_id',  parent: 'team_members' },
  { child: 'invoices',           column: 'client_id',  parent: 'clients'      },
  { child: 'invoice_items',      column: 'invoice_id', parent: 'invoices'     },
  { child: 'invoice_payments',   column: 'invoice_id', parent: 'invoices'     },
];

// The 10 section IDs excluded from migration via phase4-02's skipIds.
// No destination rows row should reference any of these — the two that had
// dependents (55f63cb0 and b393a48e) were remapped to the winner IDs below.
const EXCLUDED_SECTION_IDS: readonly string[] = [
  'adf1a0fe-935b-4024-99f6-06ff138777ac', // zain/tdd    active dup   0 rows
  '332fad28-cefd-4f40-9e74-65a226fce728', // nokia/ftk   active dup   0 rows
  '444023fd-c674-42c3-b02f-90661627c903', // huawei/tdd  active dup   0 rows
  'c3fba5bb-43ac-4d40-a59a-9274069b2238', // nokia/tdd   soft-del     0 rows
  'eba6b3fc-fd70-4096-9976-47ccea342e94', // nokia/addsec soft-del    0 rows
  '55f63cb0-d58b-45c7-82c1-bb658573c912', // zain/ftk    soft-del   467 rows → e8ee675d
  '381b8d13-c1d6-42a6-b069-5581702769a0', // zain/addsec soft-del    0 rows
  'eed95201-a02e-441a-afac-999a0509242c', // huawei/ftk  soft-del    0 rows
  'd9f05b55-9de6-41c4-8acd-81654a29d0bc', // huawei/addsec soft-del  0 rows
  'b393a48e-0bd4-422f-99d9-efce62ecaaa4', // ipt/tdd     active dup   4 rows → 3d88c00c
];

// The two remap-target sections that inherited the excluded sections' rows.
const REMAP_TARGETS: readonly { id: string; label: string }[] = [
  { id: 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a', label: 'zain/ftk winner' },
  { id: '3d88c00c-9309-40c5-96d8-04af7b514c31', label: 'ipt/tdd winner'  },
];

// ── 4. Report plumbing ────────────────────────────────────────────────────────
type Status = 'PASS' | 'FAIL';
interface CheckResult { name: string; status: Status; detail: string; }
const results: CheckResult[] = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
}

function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

// ── 5. Helpers ────────────────────────────────────────────────────────────────
const PAGE_SIZE = 500;
const FK_CHUNK  = 400;

async function getCount(client: SupabaseClient, table: string): Promise<number> {
  const { count, error } = await client
    .from(table)
    .select('*', { head: true, count: 'exact' });
  if (error) throw new Error(`count(${table}): ${error.message}`);
  return count ?? 0;
}

async function fetchColumnValues(
  client: SupabaseClient,
  table: string,
  column: string,
): Promise<(string | null)[]> {
  const all: (string | null)[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(column)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fetch ${table}.${column}: ${error.message}`);
    const rows = (data ?? []) as Record<string, string | null>[];
    for (const r of rows) all.push(r[column] ?? null);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function checkFKCompleteness(
  dest: SupabaseClient,
  child: string,
  column: string,
  parent: string,
): Promise<void> {
  const fkValues = (await fetchColumnValues(dest, child, column))
    .filter((v): v is string => v !== null && v !== '');

  if (fkValues.length === 0) {
    record(
      `FK: ${child}.${column} → ${parent}`,
      'PASS',
      'child table empty or all FK values null',
    );
    return;
  }

  const unique    = [...new Set(fkValues)];
  const foundIds  = new Set<string>();

  for (let i = 0; i < unique.length; i += FK_CHUNK) {
    const chunk = unique.slice(i, i + FK_CHUNK);
    const { data, error } = await dest.from(parent).select('id').in('id', chunk);
    if (error) throw new Error(`FK lookup ${parent}: ${error.message}`);
    for (const row of (data ?? []) as { id: string }[]) foundIds.add(row.id);
  }

  const missing = unique.filter(v => !foundIds.has(v));
  if (missing.length === 0) {
    record(
      `FK: ${child}.${column} → ${parent}`,
      'PASS',
      `${fkValues.length} value(s), ${unique.length} unique, all resolve`,
    );
  } else {
    record(
      `FK: ${child}.${column} → ${parent}`,
      'FAIL',
      `${missing.length} orphaned FK value(s): ${missing.slice(0, 3).join(', ')}` +
        (missing.length > 3 ? ` … (${missing.length - 3} more)` : ''),
    );
  }
}

// ── 6. Main ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('\n── Phase 4 Step 3 — Migration verification (READ-ONLY) ──\n');

  // 6a. Env presence — fail fast, clearly.
  const envVars: [string, string | undefined][] = [
    ['SOURCE_SUPABASE_URL',              SOURCE_SUPABASE_URL],
    ['SOURCE_SUPABASE_SERVICE_ROLE_KEY', SOURCE_SUPABASE_SERVICE_ROLE_KEY],
    ['DEST_SUPABASE_URL',                DEST_SUPABASE_URL],
    ['DEST_SUPABASE_SERVICE_ROLE_KEY',   DEST_SUPABASE_SERVICE_ROLE_KEY],
    ['EXPECTED_SOURCE_PROJECT_REF',      EXPECTED_SOURCE_PROJECT_REF],
    ['EXPECTED_DEST_PROJECT_REF',        EXPECTED_DEST_PROJECT_REF],
  ];
  const missingEnv = envVars.filter(([, v]) => !v).map(([k]) => k);
  if (missingEnv.length) {
    console.error('ERROR: missing required env vars:', missingEnv.join(', '));
    console.error('Add them to .env.phase4.local — see scripts/README.md.');
    process.exit(1);
  }

  // 6b. Identity guard — pinned to hardcoded constants, not just env vars.
  const sourceRef = extractProjectRef(SOURCE_SUPABASE_URL);
  const destRef   = extractProjectRef(DEST_SUPABASE_URL);
  const guardFailures: string[] = [];

  if (sourceRef !== OLD_JSR_PROJECT_REF)
    guardFailures.push(`SOURCE ref "${sourceRef ?? '(unresolved)'}" is not the known old-JSR ref`);
  if (sourceRef !== EXPECTED_SOURCE_PROJECT_REF)
    guardFailures.push('SOURCE ref does not match EXPECTED_SOURCE_PROJECT_REF');
  if (destRef !== EXPECTED_DEST_PROJECT_REF)
    guardFailures.push(`DEST ref "${destRef ?? '(unresolved)'}" does not match EXPECTED_DEST_PROJECT_REF`);
  if (destRef === OLD_JSR_PROJECT_REF)
    guardFailures.push('DEST resolves to the live old-JSR project');
  if (destRef === TAC_PROJECT_REF)
    guardFailures.push("DEST resolves to TAC's project");
  if (sourceRef !== null && destRef !== null && sourceRef === destRef)
    guardFailures.push('SOURCE and DEST resolve to the same project');

  if (guardFailures.length) {
    console.error('ERROR: identity guard failed:');
    guardFailures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log(`Source (read-only):      ${sourceRef}`);
  console.log(`Destination (read-only): ${destRef}\n`);

  const source = createClient(SOURCE_SUPABASE_URL!, SOURCE_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const dest = createClient(DEST_SUPABASE_URL!, DEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Check 1: Row-count parity ──────────────────────────────────────────────
  console.log('── Check 1: Row-count parity ─────────────────────────────────────────────\n');

  interface ParityRow {
    table: string;
    src: number;
    excluded: number;
    expected: number;
    dst: number;
  }

  const parity: ParityRow[] = [];
  let anyCountFail = false;

  for (const { name, excludedCount } of MIGRATED_TABLES) {
    let src = 0;
    let dst = 0;
    try { src = await getCount(source, name); } catch (e) {
      console.error(`  WARN: could not count source.${name}: ${e instanceof Error ? e.message : e}`);
    }
    try { dst = await getCount(dest, name); } catch (e) {
      console.error(`  WARN: could not count dest.${name}: ${e instanceof Error ? e.message : e}`);
    }
    const expected = src - excludedCount;
    if (dst !== expected) anyCountFail = true;
    parity.push({ table: name, src, excluded: excludedCount, expected, dst });
  }

  // Render the count diff table.
  const W = { tbl: 24, src: 7, excl: 9, exp: 9, dst: 6 };
  const sep = `  ${'-'.repeat(W.tbl)} ${'-'.repeat(W.src)} ${'-'.repeat(W.excl)} ${'-'.repeat(W.exp)} ${'-'.repeat(W.dst)} ──────────────────────────────`;
  console.log(
    `  ${'Table'.padEnd(W.tbl)} ${'Source'.padStart(W.src)} ${'Excluded'.padStart(W.excl)}` +
    ` ${'Expected'.padStart(W.exp)} ${'Dest'.padStart(W.dst)}  Status`,
  );
  console.log(sep);
  for (const r of parity) {
    const ok     = r.dst === r.expected;
    const status = ok ? 'PASS' : `FAIL (expected ${r.expected}, got ${r.dst})`;
    console.log(
      `  ${r.table.padEnd(W.tbl)} ${String(r.src).padStart(W.src)} ` +
      `${String(r.excluded || '').padStart(W.excl)} ` +
      `${String(r.expected).padStart(W.exp)} ${String(r.dst).padStart(W.dst)}  ${status}`,
    );
  }
  console.log(sep + '\n');

  record(
    'Row-count parity (all migrated tables)',
    anyCountFail ? 'FAIL' : 'PASS',
    anyCountFail
      ? 'one or more tables have unexpected dest counts — see table above'
      : 'all 17 tables match expected counts',
  );

  // ── Check 2: users integrity ───────────────────────────────────────────────
  console.log('── Check 2: users integrity ──────────────────────────────────────────────\n');

  try {
    const { count: noAuth, error: e1 } = await dest
      .from('users')
      .select('*', { head: true, count: 'exact' })
      .is('auth_user_id', null);
    if (e1) throw new Error(e1.message);

    const { count: total, error: e2 } = await dest
      .from('users')
      .select('*', { head: true, count: 'exact' });
    if (e2) throw new Error(e2.message);

    record(
      'All dest users have auth_user_id set',
      (noAuth ?? 0) === 0 ? 'PASS' : 'FAIL',
      (noAuth ?? 0) === 0
        ? `${total ?? 0} user(s), all have auth_user_id`
        : `${noAuth} user(s) with auth_user_id = null`,
    );
  } catch (e) {
    record('All dest users have auth_user_id set', 'FAIL', e instanceof Error ? e.message : String(e));
  }

  try {
    const { count: hasPassword, error: e3 } = await dest
      .from('users')
      .select('*', { head: true, count: 'exact' })
      .not('password', 'is', null);
    if (e3) throw new Error(e3.message);

    record(
      'All dest users have password = null',
      (hasPassword ?? 0) === 0 ? 'PASS' : 'FAIL',
      (hasPassword ?? 0) === 0
        ? 'no users have a non-null password'
        : `${hasPassword} user(s) still have a non-null password`,
    );
  } catch (e) {
    record('All dest users have password = null', 'FAIL', e instanceof Error ? e.message : String(e));
  }

  // ── Check 3: auth.users parity ────────────────────────────────────────────
  console.log('── Check 3: auth.users parity ────────────────────────────────────────────\n');

  try {
    let authCount = 0;
    let page = 1;
    for (;;) {
      const { data, error } = await dest.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(error.message);
      authCount += data.users.length;
      if (data.users.length < 1000) break;
      page++;
    }

    const { count: withAuthId, error: e4 } = await dest
      .from('users')
      .select('*', { head: true, count: 'exact' })
      .not('auth_user_id', 'is', null);
    if (e4) throw new Error(e4.message);

    record(
      'auth.users count = public.users with auth_user_id',
      authCount === (withAuthId ?? 0) ? 'PASS' : 'FAIL',
      `auth.users: ${authCount}, public.users with auth_user_id: ${withAuthId ?? 0}`,
    );
  } catch (e) {
    record(
      'auth.users count = public.users with auth_user_id',
      'FAIL',
      e instanceof Error ? e.message : String(e),
    );
  }

  // ── Check 4: FK completeness ──────────────────────────────────────────────
  console.log('── Check 4: FK completeness (destination) ────────────────────────────────\n');

  for (const { child, column, parent } of FK_CHECKS) {
    try {
      await checkFKCompleteness(dest, child, column, parent);
    } catch (e) {
      record(
        `FK: ${child}.${column} → ${parent}`,
        'FAIL',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ── Check 5: Section remap verification ───────────────────────────────────
  console.log('── Check 5: Section remap verification ───────────────────────────────────\n');

  // 5a. No rows in dest `rows` table reference any of the 10 excluded section IDs.
  try {
    const { count: orphaned, error } = await dest
      .from('rows')
      .select('*', { head: true, count: 'exact' })
      .in('section_id', EXCLUDED_SECTION_IDS as string[]);
    if (error) throw new Error(error.message);

    record(
      'No dest rows reference excluded section IDs',
      (orphaned ?? 0) === 0 ? 'PASS' : 'FAIL',
      (orphaned ?? 0) === 0
        ? '0 rows reference any of the 10 excluded section IDs'
        : `${orphaned} row(s) still reference an excluded section ID`,
    );
  } catch (e) {
    record(
      'No dest rows reference excluded section IDs',
      'FAIL',
      e instanceof Error ? e.message : String(e),
    );
  }

  // 5b. Both remap-target sections exist in the destination.
  for (const { id, label } of REMAP_TARGETS) {
    try {
      const { data, error } = await dest
        .from('sections')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);

      record(
        `Remap target exists in dest sections: ${label}`,
        data !== null ? 'PASS' : 'FAIL',
        data !== null ? id : `section ${id} not found in destination`,
      );
    } catch (e) {
      record(
        `Remap target exists in dest sections: ${label}`,
        'FAIL',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // ── Final report ──────────────────────────────────────────────────────────
  printReport();
}

function printReport(): void {
  const failed = results.filter(r => r.status === 'FAIL');

  console.log('── Verification summary ──────────────────────────────────────────────────');
  for (const r of results) {
    console.log(`  [${r.status}] ${r.name} — ${r.detail}`);
  }
  console.log('─────────────────────────────────────────────────────────────────────────');

  if (failed.length === 0) {
    console.log('VERIFICATION: PASS — migration data is consistent.');
    process.exit(0);
  } else {
    console.log(`VERIFICATION: FAIL — ${failed.length} check(s) failed.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Verification script crashed unexpectedly:', e instanceof Error ? e.message : e);
  process.exit(1);
});
