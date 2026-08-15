/**
 * phase4-09-delete-staging-dup-rows.ts — Targeted staging duplicate cleanup
 *
 * Deletes exactly 4 staging-only rows from public.rows in the JSR React staging
 * destination database. These rows are duplicates of production rows in the
 * ipt/tdd section (UI label: FTK), created during the phase4-02 migration run
 * on 2026-08-04 with comma-formatted site IDs ("9,950.", "9,963.", "9,359.", "890.").
 *
 * ROWS TO DELETE (staging-only, never existed in old JSR production):
 *   0f456962-5c16-4ab7-b294-16ff7e66df3a  site=9950  (dup of 165fee17)
 *   f55d0926-684f-4dfa-900f-9b5dea4da235  site=9963  (dup of 5d1e05c7)
 *   edc4ef8f-ea70-48be-9bd1-f7a61165ecfa  site=9359  (dup of eee796c2)
 *   839d73f5-adf5-4c90-9b2a-2dfa0bc0d829  site=890   (dup of 5c13b49a)
 *
 * USAGE:
 *   source .env.phase4.local
 *   npx tsx scripts/phase4-09-delete-staging-dup-rows.ts           # dry run (default)
 *   npx tsx scripts/phase4-09-delete-staging-dup-rows.ts --execute # delete
 *
 * SAFETY GUARANTEES:
 *   - DRY RUN by default — prints what would be deleted, deletes nothing.
 *   - --execute required for any deletes.
 *   - Old JSR production is NEVER written to or queried for writes.
 *   - All 6 pre-flight checks must pass before any delete is attempted.
 *   - Deletes by exact UUID only — no wildcard, no range, no section-wide delete.
 *   - row_order of surviving rows is never modified.
 *   - RLS is never modified.
 *   - Post-deletion verification runs automatically after execute.
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

// ── 2. Env vars (dest for writes; source for provenance checks) ───────────────
const DST_URL = process.env.DEST_SUPABASE_URL;
const DST_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const SRC_URL = process.env.SOURCE_SUPABASE_URL;
const SRC_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const EXP_DST = process.env.EXPECTED_DEST_PROJECT_REF;

for (const [k, v] of Object.entries({
  DEST_SUPABASE_URL: DST_URL,
  DEST_SUPABASE_SERVICE_ROLE_KEY: DST_KEY,
  SOURCE_SUPABASE_URL: SRC_URL,
  SOURCE_SUPABASE_SERVICE_ROLE_KEY: SRC_KEY,
})) {
  if (!v) { console.error(`ABORT: missing env var ${k}`); process.exit(1); }
}

function extractRef(url: string): string {
  return url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? '';
}
const dstRef = extractRef(DST_URL!);
const srcRef = extractRef(SRC_URL!);

const OLD_JSR_REF = 'tltbkjvrhqsxdspdfeqk';
const DEST_REF    = 'qaqxoakjnyivuegsopha';

if (!dstRef)                        { console.error('ABORT: cannot extract dest project ref.'); process.exit(1); }
if (dstRef === srcRef)              { console.error('ABORT: source and dest are the same project.'); process.exit(1); }
if (dstRef !== DEST_REF)            { console.error(`ABORT: dest "${dstRef}" ≠ expected "${DEST_REF}".`); process.exit(1); }
if (srcRef !== OLD_JSR_REF)         { console.error(`ABORT: source "${srcRef}" ≠ expected old-JSR "${OLD_JSR_REF}".`); process.exit(1); }
if (EXP_DST && dstRef !== EXP_DST) { console.error(`ABORT: dest "${dstRef}" ≠ EXPECTED_DEST_PROJECT_REF "${EXP_DST}".`); process.exit(1); }

// ── 3. Hardcoded targets (set once, never dynamic) ────────────────────────────

const TARGET_SECTION_ID = '3d88c00c-9309-40c5-96d8-04af7b514c31'; // ipt/tdd  label=FTK

/** Staging-only rows to delete. Must not exist in old JSR production. */
const STAGING_DELETE_IDS: ReadonlySet<string> = new Set([
  '0f456962-5c16-4ab7-b294-16ff7e66df3a', // site 9,950.
  'f55d0926-684f-4dfa-900f-9b5dea4da235', // site 9,963.
  'edc4ef8f-ea70-48be-9bd1-f7a61165ecfa', // site 9,359.
  '839d73f5-adf5-4c90-9b2a-2dfa0bc0d829', // site 890.
]);

