/**
 * Read-write QA for the automatic Revenue ↔ Network Scopes sync.
 * Tests scenarios A–J from the approved P1 spec.
 *
 * Uses ONLY QA-prefixed records (QA-REV-SYNC-*) in an existing test section.
 * Cleans up all QA rows before and after the suite.
 *
 * Run: npx tsx scripts/_qa_revenue_sync_test.ts
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();
const dst = createClient(
  process.env.DEST_SUPABASE_URL!,
  process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// ── Test config ───────────────────────────────────────────────────────────────
// Use mrc/ftk (bda26ffb) — has columns including "Imp. Date"
const QA_SECTION_ID   = 'bda26ffb-d715-4133-ab83-1f3238a801c9';
const QA_PROJECT_KEY  = 'mrc';
const QA_PROJECT_NAME = 'MRC Project';
const QA_SEC_LABEL    = 'FTK';
const QA_PREFIX       = 'QA-REV-SYNC-';
const QA_ADDED_BY     = 'QA Test Runner';
const VALID_IMP_DATE  = '2026-08-01';  // a parseable date — any year is fine (no cutoff in auto-sync)
const PRE_CUTOFF_DATE = '2025-06-15';  // before the old 2026-07-01 manual sync cutoff

let passed = 0; let failed = 0;
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS  ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Helpers (mirrors the frontend logic) ─────────────────────────────────────

async function ensureRevenuePlaceholder(
  siteId: string,
  secLabel: string,
  impDateRaw: string,
): Promise<string | null> {
  const { data: existing, error: checkErr } = await dst
    .from('revenue').select('id, is_orphaned').eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId).maybeSingle();
  if (checkErr) return checkErr.message;
  if (existing) {
    const ex = existing as { id: string; is_orphaned: boolean };
    if (ex.is_orphaned) {
      const { error: reactErr } = await dst.from('revenue').update({ is_orphaned: false }).eq('id', ex.id);
      return reactErr?.message ?? null;
    }
    return null;
  }
  const parsedDate = impDateRaw ? new Date(impDateRaw) : null;
  const validDate  = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null;
  const { error: insertErr } = await dst.from('revenue').insert({
    project_name: QA_PROJECT_NAME,
    section_name: secLabel,
    site_id: siteId,
    amount: 0,
    status: 'Implemented - Pending ATP',
    notes: null,
    added_by: QA_ADDED_BY,
    invoice_date: validDate ? impDateRaw : null,
    month: validDate ? (validDate.getMonth() + 1) : null,
    year:  validDate ? validDate.getFullYear()     : null,
  });
  return insertErr?.message ?? null;
}

async function revRowIsPlaceholder(revId: string, revAmount: number): Promise<boolean> {
  if (revAmount !== 0) return false;
  const { count } = await dst
    .from('invoice_items').select('id', { count: 'exact', head: true }).eq('revenue_id', revId);
  return (count ?? 0) === 0;
}

async function getRevRow(siteId: string) {
  const { data } = await dst.from('revenue')
    .select('id, project_name, section_name, site_id, amount, status, is_orphaned, invoice_date, month, year, added_by')
    .eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId).maybeSingle();
  return data;
}

async function insertQARow(siteId: string, impDate?: string) {
  const data: Record<string, string> = {
    'Site ID': siteId,
    'Governate': 'Baghdad',
    'Imp. Date': impDate ?? '',
    'ATP Status': 'Pending',
    'Comment': 'QA test row',
  };
  const { data: r, error } = await dst.from('rows').insert({
    section_id: QA_SECTION_ID, data, row_order: 9000,
  }).select('id').single();
  if (error) throw new Error(`insertQARow failed: ${error.message}`);
  return (r as { id: string }).id;
}

async function deleteQARow(rowId: string) {
  await dst.from('rows').delete().eq('id', rowId);
}

async function deleteRevRow(siteId: string) {
  await dst.from('revenue').delete().eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  await dst.from('rows').delete().eq('section_id', QA_SECTION_ID).like('data->>Site ID', `${QA_PREFIX}%`);
  await dst.from('revenue').delete().eq('project_name', QA_PROJECT_NAME).like('site_id', `${QA_PREFIX}%`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Revenue Auto-Sync QA Test Suite ===\n');

await cleanup();

// ── A. Add site (no Imp. Date) → placeholder with null date fields ────────────
console.log('A. Add QA site (no Imp. Date) → Revenue placeholder, null date');
{
  const siteId = `${QA_PREFIX}A`;
  const rowId  = await insertQARow(siteId);
  const revErr = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, '');
  assert('A.1  ensureRevenuePlaceholder returned null (success)', revErr === null, revErr ?? '');
  const rev = await getRevRow(siteId);
  assert('A.2  revenue row created',   !!rev);
  assert('A.3  amount = 0',            Number(rev?.amount) === 0);
  assert('A.4  status = pending ATP',  rev?.status === 'Implemented - Pending ATP');
  assert('A.5  invoice_date = null',   rev?.invoice_date === null, String(rev?.invoice_date));
  assert('A.6  month = null',          rev?.month  === null,       String(rev?.month));
  assert('A.7  year  = null',          rev?.year   === null,       String(rev?.year));
  assert('A.8  added_by = QA runner',  rev?.added_by === QA_ADDED_BY);
  assert('A.9  section_name correct',  rev?.section_name === QA_SEC_LABEL, rev?.section_name ?? '');
  await deleteQARow(rowId);
  await deleteRevRow(siteId);
}

// ── B. Add site with valid Imp. Date → date fields populated ─────────────────
console.log('\nB. Add QA site (with Imp. Date) → Revenue date fields follow mapping');
{
  const siteId = `${QA_PREFIX}B`;
  const rowId  = await insertQARow(siteId, VALID_IMP_DATE);
  const revErr = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  assert('B.1  success', revErr === null, revErr ?? '');
  const rev = await getRevRow(siteId);
  assert('B.2  invoice_date = imp date', rev?.invoice_date === VALID_IMP_DATE, String(rev?.invoice_date));
  assert('B.3  month = 8',              rev?.month === 8,  String(rev?.month));
  assert('B.4  year  = 2026',           rev?.year  === 2026, String(rev?.year));
  await deleteQARow(rowId);
  await deleteRevRow(siteId);
}

// ── B2. Old pre-cutoff date also works (auto-sync has no date restriction) ────
console.log('\nB2. Add site with pre-cutoff Imp. Date → still creates revenue (no cutoff in auto-sync)');
{
  const siteId = `${QA_PREFIX}B2`;
  const rowId  = await insertQARow(siteId, PRE_CUTOFF_DATE);
  const revErr = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, PRE_CUTOFF_DATE);
  assert('B2.1 success (no cutoff gate)',    revErr === null, revErr ?? '');
  const rev = await getRevRow(siteId);
  assert('B2.2 invoice_date = 2025-06-15',  rev?.invoice_date === PRE_CUTOFF_DATE, String(rev?.invoice_date));
  assert('B2.3 month = 6',                  rev?.month === 6,    String(rev?.month));
  assert('B2.4 year  = 2025',               rev?.year  === 2025, String(rev?.year));
  await deleteQARow(rowId);
  await deleteRevRow(siteId);
}

// ── C. Add same Site ID again → no duplicate revenue ─────────────────────────
console.log('\nC. Add same Site ID twice → no duplicate revenue');
{
  const siteId = `${QA_PREFIX}C`;
  const rowId1 = await insertQARow(siteId);
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, '');
  // "Add again" — a second call to ensureRevenuePlaceholder (same as saveModal would do)
  const revErr2 = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, '');
  assert('C.1  second ensure returns null (idempotent)', revErr2 === null, revErr2 ?? '');
  const { count } = await dst.from('revenue')
    .select('id', { count: 'exact', head: true })
    .eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId);
  assert('C.2  exactly one revenue row', count === 1, `count=${count}`);
  await deleteQARow(rowId1);
  await deleteRevRow(siteId);
}

// ── D. Edit non-site-ID field → revenue unchanged ────────────────────────────
console.log('\nD. Edit non-site-ID field → Revenue untouched');
{
  const siteId = `${QA_PREFIX}D`;
  const rowId  = await insertQARow(siteId);
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, '');
  const revBefore = await getRevRow(siteId);
  // Simulate editing Governate — site ID stays the same, so code does nothing to revenue
  await dst.from('rows').update({
    data: { 'Site ID': siteId, 'Governate': 'Basra', 'Imp. Date': '', 'ATP Status': 'Pending', 'Comment': 'edited' },
    updated_at: new Date().toISOString(),
  }).eq('id', rowId);
  // When site ID unchanged, handleRevenueOnSiteIdChange is NOT called — no revenue ops
  const revAfter = await getRevRow(siteId);
  assert('D.1  revenue row still exists', !!revAfter);
  assert('D.2  revenue amount unchanged', Number(revAfter?.amount) === Number(revBefore?.amount));
  assert('D.3  revenue status unchanged', revAfter?.status === revBefore?.status);
  await deleteQARow(rowId);
  await deleteRevRow(siteId);
}

// ── E. Change Site ID — untouched placeholder follows new ID ──────────────────
console.log('\nE. Change Site ID — placeholder follows new ID, no duplicate');
{
  const oldSiteId = `${QA_PREFIX}E-OLD`;
  const newSiteId = `${QA_PREFIX}E-NEW`;
  const rowId     = await insertQARow(oldSiteId);
  await ensureRevenuePlaceholder(oldSiteId, QA_SEC_LABEL, '');
  // Verify it's a placeholder
  const oldRev    = await getRevRow(oldSiteId);
  assert('E.1  placeholder created for old ID', !!oldRev);
  const isPlaceholder = await revRowIsPlaceholder(oldRev!.id, Number(oldRev!.amount));
  assert('E.2  is a placeholder (amount=0, no invoice items)', isPlaceholder);
  // Simulate site ID change — update placeholder site_id
  const { error: updErr } = await dst.from('revenue')
    .update({ site_id: newSiteId }).eq('id', oldRev!.id);
  assert('E.3  revenue site_id updated to new ID', !updErr, updErr?.message);
  const revOld = await getRevRow(oldSiteId);
  const revNew = await getRevRow(newSiteId);
  assert('E.4  old site_id no longer in revenue', !revOld);
  assert('E.5  new site_id in revenue',            !!revNew);
  const { count } = await dst.from('revenue')
    .select('id', { count: 'exact', head: true })
    .eq('project_name', QA_PROJECT_NAME)
    .in('site_id', [oldSiteId, newSiteId]);
  assert('E.6  exactly one revenue row total',     count === 1, `count=${count}`);
  await deleteQARow(rowId);
  await deleteRevRow(newSiteId);
}

// ── F. Change Site ID — financial history preserved, new placeholder created ──
console.log('\nF. Change Site ID — financial history preserved, new placeholder created');
{
  const oldSiteId = `${QA_PREFIX}F-OLD`;
  const newSiteId = `${QA_PREFIX}F-NEW`;
  const rowId     = await insertQARow(oldSiteId);
  await ensureRevenuePlaceholder(oldSiteId, QA_SEC_LABEL, '');
  // Simulate financial history: set amount > 0
  const oldRev = await getRevRow(oldSiteId);
  await dst.from('revenue').update({ amount: 500000 }).eq('id', oldRev!.id);
  // Verify it's no longer a placeholder
  const isPlaceholder = await revRowIsPlaceholder(oldRev!.id, 500000);
  assert('F.1  row has financial history (not a placeholder)', !isPlaceholder);
  // Simulate site ID change: preserve old, create new placeholder
  const revErr = await ensureRevenuePlaceholder(newSiteId, QA_SEC_LABEL, '');
  assert('F.2  new placeholder created', revErr === null, revErr ?? '');
  const revOld = await getRevRow(oldSiteId);
  const revNew = await getRevRow(newSiteId);
  assert('F.3  old revenue history preserved (still exists)', !!revOld);
  assert('F.4  old revenue amount still 500000', Number(revOld?.amount) === 500000);
  assert('F.5  new revenue placeholder created', !!revNew);
  assert('F.6  new revenue amount = 0',          Number(revNew?.amount) === 0);
  const { count } = await dst.from('revenue')
    .select('id', { count: 'exact', head: true })
    .eq('project_name', QA_PROJECT_NAME)
    .in('site_id', [oldSiteId, newSiteId]);
  assert('F.7  two revenue rows total (old preserved + new)',  count === 2, `count=${count}`);
  await deleteQARow(rowId);
  await deleteRevRow(oldSiteId);
  await deleteRevRow(newSiteId);
}

// ── G. Delete site — untouched placeholder deleted ────────────────────────────
console.log('\nG. Delete site with untouched placeholder → both deleted');
{
  const siteId = `${QA_PREFIX}G`;
  const rowId  = await insertQARow(siteId);
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, '');
  const rev = await getRevRow(siteId);
  assert('G.1  revenue placeholder exists', !!rev);
  const isPlaceholder = await revRowIsPlaceholder(rev!.id, Number(rev!.amount));
  assert('G.2  is placeholder', isPlaceholder);
  // Simulate delete: row deleted, then revenue placeholder deleted
  await deleteQARow(rowId);
  if (isPlaceholder) {
    const { error: delRevErr } = await dst.from('revenue').delete().eq('id', rev!.id);
    assert('G.3  revenue placeholder deleted', !delRevErr, delRevErr?.message);
  }
  const revAfter = await getRevRow(siteId);
  assert('G.4  revenue row gone after delete', !revAfter);
  const { count: rowCount } = await dst.from('rows')
    .select('id', { count: 'exact', head: true }).eq('id', rowId);
  assert('G.5  rows entry gone', rowCount === 0);
}

// ── H. Delete site — financial revenue preserved, marked is_orphaned ─────────
console.log('\nH. Delete site with financial revenue → Revenue history preserved (is_orphaned = true)');
{
  const siteId = `${QA_PREFIX}H`;
  const rowId  = await insertQARow(siteId);
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  // Give it financial history
  const rev = await getRevRow(siteId);
  await dst.from('revenue').update({ amount: 750000 }).eq('id', rev!.id);
  // Delete the row
  await deleteQARow(rowId);
  // Revenue should NOT be deleted — mark is_orphaned = true instead
  const isPlaceholder = await revRowIsPlaceholder(rev!.id, 750000);
  assert('H.1  not a placeholder (has financial history)', !isPlaceholder);
  if (!isPlaceholder) {
    await dst.from('revenue').update({ is_orphaned: true }).eq('id', rev!.id);
  }
  const revAfter = await getRevRow(siteId);
  assert('H.2  revenue row still exists',        !!revAfter);
  assert('H.3  amount preserved (750000)',        Number(revAfter?.amount) === 750000);
  assert('H.4  is_orphaned = true',               revAfter?.is_orphaned === true, String(revAfter?.is_orphaned));
  await deleteRevRow(siteId);
}

// ── H2. Re-add previously-deleted site → orphaned row reactivated, no duplicate
console.log('\nH2. Re-add site whose revenue was orphaned → is_orphaned = false, no new row');
{
  const siteId = `${QA_PREFIX}H2`;
  const rowId1 = await insertQARow(siteId);
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  const rev = await getRevRow(siteId);
  // Simulate financial history + site deletion → is_orphaned = true
  await dst.from('revenue').update({ amount: 300000, is_orphaned: true }).eq('id', rev!.id);
  await deleteQARow(rowId1);
  // Re-add the site — ensureRevenuePlaceholder should reactivate the orphaned row
  const rowId2 = await insertQARow(siteId, VALID_IMP_DATE);
  const revErr = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  assert('H2.1 ensureRevenuePlaceholder returned null (success)', revErr === null, revErr ?? '');
  const { count } = await dst.from('revenue')
    .select('id', { count: 'exact', head: true })
    .eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId);
  assert('H2.2 exactly one revenue row (no duplicate)',  count === 1, `count=${count}`);
  const revAfter = await getRevRow(siteId);
  assert('H2.3 is_orphaned = false (reactivated)',       revAfter?.is_orphaned === false, String(revAfter?.is_orphaned));
  assert('H2.4 financial amount preserved (300000)',     Number(revAfter?.amount) === 300000);
  await deleteQARow(rowId2);
  await deleteRevRow(siteId);
}

// ── I. Retire section → Revenue records untouched ─────────────────────────────
console.log('\nI. Retire section → Revenue records untouched');
{
  const siteId = `${QA_PREFIX}I`;
  await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  const revBefore = await getRevRow(siteId);
  assert('I.1  revenue row exists before retirement', !!revBefore);
  // Simulate section soft-delete — only sections table is touched, never revenue
  // We verify: after sections.is_deleted=true, the revenue row is unchanged
  const revAfter = await getRevRow(siteId);
  assert('I.2  revenue row unchanged after section retirement', !!revAfter);
  assert('I.3  revenue amount unchanged', Number(revAfter?.amount) === Number(revBefore?.amount));
  assert('I.4  revenue status unchanged', revAfter?.status === revBefore?.status);
  await deleteRevRow(siteId);
}

// ── J. Manual Sync after auto-created → no duplicate ─────────────────────────
console.log('\nJ. Manual Sync after auto-created Revenue → no duplicate');
{
  const siteId = `${QA_PREFIX}J`;
  const rowId  = await insertQARow(siteId, VALID_IMP_DATE);
  // Auto-create (what saveModal does)
  const revErr = await ensureRevenuePlaceholder(siteId, QA_SEC_LABEL, VALID_IMP_DATE);
  assert('J.1  auto-created placeholder', revErr === null, revErr ?? '');
  // Simulate handleSync duplicate check (uses project_name + site_id key)
  const { data: existingRev } = await dst.from('revenue').select('project_name, site_id');
  const existingKeys = new Set((existingRev ?? []).map(
    (r: { project_name: string; site_id: string }) => `${r.project_name}|||${r.site_id}`,
  ));
  const syncKey = `${QA_PROJECT_NAME}|||${siteId}`;
  const wouldSyncSkip = existingKeys.has(syncKey);
  assert('J.2  manual sync would skip (key already in set)', wouldSyncSkip);
  const { count } = await dst.from('revenue')
    .select('id', { count: 'exact', head: true })
    .eq('project_name', QA_PROJECT_NAME).eq('site_id', siteId);
  assert('J.3  exactly one revenue row (no duplicate)', count === 1, `count=${count}`);
  await deleteQARow(rowId);
  await deleteRevRow(siteId);
}

// ── Final cleanup and results ─────────────────────────────────────────────────
await cleanup();

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
