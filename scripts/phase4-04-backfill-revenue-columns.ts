/**
 * phase4-04-backfill-revenue-columns.ts
 *
 * One-time backfill of five columns that were absent from the destination
 * `revenue` table when phase4-02 ran (destination only had 7 columns at
 * migration time; patch 09 added the missing 5 afterwards, leaving them NULL
 * for all migrated rows).
 *
 * Columns backfilled (destination only — source is strictly read-only):
 *   section_name  text
 *   invoice_date  date
 *   status        text
 *   notes         text
 *   added_by      text
 *
 * Columns intentionally NOT touched:
 *   id, project_name, site_id, amount, month, year, created_at
 *
 * Matching: strictly by revenue.id (preserved verbatim during phase4-02).
 * Only destination rows whose IDs exist in the source are eligible —
 * rows created after migration are never touched.
 *
 * Idempotent: re-running after a partial failure is safe. Each row is
 * classified as NEEDS_UPDATE or ALREADY_CORRECT on every run; only
 * NEEDS_UPDATE rows are written.
 *
 * Safety:
 *   - No INSERT, no DELETE, no schema change, no RLS change.
 *   - Source project is never written to.
 *   - Identity guard rejects runs where source == destination.
 *   - Dry run by default; pass --execute to apply writes.
 *
 * Usage:
 *   source .env.phase4.local
 *   npx tsx scripts/phase4-04-backfill-revenue-columns.ts           # dry run
 *   npx tsx scripts/phase4-04-backfill-revenue-columns.ts --execute  # apply
 */

import { createClient } from '@supabase/supabase-js';

// ── Env ──────────────────────────────────────────────────────────────────────

const SRC_URL  = process.env.SOURCE_SUPABASE_URL!;
const SRC_KEY  = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY!;
const DST_URL  = process.env.DEST_SUPABASE_URL!;
const DST_KEY  = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;

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
const EXPECTED_DST = process.env.EXPECTED_DEST_PROJECT_REF   ?? '';