/** Production rows that must survive and must remain duplicate-free after cleanup. */
const PRODUCTION_KEEP_IDS: ReadonlySet<string> = new Set([
  '165fee17-a18f-4407-8e4c-d9bbbd81d7cd', // site 9950
  '5d1e05c7-6495-4a22-9e7b-be7e4e49830b', // site 9963
  'eee796c2-58f3-4a39-89cd-fffe6178ddf5', // site 9359
  '5c13b49a-c7ab-4fe6-a72e-ddb2aca76841', // site 890
]);

/** Maps each staging delete ID → the production ID it duplicates. */
const STAGING_TO_PROD: ReadonlyMap<string, string> = new Map([
  ['0f456962-5c16-4ab7-b294-16ff7e66df3a', '165fee17-a18f-4407-8e4c-d9bbbd81d7cd'],
  ['f55d0926-684f-4dfa-900f-9b5dea4da235', '5d1e05c7-6495-4a22-9e7b-be7e4e49830b'],
  ['edc4ef8f-ea70-48be-9bd1-f7a61165ecfa', 'eee796c2-58f3-4a39-89cd-fffe6178ddf5'],
  ['839d73f5-adf5-4c90-9b2a-2dfa0bc0d829', '5c13b49a-c7ab-4fe6-a72e-ddb2aca76841'],
]);

// ── 4. Helpers ────────────────────────────────────────────────────────────────

function normalizeSiteId(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().replace(/,/g, '').replace(/\.+$/, '').trim();
}

function getSiteId(data: Record<string, unknown>): unknown {
  return data['Site ID'] ?? data['site_id'] ?? data['siteId'] ?? null;
}

