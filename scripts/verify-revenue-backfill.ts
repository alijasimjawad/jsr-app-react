/**
 * verify-revenue-backfill.ts
 *
 * Read-only verification that the five backfill columns in the destination
 * `revenue` table now match the source for every migrated row.
 *
 * Columns verified:
 *   section_name  text
 *   invoice_date  date
 *   status        text
 *   notes         text
 *   added_by      text
 *
 * Makes ZERO writes. Every operation is a SELECT.
 *
 * Usage:
 *   source .env.phase4.local
 *   npx tsx scripts/verify-revenue-backfill.ts
 *
 * Exit codes:
 *   0 — all migrated rows verified OK
 *   1 — one or more mismatches or errors
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

// ── Identity guard ────────────────────────────────────────────────────────────

const srcRef = SRC_URL.match(/https:\/\/([^.]+)\.supabase/)?.[1] ?? '';
const dstRef = DST_URL.match(/https:\/\/([^.]+)\.supabase/)?.[1] ?? '';

if (!srcRef || !dstRef) { console.error('Could not extract project refs from URLs.'); process.exit(1); }
if (srcRef === dstRef)  { console.error(`ABORT: source and destination are the same project (${srcRef}).`); process.exit(1); }

const EXPECTED_SRC = process.env.EXPECTED_SOURCE_PROJECT_REF ?? 'tltbkjvrhqsxdspdfeqk';
if (srcRef !== EXPECTED_SRC) {
  console.error(`ABORT: source ref "${srcRef}" does not match expected "${EXPECTED_SRC}".`);
  process.exit(1);
}

// ── Clients ───────────────────────────────────────────────────────────────────

const src = createClient(SRC_URL, SRC_KEY);
const dst = createClient(DST_URL, DST_KEY);

// ── Types ─────────────────────────────────────────────────────────────────────

interface RevenueRow {
  id:           string;
  section_name: string | null;
  invoice_date: string | null;
  status:       string | null;
  notes:        string | null;
  added_by:     string | null;
  project_name: string | null;
  site_id:      string | null;
}

const VERIFY_COLS = ['section_name', 'invoice_date', 'status', 'notes', 'added_by'] as const;
type VerifyCol = typeof VERIFY_COLS[number];

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log('\n' + '═'.repeat(60));
  console.log('verify-revenue-backfill  (read-only)');
  console.log(`  Source:      ${srcRef}`);
  console.log(`  Destination: ${dstRef}`);
  console.log('═'.repeat(60) + '\n');

  // 1. Fetch all source revenue rows
  console.log('[1/4] Fetching source revenue rows…');
  const { data: srcData, error: srcErr } = await src
    .from('revenue')
    .select('id,section_name,invoice_date,status,notes,added_by,project_name,site_id')
    .order('created_at', { ascending: true });
  if (srcErr) { console.error('Source fetch failed:', srcErr.message); process.exit(1); }
  const srcRows: RevenueRow[] = (srcData ?? []) as RevenueRow[];
  console.log(`      ${srcRows.length} rows in source.\n`);

  if (srcRows.length === 0) {
    console.log('No source rows — nothing to verify.');
    process.exit(0);
  }

  const srcIds = srcRows.map(r => r.id);
  const srcMap = Object.fromEntries(srcRows.map(r => [r.id, r]));

  // 2. Fetch matching destination rows
  console.log('[2/4] Fetching destination rows (matched by ID)…');
  const { data: dstData, error: dstErr } = await dst
    .from('revenue')
    .select('id,section_name,invoice_date,status,notes,added_by,project_name,site_id')
    .in('id', srcIds);
  if (dstErr) { console.error('Destination fetch failed:', dstErr.message); process.exit(1); }
  const dstRows: RevenueRow[] = (dstData ?? []) as RevenueRow[];
  const dstMap = Object.fromEntries(dstRows.map(r => [r.id, r]));
  console.log(`      ${dstRows.length} destination rows matched out of ${srcRows.length} source rows.\n`);

  // 3. Verify each row
  console.log('[3/4] Verifying backfill columns…\n');

  const mismatches: { id: string; project_name: string | null; site_id: string | null; diffs: string[] }[] = [];
  const missing:    string[] = [];
  let matchCount = 0;

  for (const s of srcRows) {
    const d = dstMap[s.id];
    if (!d) {
      missing.push(s.id);
      continue;
    }

    const diffs: string[] = [];
    for (const col of VERIFY_COLS) {
      const sv = (s[col as VerifyCol]) ?? null;
      const dv = (d[col as VerifyCol]) ?? null;
      if (sv !== dv) {
        diffs.push(`  ${col}: src="${sv}"  dst="${dv}"`);
      }
    }

    if (diffs.length > 0) {
      mismatches.push({ id: s.id, project_name: s.project_name, site_id: s.site_id, diffs });
    } else {
      matchCount++;
    }
  }

  // 4. Report
  console.log('[4/4] Results\n');

  const totalChecked = matchCount + mismatches.length;
  console.log(`  ┌───────────────────────────────────────┐`);
  console.log(`  │ Source rows              : ${String(srcRows.length).padStart(4)}        │`);
  console.log(`  │ Destination rows matched : ${String(dstRows.length).padStart(4)}        │`);
  console.log(`  │ IDs missing in dest      : ${String(missing.length).padStart(4)}        │`);
  console.log(`  │ Rows verified OK         : ${String(matchCount).padStart(4)}        │`);
  console.log(`  │ Rows with mismatches     : ${String(mismatches.length).padStart(4)}        │`);
  console.log(`  └───────────────────────────────────────┘\n`);

  if (missing.length > 0) {
    console.log(`  WARNING — ${missing.length} source ID(s) not found in destination:`);
    missing.forEach(id => {
      const s = srcMap[id];
      console.log(`    ${id}  (${s?.project_name}/${s?.site_id})`);
    });
    console.log('');
  }

  if (mismatches.length > 0) {
    console.log(`  MISMATCHES (${mismatches.length} row(s)):`);
    console.log('  ' + '─'.repeat(56));
    for (const m of mismatches) {
      console.log(`  id: ${m.id}  (${m.project_name}/${m.site_id})`);
      m.diffs.forEach(d => console.log(d));
      console.log('');
    }
    console.log(`FAIL — ${mismatches.length} row(s) still have mismatched backfill columns.`);
    console.log('Re-run phase4-04-backfill-revenue-columns.ts --execute to fix.\n');
    process.exit(1);
  }

  if (missing.length > 0) {
    console.log(`PARTIAL — ${matchCount}/${totalChecked} rows verified OK; ${missing.length} ID(s) absent from destination.\n`);
    process.exit(1);
  }

  console.log(`PASS — all ${matchCount} migrated revenue rows have correct backfill values.\n`);
  process.exit(0);
})();