if (srcRef !== EXPECTED_SRC) {
  console.error(`ABORT: source ref "${srcRef}" does not match expected "${EXPECTED_SRC}". Check .env.phase4.local.`);
  process.exit(1);
}
if (EXPECTED_DST && dstRef !== EXPECTED_DST) {
  console.error(`ABORT: destination ref "${dstRef}" does not match expected "${EXPECTED_DST}". Check .env.phase4.local.`);
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const src = createClient(SRC_URL, SRC_KEY);
const dst = createClient(DST_URL, DST_KEY);

// ── Types ─────────────────────────────────────────────────────────────────────

interface SrcRow {
  id: string;
  section_name: string | null;
  invoice_date: string | null;
  status:       string | null;
  notes:        string | null;
  added_by:     string | null;
  // for display only
  project_name: string | null;
  site_id:      string | null;
}

interface DstRow {
  id: string;
  section_name: string | null;
  invoice_date: string | null;
  status:       string | null;
  notes:        string | null;
  added_by:     string | null;
  project_name: string | null;
  site_id:      string | null;
}

type RowAction = 'NEEDS_UPDATE' | 'ALREADY_CORRECT' | 'MISSING_IN_DST';

interface Plan {
  id: string;
  action: RowAction;
  src: SrcRow;
  dst: DstRow | null;
  diff: string[];  // human-readable list of columns that differ
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BACKFILL_COLS = ['section_name', 'invoice_date', 'status', 'notes', 'added_by'] as const;
type BackfillCol = typeof BACKFILL_COLS[number];

function rowsDiffer(s: SrcRow, d: DstRow): { differs: boolean; cols: string[] } {
  const cols: string[] = [];
  for (const col of BACKFILL_COLS) {
    const sv = s[col] ?? null;
    const dv = d[col] ?? null;
    if (sv !== dv) cols.push(`${col}: "${dv}" → "${sv}"`);
  }
  return { differs: cols.length > 0, cols };
}

function buildPayload(s: SrcRow): Record<BackfillCol, string | null> {
  return {
    section_name: s.section_name ?? null,
    invoice_date: s.invoice_date ?? null,
    status:       s.status       ?? null,
    notes:        s.notes        ?? null,
    added_by:     s.added_by     ?? null,
  };
}

// ── Schema guard ──────────────────────────────────────────────────────────────

async function verifySchemas(): Promise<void> {
  // Source: verify all 5 backfill columns exist
  const { error: srcErr } = await (src.from('revenue') as any)
    .select('id,section_name,invoice_date,status,notes,added_by').limit(0);
  if (srcErr) {
    console.error(`ABORT: source revenue schema check failed — ${srcErr.message}`);
    process.exit(1);
  }
  // Destination: same check
  const { error: dstErr } = await (dst.from('revenue') as any)
    .select('id,section_name,invoice_date,status,notes,added_by').limit(0);
  if (dstErr) {
    console.error(`ABORT: destination revenue schema check failed — ${dstErr.message}`);
    console.error('Ensure 09_patch_revenue_missing_columns.sql has been run first.');
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(60));
  console.log('phase4-04-backfill-revenue-columns');
  console.log(`  Source:      ${srcRef}  (read-only)`);
  console.log(`  Destination: ${dstRef}`);
  console.log(`  Mode:        ${EXECUTE ? 'EXECUTE — writes will be made' : 'DRY RUN — no writes'}`);
  console.log('═'.repeat(60) + '\n');

  // 1. Schema guard
  console.log('[1/5] Verifying schemas…');
  await verifySchemas();
  console.log('      Source and destination both have all 5 backfill columns. OK.\n');

  // 2. Fetch all source revenue rows
  console.log('[2/5] Fetching source revenue rows…');
  const { data: srcData, error: srcFetchErr } = await src
    .from('revenue')
    .select('id,section_name,invoice_date,status,notes,added_by,project_name,site_id')
    .order('created_at', { ascending: true });
  if (srcFetchErr) { console.error('Source fetch failed:', srcFetchErr.message); process.exit(1); }
  const srcRows: SrcRow[] = (srcData ?? []) as SrcRow[];
  console.log(`      ${srcRows.length} rows in source.\n`);

  if (srcRows.length === 0) {
    console.log('No source rows found. Nothing to do.');
    process.exit(0);
  }

  const srcIds = srcRows.map(r => r.id);
  const srcMap = Object.fromEntries(srcRows.map(r => [r.id, r]));

  // 3. Fetch matching destination rows by ID
  console.log('[3/5] Fetching destination rows (matched by ID)…');
  const { data: dstData, error: dstFetchErr } = await dst
    .from('revenue')
    .select('id,section_name,invoice_date,status,notes,added_by,project_name,site_id')
    .in('id', srcIds);
  if (dstFetchErr) { console.error('Destination fetch failed:', dstFetchErr.message); process.exit(1); }
  const dstRows: DstRow[] = (dstData ?? []) as DstRow[];
  const dstMap = Object.fromEntries(dstRows.map(r => [r.id, r]));

  const matchedCount  = dstRows.length;
  const missingInDst  = srcIds.filter(id => !dstMap[id]);
  console.log(`      ${matchedCount} destination rows matched out of ${srcRows.length} source rows.`);
  if (missingInDst.length > 0) {
    console.log(`\n  WARNING: ${missingInDst.length} source IDs not found in destination:`);
    missingInDst.forEach(id => console.log(`    ${id}  (${srcMap[id]?.project_name}/${srcMap[id]?.site_id})`));
  }
  console.log('');

  // 4. Classify each matched row
  console.log('[4/5] Classifying rows…');
  const plans: Plan[] = [];

  for (const s of srcRows) {
    const d = dstMap[s.id] ?? null;
    if (!d) {
      plans.push({ id: s.id, action: 'MISSING_IN_DST', src: s, dst: null, diff: [] });
      continue;
    }
    const { differs, cols } = rowsDiffer(s, d);
    plans.push({
      id: s.id,
      action: differs ? 'NEEDS_UPDATE' : 'ALREADY_CORRECT',
      src: s, dst: d, diff: cols,
    });
  }

  const needsUpdate    = plans.filter(p => p.action === 'NEEDS_UPDATE');
  const alreadyCorrect = plans.filter(p => p.action === 'ALREADY_CORRECT');
  const missingDst     = plans.filter(p => p.action === 'MISSING_IN_DST');

  console.log(`\n  ┌─────────────────────────────────────┐`);
  console.log(`  │ Source rows found       : ${String(srcRows.length).padStart(4)}      │`);
  console.log(`  │ Destination rows matched: ${String(matchedCount).padStart(4)}      │`);
  console.log(`  │ Rows needing backfill   : ${String(needsUpdate.length).padStart(4)}      │`);
  console.log(`  │ Rows already correct    : ${String(alreadyCorrect.length).padStart(4)}      │`);
  console.log(`  │ IDs missing in dest     : ${String(missingDst.length).padStart(4)}      │`);
  console.log(`  └─────────────────────────────────────┘\n`);

  // 5. Sample before/after for first 5 rows needing update
  if (needsUpdate.length > 0) {
    console.log('  Sample — rows needing backfill (up to 5):');
    console.log('  ' + '─'.repeat(56));
    for (const p of needsUpdate.slice(0, 5)) {
      console.log(`  id: ${p.id}`);
      console.log(`    project_name: ${p.src.project_name}  site_id: ${p.src.site_id}`);
      p.diff.forEach(d => console.log(`    ${d}`));
      console.log('');
    }
  }

  if (alreadyCorrect.length > 0 && needsUpdate.length === 0) {
    console.log('  All matched rows already have correct values — nothing to write.');
  }

  // 6. Abort checks
  if (missingDst.length > 0 && EXECUTE) {
    console.error(`ABORT: ${missingDst.length} source IDs are missing in destination. Investigate before running --execute.`);
    process.exit(1);
  }

  if (needsUpdate.length === 0) {
    console.log(`${EXECUTE ? 'EXECUTE' : 'DRY RUN'} complete — no updates needed.`);
    process.exit(0);
  }

  // 7. Execute or stop
  if (!EXECUTE) {
    console.log(`DRY RUN complete — ${needsUpdate.length} row(s) would be updated.`);
    console.log('Re-run with --execute to apply.\n');
    process.exit(0);
  }

  // ── Execute path ─────────────────────────────────────────────────────────

  console.log('[5/5] Applying backfill…');
  let updated = 0, failed = 0;

  for (const p of needsUpdate) {
    const payload = buildPayload(p.src);
    const { error } = await dst
      .from('revenue')
      .update(payload)
      .eq('id', p.id);
    if (error) {
      console.error(`  FAIL  ${p.id}  ${p.src.project_name}/${p.src.site_id}: ${error.message}`);
      failed++;
    } else {
      console.log(`  OK    ${p.id}  ${p.src.project_name}/${p.src.site_id}`);
      updated++;
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`EXECUTE complete: ${updated} updated, ${failed} failed, ${alreadyCorrect.length} skipped (already correct).`);

  if (failed > 0) {
    console.error(`\n${failed} row(s) failed. Re-run with --execute to retry — already-updated rows will be skipped.`);
    process.exit(1);
  }

  console.log('\nBackfill successful. Run verify-revenue-backfill.ts to confirm.\n');
  process.exit(0);
})();