// ── 5. Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const LINE = '═'.repeat(100);
  const line = '─'.repeat(100);
  const MODE = DRY_RUN ? 'DRY RUN — no deletes' : '!! EXECUTE MODE — DELETING FROM DESTINATION !!';

  console.log(`\n${LINE}`);
  console.log(`  Phase 4.9 — Staging Duplicate Row Cleanup  [${MODE}]`);
  console.log(LINE);
  console.log(`  Destination (JSR React staging): ${dstRef}`);
  console.log(`  Source (old JSR production)    : ${srcRef}  (read-only, provenance check only)`);
  console.log(`  Target section                 : ${TARGET_SECTION_ID}  (ipt/tdd, label=FTK)`);
  console.log(`  Rows to delete                 : ${STAGING_DELETE_IDS.size}`);
  console.log(`  Run at                         : ${new Date().toISOString()}`);
  if (DRY_RUN) console.log('  To delete, re-run with: --execute\n');
  else         console.log('  Deleting from destination database.\n');

  const dst = createClient(DST_URL!, DST_KEY!, { auth: { persistSession: false } });
  const src = createClient(SRC_URL!, SRC_KEY!, { auth: { persistSession: false } });

  // ── Pre-flight checks ─────────────────────────────────────────────────────────
  console.log(`${LINE}`);
  console.log('  PRE-FLIGHT VERIFICATION (6 checks — all must pass)');
  console.log(LINE);

  let allPass = true;
  function check(label: string, pass: boolean, detail: string): void {
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${label}`);
    if (detail) console.log(`         ${detail}`);
    if (!pass) allPass = false;
  }

  // Fetch all 4 target rows from dest
  const { data: stagingRows, error: fetchErr } = await dst
    .from('rows')
    .select('id, section_id, data, row_order, created_at, updated_at')
    .in('id', [...STAGING_DELETE_IDS]);

  if (fetchErr) {
    console.error(`  ABORT: failed to fetch staging rows: ${fetchErr.message}`);
    process.exit(1);
  }

  const foundIds = new Set((stagingRows ?? []).map((r: { id: string }) => r.id));
  const stagingByIdMap = new Map(
    (stagingRows ?? []).map((r: { id: string; section_id: string; data: Record<string, unknown>; row_order: number | null; created_at: string | null }) =>
      [r.id, r]),
  );

  // CHECK 1: All 4 target IDs exist in dest
  const missingFromDest = [...STAGING_DELETE_IDS].filter(id => !foundIds.has(id));
  check(
    'All 4 staging rows exist in destination',
    missingFromDest.length === 0,
    missingFromDest.length === 0
      ? `Found all 4: ${[...STAGING_DELETE_IDS].join(', ')}`
      : `Missing from dest: ${missingFromDest.join(', ')}`,
  );

  // CHECK 2: All 4 belong to the expected section
  const wrongSection = (stagingRows ?? []).filter(
    (r: { id: string; section_id: string }) => r.section_id !== TARGET_SECTION_ID,
  );
  check(
    `All 4 rows belong to section ${TARGET_SECTION_ID}`,
    wrongSection.length === 0,
    wrongSection.length === 0
      ? 'Section ID matches for all rows.'
      : `Wrong section: ${wrongSection.map((r: { id: string; section_id: string }) => `${r.id} → ${r.section_id}`).join(', ')}`,
  );

  // CHECK 3: None of the 4 IDs exist in old JSR production
  const { data: srcCheck, error: srcErr } = await src
    .from('rows')
    .select('id')
    .in('id', [...STAGING_DELETE_IDS]);

  if (srcErr) {
    console.error(`  ABORT: failed to query source for provenance check: ${srcErr.message}`);
    process.exit(1);
  }

  const foundInProd = (srcCheck ?? []).map((r: { id: string }) => r.id);
  check(
    'None of the 4 IDs exist in old JSR production',
    foundInProd.length === 0,
    foundInProd.length === 0
      ? 'Confirmed staging-only — none present in source.'
      : `FOUND IN PRODUCTION (must not delete): ${foundInProd.join(', ')}`,
  );

  // CHECK 4: All 4 production counterpart rows exist in dest
  const { data: prodRows, error: prodErr } = await dst
    .from('rows')
    .select('id, section_id, data, row_order, created_at')
    .in('id', [...PRODUCTION_KEEP_IDS]);

  if (prodErr) {
    console.error(`  ABORT: failed to fetch production rows: ${prodErr.message}`);
    process.exit(1);
  }

  const foundProdIds = new Set((prodRows ?? []).map((r: { id: string }) => r.id));
  const missingProd = [...PRODUCTION_KEEP_IDS].filter(id => !foundProdIds.has(id));
  check(
    'All 4 production counterpart rows exist in destination',
    missingProd.length === 0,
    missingProd.length === 0
      ? `Found all 4 production rows.`
      : `Missing production rows: ${missingProd.join(', ')}`,
  );

  // CHECK 5: Each staging row's normalized Site ID matches its production counterpart
  const prodByIdMap = new Map(
    (prodRows ?? []).map((r: { id: string; data: Record<string, unknown> }) => [r.id, r]),
  );

  let siteIdMatchFail = false;
  const siteIdMatchDetails: string[] = [];
  for (const [stagId, prodId] of STAGING_TO_PROD) {
    const stagRow = stagingByIdMap.get(stagId);
    const prodRow = prodByIdMap.get(prodId);
    if (!stagRow || !prodRow) {
      siteIdMatchDetails.push(`  SKIP ${stagId} (row not fetched)`);
      continue;
    }
    const stagNorm = normalizeSiteId(getSiteId(stagRow.data ?? {}));
    const prodNorm = normalizeSiteId(getSiteId(prodRow.data ?? {}));
    if (stagNorm !== prodNorm || !stagNorm) {
      siteIdMatchFail = true;
      siteIdMatchDetails.push(`  MISMATCH ${stagId}: stag="${stagNorm}" prod="${prodNorm}"`);
    } else {
      siteIdMatchDetails.push(`  MATCH ${stagId} ↔ ${prodId}  site=${stagNorm}`);
    }
  }
  check(
    'Each staging row shares a normalized Site ID with its production counterpart',
    !siteIdMatchFail,
    siteIdMatchDetails.join('\n         '),
  );

  // CHECK 6: Staging rows have no unique fields not present in the production row
  let uniqueDataFail = false;
  const uniqueDataDetails: string[] = [];
  for (const [stagId, prodId] of STAGING_TO_PROD) {
    const stagRow = stagingByIdMap.get(stagId);
    const prodRow = prodByIdMap.get(prodId);
    if (!stagRow || !prodRow) continue;

    const stagData = stagRow.data ?? {};
    const prodData = prodRow.data ?? {};
    const stagKeys = Object.keys(stagData);
    // A field is "unique" if its value in staging is non-null/non-empty AND different from prod AND prod doesn't have it
    const uniqueFields: string[] = [];
    for (const key of stagKeys) {
      if (key === 'Site ID' || key === 'site_id' || key === 'siteId') continue; // site ID diff is expected
      const sv = stagData[key];
      const pv = prodData[key];
      const svStr = JSON.stringify(sv ?? null);
      const pvStr = JSON.stringify(pv ?? null);
      if (svStr !== pvStr && sv !== null && sv !== '' && sv !== undefined) {
        uniqueFields.push(`${key}: stag=${svStr} prod=${pvStr}`);
      }
    }
    if (uniqueFields.length > 0) {
      uniqueDataFail = true;
      uniqueDataDetails.push(`  ${stagId} has unique fields: ${uniqueFields.join('; ')}`);
    } else {
      uniqueDataDetails.push(`  ${stagId}: no unique business data — safe to delete`);
    }
  }
  check(
    'Staging rows contain no unique business data not present in production row',
    !uniqueDataFail,
    uniqueDataDetails.join('\n         '),
  );

  // ── Pre-flight result ─────────────────────────────────────────────────────────
  console.log();
  if (!allPass) {
    console.log(`  !! PRE-FLIGHT FAILED — aborting. No rows were deleted.`);
    console.log(`${LINE}\n`);
    process.exit(1);
  }
  console.log(`  PRE-FLIGHT PASSED — all 6 checks passed.\n`);

  // ── Report what will be deleted ───────────────────────────────────────────────
  console.log(`${LINE}`);
  console.log(`  ROWS TO ${DRY_RUN ? 'DELETE (dry run)' : 'DELETE (executing)'}`);
  console.log(LINE);

  for (const [stagId, prodId] of STAGING_TO_PROD) {
    const stagRow = stagingByIdMap.get(stagId);
    const prodRow = prodByIdMap.get(prodId);
    const stagSite = normalizeSiteId(getSiteId(stagRow?.data ?? {}));
    const rawStagSite = getSiteId(stagRow?.data ?? {});

    console.log(`\n  DELETE  ${stagId}`);
    console.log(`          Raw Site ID : ${JSON.stringify(rawStagSite)}`);
    console.log(`          Norm Site ID: ${stagSite}`);
    console.log(`          row_order   : ${stagRow?.row_order ?? '?'}`);
    console.log(`          created_at  : ${stagRow?.created_at ?? '?'}`);
    console.log(`          data        : ${JSON.stringify(stagRow?.data ?? {})}`);
    console.log(`          Provenance  : STAGING-ONLY (not in old JSR production)`);
    console.log(`  KEEP    ${prodId}`);
    console.log(`          Raw Site ID : ${JSON.stringify(getSiteId(prodRow?.data ?? {}))}`);
    console.log(`          row_order   : ${(prodRow as { row_order?: number | null } | undefined)?.row_order ?? '?'}`);
    console.log(`          created_at  : ${(prodRow as { created_at?: string | null } | undefined)?.created_at ?? '?'}`);
    console.log(`          Provenance  : PRODUCTION (migrated from old JSR section b393a48e)`);
  }

  if (DRY_RUN) {
    console.log(`\n${LINE}`);
    console.log('  DRY RUN — nothing deleted. Re-run with --execute to apply.');
    console.log(`${LINE}\n`);
    return;
  }

  // ── Execute deletes ───────────────────────────────────────────────────────────
  console.log(`\n${LINE}`);
  console.log('  EXECUTING DELETES');
  console.log(LINE);

  let deleteCount = 0;
  for (const stagId of STAGING_DELETE_IDS) {
    process.stdout.write(`  Deleting ${stagId}... `);
    const { error } = await dst
      .from('rows')
      .delete()
      .eq('id', stagId)
      .eq('section_id', TARGET_SECTION_ID); // double-guard: section must also match

    if (error) {
      console.log('FAIL');
      console.error(`  ABORT: delete failed for ${stagId}: ${error.message}`);
      process.exit(1);
    }
    console.log('OK');
    deleteCount++;
  }
  console.log(`\n  ${deleteCount} row(s) deleted.\n`);

  // ── Post-deletion verification ────────────────────────────────────────────────
  console.log(`${LINE}`);
  console.log('  POST-DELETION VERIFICATION');
  console.log(LINE);

  let postPass = true;
  function postCheck(label: string, pass: boolean, detail: string): void {
    const status = pass ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${label}`);
    if (detail) console.log(`         ${detail}`);
    if (!pass) postPass = false;
  }

  // POST-CHECK 1: Deleted rows no longer exist in dest
  const { data: deletedStillThere } = await dst
    .from('rows')
    .select('id')
    .in('id', [...STAGING_DELETE_IDS]);

  const stillPresent = (deletedStillThere ?? []).map((r: { id: string }) => r.id);
  postCheck(
    'All 4 staging rows are gone from destination',
    stillPresent.length === 0,
    stillPresent.length === 0
      ? 'Confirmed — none of the 4 deleted IDs remain.'
      : `Still present: ${stillPresent.join(', ')}`,
  );

  // POST-CHECK 2: All 4 production rows still exist
  const { data: prodStillThere } = await dst
    .from('rows')
    .select('id')
    .in('id', [...PRODUCTION_KEEP_IDS]);

  const prodStillFoundIds = new Set((prodStillThere ?? []).map((r: { id: string }) => r.id));
  const missingProdAfter = [...PRODUCTION_KEEP_IDS].filter(id => !prodStillFoundIds.has(id));
  postCheck(
    'All 4 production rows still exist in destination',
    missingProdAfter.length === 0,
    missingProdAfter.length === 0
      ? 'Confirmed — all 4 production rows intact.'
      : `MISSING production rows: ${missingProdAfter.join(', ')}`,
  );

  // POST-CHECK 3: No duplicate normalized Site IDs remain in ipt/tdd
  const { data: remainingRows } = await dst
    .from('rows')
    .select('id, data, row_order')
    .eq('section_id', TARGET_SECTION_ID);

  const byNorm = new Map<string, string[]>();
  for (const row of (remainingRows ?? []) as { id: string; data: Record<string, unknown> }[]) {
    const norm = normalizeSiteId(getSiteId(row.data ?? {}));
    if (!norm) continue;
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm)!.push(row.id);
  }
  const dupNorms = [...byNorm.entries()].filter(([, ids]) => ids.length > 1);
  postCheck(
    'Zero logical duplicate Site IDs remain in ipt/tdd (label=FTK)',
    dupNorms.length === 0,
    dupNorms.length === 0
      ? `${remainingRows?.length ?? 0} rows remain, all with unique normalized Site IDs.`
      : `Remaining duplicates: ${dupNorms.map(([n, ids]) => `site=${n}: ${ids.join(', ')}`).join('; ')}`,
  );

  // POST-CHECK 4: Print surviving rows in section
  console.log(`\n  Remaining rows in section ${TARGET_SECTION_ID} (ipt/tdd, label=FTK):`);
  for (const row of (remainingRows ?? []).sort(
    (a: { row_order: number | null }, b: { row_order: number | null }) =>
      (a.row_order ?? 999) - (b.row_order ?? 999),
  ) as { id: string; data: Record<string, unknown>; row_order: number | null }[]) {
    const norm = normalizeSiteId(getSiteId(row.data ?? {}));
    const isProd = PRODUCTION_KEEP_IDS.has(row.id) ? ' [PRODUCTION]' : ' [staging]';
    console.log(`    row_order=${row.row_order}  id=${row.id}  site=${norm}${isProd}`);
  }

  console.log(`\n${LINE}`);
  if (postPass) {
    console.log('  POST-DELETION VERIFICATION PASSED.');
    console.log('  The ipt/tdd (FTK) section now has 0 duplicate Site ID groups.');
    console.log('  All 4 production rows are intact. row_order was not modified.');
  } else {
    console.log('  !! POST-DELETION VERIFICATION FAILED — review errors above.');
  }
  console.log(`${LINE}\n`);

  if (!postPass) process.exit(1);
}

main().catch(err => {
  console.error('\nFATAL:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
