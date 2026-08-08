/**
 * phase4-05-insert-post-migration-revenue.ts
 *
 * One-time targeted INSERT of exactly 2 revenue rows that were created in the
 * old JSR production database on 2026-08-05 — the day AFTER the phase4-02
 * migration ran (2026-08-04). They were absent from the destination solely
 * because they did not exist at migration time. No migration failure occurred.
 *
 * Target rows (hardcoded; any deviation aborts the script):
 *   afae4065-bcdd-4c32-ac7a-1a579ffe3916  TAC Project / site 9644
 *   50f353e4-50f6-4fef-9cd3-210b2f2a837e  TAC Project / site 8616
 *
 * All 12 revenue columns are copied verbatim from source:
 *   id, project_name, site_id, amount, invoice_date, month, year,
 *   notes, added_by, created_at, status, section_name
 *
 * Safety guarantees:
 *   - Aborts if source does not return exactly 2 rows for these IDs.
 *   - Aborts if either ID already exists in destination (idempotency guard).
 *   - Aborts if source == destination (identity guard).
 *   - Only these 2 rows are ever touched; no other revenue row is read or written.
 *   - No UPDATE, no DELETE, no schema change, no RLS change.
 *   - Source is never written to.
 *   - Dry-run by default; pass --execute to apply.
 *
 * After this script succeeds, run phase4-04-backfill-revenue-columns.ts
 * (which will now find all 22 source IDs in destination and backfill the
 * 5 columns that patch 09 added post-migration).
 *
 * Usage:
 *   source .env.phase4.local
 *   npx tsx scripts/phase4-05-insert-post-migration-revenue.ts           # dry run
 *   npx tsx scripts/phase4-05-insert-post-migration-revenue.ts --execute  # apply
 */

import { createClient } from '@supabase/supabase-js';

// ── Env ──────────────────────────────────────────────────────────────────────

const SRC_URL = process.env.SOURCE_SUPABASE_URL!;
const SRC_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY!;
const DST_URL = process.env.DEST_SUPABASE_URL!;
const DST_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;

for (const [k, v] of Object.entries({ SOURCE_SUPABASE_URL: SRC_URL, SOURCE_SUPABASE_SERVICE_ROLE_KEY: SRC_KEY, DEST_SUPABASE_URL: DST_URL, DEST_SUPABASE_SERVICE_ROLE_KEY: DST_KEY })) {
  if (!v) { console.error(`Missing env var: ${k}`); process.exit(1); }
}

const EXECUTE = process.argv.includes('--execute');

// ── Identity guard ────────────────────────────────────────────────────────────

const srcRef = SRC_URL.match(/https:\/\/([^.]+)\.supabase/)?.[1] ?? '';
const dstRef = DST_URL.match(/https:\/\/([^.]+)\.supabase/)?.[1] ?? '';

if (!srcRef || !dstRef) { console.error('Could not extract project refs from URLs.'); process.exit(1); }
if (srcRef === dstRef)  { console.error(`ABORT: source and destination are the same project (${srcRef}).`); process.exit(1); }

const EXPECTED_SRC = process.env.EXPECTED_SOURCE_PROJECT_REF ?? 'tltbkjvrhqsxdspdfeqk';
const EXPECTED_DST = process.env.EXPECTED_DEST_PROJECT_REF ?? '';

if (srcRef !== EXPECTED_SRC) {
  console.error(`ABORT: source ref "${srcRef}" does not match expected "${EXPECTED_SRC}".`);
  process.exit(1);
}
if (EXPECTED_DST && dstRef !== EXPECTED_DST) {
  console.error(`ABORT: destination ref "${dstRef}" does not match expected "${EXPECTED_DST}".`);
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const src = createClient(SRC_URL, SRC_KEY);
const dst = createClient(DST_URL, DST_KEY);

// ── Hardcoded target IDs ──────────────────────────────────────────────────────

const TARGET_IDS = [
  'afae4065-bcdd-4c32-ac7a-1a579ffe3916', // TAC Project / site 9644  created 2026-08-05
  '50f353e4-50f6-4fef-9cd3-210b2f2a837e', // TAC Project / site 8616  created 2026-08-05
] as const;

const ALL_COLUMNS = [
  'id', 'project_name', 'site_id', 'amount', 'invoice_date',
  'month', 'year', 'notes', 'added_by', 'created_at', 'status', 'section_name',
] as const;

type RevenueRow = { [K in typeof ALL_COLUMNS[number]]: unknown };

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(60));
  console.log('phase4-05-insert-post-migration-revenue');
  console.log(`  Source:      ${srcRef}  (read-only)`);
  console.log(`  Destination: ${dstRef}`);
  console.log(`  Mode:        ${EXECUTE ? 'EXECUTE — writes will be made' : 'DRY RUN — no writes'}`);
  console.log('═'.repeat(60) + '\n');

  // 1. Schema guard — confirm all 12 columns exist on destination
  console.log('[1/5] Verifying destination schema…');
  const { error: schemaErr } = await (dst.from('revenue') as any)
    .select(ALL_COLUMNS.join(','))
    .limit(0);
  if (schemaErr) {
    console.error(`ABORT: destination revenue schema check failed — ${schemaErr.message}`);
    console.error('Ensure 09_patch_revenue_missing_columns.sql has been run first.');
    process.exit(1);
  }
  console.log('      All 12 columns present in destination. OK.\n');

  // 2. Fetch the 2 target rows from source
  console.log('[2/5] Fetching target rows from source…');
  const { data: srcData, error: srcErr } = await (src.from('revenue') as any)
    .select(ALL_COLUMNS.join(','))
    .in('id', TARGET_IDS);
  if (srcErr) { console.error('Source fetch failed:', srcErr.message); process.exit(1); }

  const srcRows: RevenueRow[] = (srcData ?? []) as RevenueRow[];

  if (srcRows.length !== TARGET_IDS.length) {
    console.error(`ABORT: expected exactly ${TARGET_IDS.length} source rows but got ${srcRows.length}.`);
    if (srcRows.length < TARGET_IDS.length) {
      const found = new Set(srcRows.map((r: any) => r.id));
      const absent = TARGET_IDS.filter(id => !found.has(id));
      absent.forEach(id => console.error(`  Missing in source: ${id}`));
    }
    process.exit(1);
  }
  console.log(`      ${srcRows.length} rows fetched from source. OK.\n`);

  // 3. Verify neither ID exists in destination
  console.log('[3/5] Checking destination for existing IDs…');
  const { data: dstCheck, error: dstCheckErr } = await (dst.from('revenue') as any)
    .select('id,project_name,site_id')
    .in('id', TARGET_IDS);
  if (dstCheckErr) { console.error('Destination check failed:', dstCheckErr.message); process.exit(1); }

  const alreadyPresent = (dstCheck ?? []) as { id: string; project_name: string; site_id: string }[];
  if (alreadyPresent.length > 0) {
    console.error(`ABORT: ${alreadyPresent.length} target ID(s) already exist in destination — will not overwrite.`);
    alreadyPresent.forEach(r => console.error(`  ${r.id}  (${r.project_name}/${r.site_id})`));
    process.exit(1);
  }
  console.log('      Neither ID exists in destination. Safe to insert.\n');

  // 4. Print plan
  console.log('[4/5] Insert plan:\n');
  console.log('  ' + '─'.repeat(56));
  for (const row of srcRows) {
    const r = row as any;
    console.log(`  id:           ${r.id}`);
    console.log(`  project_name: ${r.project_name}`);
    console.log(`  site_id:      ${r.site_id}`);
    console.log(`  amount:       ${r.amount}`);
    console.log(`  month/year:   ${r.month}/${r.year}`);
    console.log(`  invoice_date: ${r.invoice_date}`);
    console.log(`  status:       ${r.status}`);
    console.log(`  section_name: ${r.section_name}`);
    console.log(`  notes:        ${r.notes}`);
    console.log(`  added_by:     ${r.added_by}`);
    console.log(`  created_at:   ${r.created_at}`);
    console.log('');
  }

  if (!EXECUTE) {
    console.log(`DRY RUN complete — ${srcRows.length} row(s) would be inserted.`);
    console.log('Re-run with --execute to apply.\n');
    process.exit(0);
  }

  // 5. Insert
  console.log('[5/5] Inserting rows…');
  let inserted = 0, failed = 0;

  for (const row of srcRows) {
    const r = row as any;
    const payload: Record<string, unknown> = {};
    for (const col of ALL_COLUMNS) payload[col] = r[col] ?? null;

    const { error } = await dst.from('revenue').insert(payload);
    if (error) {
      console.error(`  FAIL  ${r.id}  (${r.project_name}/${r.site_id}): ${error.message}`);
      failed++;
    } else {
      console.log(`  OK    ${r.id}  (${r.project_name}/${r.site_id})`);
      inserted++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`EXECUTE complete: ${inserted} inserted, ${failed} failed.`);

  if (failed > 0) {
    console.error(`\n${failed} row(s) failed. Investigate the error above before re-running.`);
    process.exit(1);
  }

  console.log('\nInsert successful. Run verify-revenue-backfill.ts to confirm, then');
  console.log('re-run phase4-04-backfill-revenue-columns.ts to backfill all 22 rows.\n');
  process.exit(0);
})();
