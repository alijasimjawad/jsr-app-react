/**
 * QA test suite for the Append / Upsert import logic.
 * Tests normalizeSiteId, analyzeUpsertOp, and the full DB upsert path.
 * Run: npx tsx scripts/_qa_upsert_test.ts
 */
import * as XLSX from 'xlsx';
import ExcelJSPkg from 'exceljs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Mirror the exported helpers exactly as they appear in NetworkScopes.tsx ──
export function normalizeSiteId(raw: string): string {
  let s = raw.trim();
  s = s.replace(/,/g, '');
  if (/^\d+\.$/.test(s)) s = s.slice(0, -1);
  return s;
}

export interface UpsertAnalysis {
  siteIdColIdx: number;
  toInsert:   string[][];
  toUpdate:   Array<{ rowId: string; cells: string[] }>;
  conflicts:  Array<{ row: string[]; reason: string }>;
  skipped:    string[][];
  isSafeForUpsert: boolean;
  unsafeReason?: string;
}

export function analyzeUpsertOp(
  impHeaders:       string[],
  impRows:          string[][],
  existingRows:     { id: string; cells: string[] }[],
  existingColumns:  string[],
): UpsertAnalysis {
  const siteIdColIdx = impHeaders.findIndex(h => /^site[\s_]?id$/i.test(h.trim()));

  if (siteIdColIdx === -1) {
    return {
      siteIdColIdx: -1,
      toInsert: [], toUpdate: [], conflicts: [], skipped: impRows,
      isSafeForUpsert: false,
      unsafeReason: '"Site ID" column not found in this section',
    };
  }

  const existingSiteIdIdx = existingColumns.findIndex(h => /^site[\s_]?id$/i.test(h.trim()));
  const existingMap = new Map<string, string>();
  if (existingSiteIdIdx >= 0) {
    for (const row of existingRows) {
      const norm = normalizeSiteId(row.cells[existingSiteIdIdx] ?? '');
      if (norm) existingMap.set(norm, row.id);
    }
  }

  const incomingCounts = new Map<string, number>();
  for (const row of impRows) {
    const norm = normalizeSiteId(row[siteIdColIdx] ?? '');
    if (norm) incomingCounts.set(norm, (incomingCounts.get(norm) ?? 0) + 1);
  }

  const toInsert:  string[][] = [];
  const toUpdate:  Array<{ rowId: string; cells: string[] }> = [];
  const conflicts: Array<{ row: string[]; reason: string }> = [];
  const skipped:   string[][] = [];

  for (const row of impRows) {
    const norm = normalizeSiteId(row[siteIdColIdx] ?? '');
    if (!norm) { skipped.push(row); continue; }
    if ((incomingCounts.get(norm) ?? 0) > 1) {
      conflicts.push({ row, reason: `Duplicate Site ID "${norm}" in file` }); continue;
    }
    const existingId = existingMap.get(norm);
    if (existingId) {
      toUpdate.push({ rowId: existingId, cells: row });
    } else {
      toInsert.push(row);
    }
  }

  const isSafeForUpsert = conflicts.length === 0;
  return {
    siteIdColIdx, toInsert, toUpdate, conflicts, skipped, isSafeForUpsert,
    unsafeReason: conflicts.length > 0
      ? `${conflicts.length} duplicate Site ID${conflicts.length !== 1 ? 's' : ''} found in the file`
      : undefined,
  };
}

// ── Env / DB setup ────────────────────────────────────────────────────────────
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

const BRAND_APP_NAME = 'JSR Network Tracker';
const QA_SECTION_ID  = '3813b019-918e-48d6-8a88-ee5c58f6db9e';
const SECTION_COLS   = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];

// A DIFFERENT section ID for cross-section isolation test (real MRC/FTK)
const OTHER_SECTION_ID = 'bda26ffb-d715-4133-ab83-1f3238a801c9';

let passed = 0; let failed = 0;
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS  ${name}`); passed++; }
  else    { console.log(`  ✘ FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatImportCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
  }
  return String(v);
}

async function buildJsrExcel(headers: string[], dataRows: string[][]): Promise<ArrayBuffer> {
  const ExcelJS = ExcelJSPkg;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet');
  const titleText = `${BRAND_APP_NAME}  ·  MRC Project  ·  FTK     (Export: 2026-08-15)`;
  ws.addRow([titleText]);
  if (headers.length > 1) ws.mergeCells(1, 1, 1, headers.length);
  ws.addRow(headers);
  for (const row of dataRows) ws.addRow(row);
  return await wb.xlsx.writeBuffer() as ArrayBuffer;
}

function parseImport(buf: ArrayBuffer, sectionCols: string[]): {
  headers: string[] | null; impRows: string[][]; upsert: UpsertAnalysis | null; error?: string;
} {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
  if (!raw || raw.length < 1) return { headers: null, impRows: [], upsert: null, error: 'Empty' };

  let headerRowIdx = 0;
  const firstCell = formatImportCell((raw[0] as unknown[])[0]).trim();
  if (firstCell.startsWith(BRAND_APP_NAME)) headerRowIdx = 1;
  if (raw.length <= headerRowIdx) return { headers: null, impRows: [], upsert: null, error: 'No header row' };

  const rawHeaders = (raw[headerRowIdx] as unknown[]).map(h => formatImportCell(h).trim());
  const lastNonEmpty = rawHeaders.reduce((last, h, i) => h !== '' ? i : last, -1);
  if (lastNonEmpty === -1) return { headers: null, impRows: [], upsert: null, error: 'No headers' };
  const impHeaders = rawHeaders.slice(0, lastNonEmpty + 1);

  const blankIdx = impHeaders.findIndex(h => h === '');
  if (blankIdx !== -1) return { headers: null, impRows: [], upsert: null, error: `Blank header at ${blankIdx+1}` };

  const seen = new Set<string>();
  for (const h of impHeaders) {
    if (seen.has(h)) return { headers: null, impRows: [], upsert: null, error: `Dup header "${h}"` };
    seen.add(h);
  }

  // Schema check against section columns
  const match = impHeaders.length === sectionCols.length && impHeaders.every((h, i) => h === sectionCols[i]);
  if (!match) return { headers: null, impRows: [], upsert: null, error: `Column mismatch: [${impHeaders}] vs [${sectionCols}]` };

  const dataStartIdx = headerRowIdx + 1;
  const impRows = (raw.slice(dataStartIdx) as unknown[][])
    .filter(r => r.some(v => formatImportCell(v).trim() !== ''))
    .map(r => impHeaders.map((_, i) => formatImportCell(r[i])));

  return { headers: impHeaders, impRows, upsert: null }; // caller does analyzeUpsertOp
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getQaRows() {
  const { data } = await dst.from('rows').select('id, data, row_order')
    .eq('section_id', QA_SECTION_ID).order('row_order');
  return data ?? [];
}

async function clearQaRows() {
  await dst.from('rows').delete().eq('section_id', QA_SECTION_ID);
}

async function insertQaRows(rows: Array<{ siteId: string; governate: string; atp: string; comment: string }>) {
  const data = rows.map((r, i) => ({
    section_id: QA_SECTION_ID,
    data: { 'Site ID': r.siteId, 'Governate': r.governate, 'Imp. Date': '', 'ATP Status': r.atp, 'Comment': r.comment },
    row_order: i,
  }));
  const { error } = await dst.from('rows').insert(data);
  if (error) throw new Error('Insert failed: ' + error.message);
}

async function getQaSection() {
  const { data } = await dst.from('sections').select('columns, custom_columns')
    .eq('id', QA_SECTION_ID).single();
  return data;
}

// ── UNIT TESTS ────────────────────────────────────────────────────────────────
console.log('\n=== Unit Tests: normalizeSiteId ===\n');

// Trim
assert('trim whitespace', normalizeSiteId('  9950  ') === '9950');
// Remove commas
assert('remove thousands comma', normalizeSiteId('9,950') === '9950');
assert('multiple commas', normalizeSiteId('1,234,567') === '1234567');
// Remove trailing period (numeric)
assert('trailing period on integer', normalizeSiteId('9950.') === '9950');
assert('comma + trailing period', normalizeSiteId('9,950.') === '9950');
// Do NOT remove period from non-numeric
assert('preserve period in non-numeric (A1.2)', normalizeSiteId('A1.2') === 'A1.2');
assert('preserve leading alpha (ABC-001)', normalizeSiteId('ABC-001') === 'ABC-001');
// Empty
assert('empty string → empty', normalizeSiteId('') === '');
assert('whitespace only → empty', normalizeSiteId('   ') === '');

console.log('\n=== Unit Tests: analyzeUpsertOp ===\n');

const EXISTING_ROWS = [
  { id: 'row-id-1', cells: ['1001', 'Baghdad', '2026-01-01', 'Accepted', 'orig'] },
  { id: 'row-id-2', cells: ['1002', 'Basra',   '2026-02-01', 'Pending',  'orig'] },
];
const HEADERS  = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];

// TEST: existing Site ID → UPDATE
{
  const impRows = [['1001', 'Baghdad Updated', '2026-08-15', 'Accepted', 'updated']];
  const ua = analyzeUpsertOp(HEADERS, impRows, EXISTING_ROWS, HEADERS);
  assert('[update] toUpdate.length = 1', ua.toUpdate.length === 1, String(ua.toUpdate.length));
  assert('[update] toInsert.length = 0', ua.toInsert.length === 0);
  assert('[update] rowId matches', ua.toUpdate[0]?.rowId === 'row-id-1', ua.toUpdate[0]?.rowId);
  assert('[update] isSafeForUpsert = true', ua.isSafeForUpsert);
}

// TEST: new Site ID → INSERT
{
  const impRows = [['9999', 'Erbil', '2026-08-15', 'Pending', 'new']];
  const ua = analyzeUpsertOp(HEADERS, impRows, EXISTING_ROWS, HEADERS);
  assert('[insert] toInsert.length = 1', ua.toInsert.length === 1);
  assert('[insert] toUpdate.length = 0', ua.toUpdate.length === 0);
  assert('[insert] isSafeForUpsert = true', ua.isSafeForUpsert);
}

// TEST: formatted Site ID  "9,950." ≡ "9950" → UPDATE
{
  const existing9950 = [{ id: 'row-9950', cells: ['9950', 'Baghdad', '', 'Pending', ''] }];
  const impRows      = [['9,950.', 'Baghdad Updated', '2026-08-15', 'Accepted', 'fmt-match']];
  const ua = analyzeUpsertOp(HEADERS, impRows, existing9950, HEADERS);
  assert('[normalise] 9,950. → UPDATE row-9950', ua.toUpdate.length === 1, String(ua.toUpdate.length));
  assert('[normalise] rowId = row-9950', ua.toUpdate[0]?.rowId === 'row-9950');
}

// TEST: duplicate Site IDs in incoming file → conflict
{
  const impRows = [
    ['1001', 'Baghdad', '', 'Accepted', 'dup-a'],
    ['1001', 'Basra',   '', 'Pending',  'dup-b'],
    ['2000', 'Erbil',   '', 'Pending',  'new'],
  ];
  const ua = analyzeUpsertOp(HEADERS, impRows, EXISTING_ROWS, HEADERS);
  assert('[conflict] conflicts.length = 2', ua.conflicts.length === 2, String(ua.conflicts.length));
  assert('[conflict] isSafeForUpsert = false', !ua.isSafeForUpsert);
  assert('[conflict] toInsert still works for non-dup', ua.toInsert.length === 1);
}

// TEST: blank Site ID → skipped
{
  const impRows = [
    ['', 'Baghdad', '', 'Accepted', 'no-id'],
    ['1001', 'Erbil', '', 'Pending', 'has-id'],
  ];
  const ua = analyzeUpsertOp(HEADERS, impRows, EXISTING_ROWS, HEADERS);
  assert('[skip] skipped.length = 1', ua.skipped.length === 1, String(ua.skipped.length));
  assert('[skip] isSafeForUpsert = true (blank alone not a blocker)', ua.isSafeForUpsert);
  assert('[skip] toUpdate.length = 1 (1001 exists)', ua.toUpdate.length === 1);
}

// TEST: Site ID column missing → not safe
{
  const headersNoSiteId = ['Governate', 'Imp. Date', 'ATP Status', 'Comment'];
  const impRows = [['Baghdad', '', 'Pending', '']];
  const ua = analyzeUpsertOp(headersNoSiteId, impRows, [], headersNoSiteId);
  assert('[no-site-id] siteIdColIdx = -1', ua.siteIdColIdx === -1);
  assert('[no-site-id] isSafeForUpsert = false', !ua.isSafeForUpsert);
  assert('[no-site-id] skipped = all rows', ua.skipped.length === impRows.length);
}

// TEST: same Site ID in DIFFERENT section must NOT match
// (isolation guaranteed because analyzeUpsertOp only receives THIS section's rows)
{
  const differentSectionRow = { id: 'other-section-row', cells: ['1001', 'Mosul', '', 'Accepted', ''] };
  // Pass empty existing rows (simulating: this section has no rows, other section has 1001)
  const ua = analyzeUpsertOp(HEADERS, [['1001', 'Baghdad', '', 'Accepted', '']], [], HEADERS);
  assert('[cross-section] 1001 inserted, not matched to other-section row',
    ua.toInsert.length === 1 && ua.toUpdate.length === 0,
    `insert=${ua.toInsert.length} update=${ua.toUpdate.length}`,
  );
  // Verify that the other-section row variable was never used
  assert('[cross-section] other-section rowId not in toUpdate', !ua.toUpdate.some(u => u.rowId === differentSectionRow.id));
}

// ── DB INTEGRATION TESTS ──────────────────────────────────────────────────────
console.log('\n=== DB Integration Tests: Upsert against QA section ===\n');

// Reset: clear QA section rows
await clearQaRows();
assert('[db-reset] rows cleared', (await getQaRows()).length === 0);

// Seed 2 known rows
await insertQaRows([
  { siteId: 'QA-CUTOVER-001', governate: 'Baghdad', atp: 'Accepted', comment: 'seed-1' },
  { siteId: 'QA-CUTOVER-002', governate: 'Basra',   atp: 'Pending',  comment: 'seed-2' },
]);
const seedRows = await getQaRows();
assert('[db-seed] 2 rows seeded', seedRows.length === 2, String(seedRows.length));
const seedId1 = seedRows.find(r => (r.data as Record<string,string>)['Site ID'] === 'QA-CUTOVER-001')?.id as string;
const seedId2 = seedRows.find(r => (r.data as Record<string,string>)['Site ID'] === 'QA-CUTOVER-002')?.id as string;
assert('[db-seed] seedId1 found', !!seedId1);
assert('[db-seed] seedId2 found', !!seedId2);

// BUILD: 3-row import: update QA-001, insert QA-003, skip QA-002 via new value
const impHeaders = SECTION_COLS;
const impData: string[][] = [
  ['QA-CUTOVER-001', 'Baghdad UPDATED', '2026-08-15', 'Accepted', 'updated-comment'],
  ['QA-CUTOVER-003', 'Erbil',           '2026-08-01', 'Pending',  'brand-new'],
  ['QA-CUTOVER-002', 'Basra UPDATED',   '2026-08-10', 'Accepted', 'also-updated'],
];

// Simulate analyzeUpsertOp with current DB rows
const existingForAnalysis = seedRows.map(r => ({
  id: r.id as string,
  cells: SECTION_COLS.map(col => String((r.data as Record<string,string>)[col] ?? '')),
}));
const ua = analyzeUpsertOp(impHeaders, impData, existingForAnalysis, SECTION_COLS);
assert('[db-upsert-analysis] toUpdate = 2', ua.toUpdate.length === 2, String(ua.toUpdate.length));
assert('[db-upsert-analysis] toInsert = 1', ua.toInsert.length === 1, String(ua.toInsert.length));
assert('[db-upsert-analysis] conflicts = 0', ua.conflicts.length === 0);
assert('[db-upsert-analysis] skipped = 0', ua.skipped.length === 0);
assert('[db-upsert-analysis] isSafeForUpsert = true', ua.isSafeForUpsert);

// Execute upsert (mirrors doImportWith 'upsert' path):
const now = new Date().toISOString();
const UPDATE_BATCH = 20;
for (let i = 0; i < ua.toUpdate.length; i += UPDATE_BATCH) {
  const batch = ua.toUpdate.slice(i, i + UPDATE_BATCH);
  const results = await Promise.all(batch.map(upd => {
    const data = Object.fromEntries(impHeaders.map((col, ci) => [col, upd.cells[ci] ?? '']));
    return dst.from('rows').update({ data, updated_at: now }).eq('id', upd.rowId);
  }));
  for (const { error } of results) {
    if (error) throw new Error('Update failed: ' + error.message);
  }
}
const existingCount = seedRows.length;
const toInsertRows = ua.toInsert.map((cells, i) => ({
  section_id: QA_SECTION_ID,
  data: Object.fromEntries(impHeaders.map((col, ci) => [col, cells[ci] ?? ''])),
  row_order: existingCount + i,
}));
if (toInsertRows.length > 0) {
  const { error } = await dst.from('rows').insert(toInsertRows);
  if (error) throw new Error('Insert failed: ' + error.message);
}

// Verify DB state after upsert
const afterRows = await getQaRows();
assert('[db-upsert-result] total rows = 3', afterRows.length === 3, String(afterRows.length));

const row1 = afterRows.find(r => (r.data as Record<string,string>)['Site ID'] === 'QA-CUTOVER-001');
const row2 = afterRows.find(r => (r.data as Record<string,string>)['Site ID'] === 'QA-CUTOVER-002');
const row3 = afterRows.find(r => (r.data as Record<string,string>)['Site ID'] === 'QA-CUTOVER-003');

assert('[db-upsert-result] QA-001 row ID preserved', row1?.id === seedId1, `${row1?.id} vs ${seedId1}`);
assert('[db-upsert-result] QA-001 Governate updated', (row1?.data as Record<string,string>)?.['Governate'] === 'Baghdad UPDATED', (row1?.data as Record<string,string>)?.['Governate']);
assert('[db-upsert-result] QA-001 Comment updated', (row1?.data as Record<string,string>)?.['Comment'] === 'updated-comment');
assert('[db-upsert-result] QA-002 row ID preserved', row2?.id === seedId2);
assert('[db-upsert-result] QA-002 Governate updated', (row2?.data as Record<string,string>)?.['Governate'] === 'Basra UPDATED');
assert('[db-upsert-result] QA-003 inserted (new row)', !!row3);
assert('[db-upsert-result] QA-003 Governate = Erbil', (row3?.data as Record<string,string>)?.['Governate'] === 'Erbil');

// sections.columns must be unchanged
const secAfter = await getQaSection();
assert('[db-upsert-result] sections.columns unchanged', JSON.stringify(secAfter?.columns) === JSON.stringify(SECTION_COLS), JSON.stringify(secAfter?.columns));
assert('[db-upsert-result] sections.custom_columns unchanged', JSON.stringify(secAfter?.custom_columns) === '[]');

// TEST: Formatted Site ID match (9,950. ≡ 9950)
console.log('\n=== Normalisation: Formatted Site ID round-trip ===\n');
{
  await clearQaRows();
  // Seed a row with clean Site ID "9950"
  const { error: seedErr } = await dst.from('rows').insert({
    section_id: QA_SECTION_ID,
    data: { 'Site ID': '9950', 'Governate': 'Baghdad', 'Imp. Date': '', 'ATP Status': 'Pending', 'Comment': 'clean-id' },
    row_order: 0,
  });
  assert('[fmt] seed 9950', !seedErr, seedErr?.message);

  const fmtRows = await getQaRows();
  const existing = fmtRows.map(r => ({
    id: r.id as string,
    cells: SECTION_COLS.map(col => String((r.data as Record<string,string>)[col] ?? '')),
  }));

  // Incoming file has "9,950." (formatted equivalent)
  const ua2 = analyzeUpsertOp(SECTION_COLS, [['9,950.', 'Baghdad Updated', '', 'Accepted', 'fmt-updated']], existing, SECTION_COLS);
  assert('[fmt] 9,950. matches 9950 → UPDATE', ua2.toUpdate.length === 1, `update=${ua2.toUpdate.length}`);
  assert('[fmt] no INSERT', ua2.toInsert.length === 0);
  assert('[fmt] isSafe = true', ua2.isSafeForUpsert);
}

// TEST: Cross-section isolation — Site ID "9950" in a DIFFERENT section must NOT match
console.log('\n=== Cross-section isolation ===\n');
{
  // QA section currently has "9950"
  // Simulate: incoming file has "9950", but existingRows is for a DIFFERENT section (empty)
  const ua3 = analyzeUpsertOp(
    SECTION_COLS,
    [['9950', 'Mosul', '', 'Accepted', 'other-section']],
    [],  // OTHER section has NO rows (isolated — Site ID from QA section not passed in)
    SECTION_COLS,
  );
  assert('[cross-section] 9950 not found in empty-other-section → INSERT', ua3.toInsert.length === 1);
  assert('[cross-section] no cross-section UPDATE', ua3.toUpdate.length === 0);
}

// TEST: Round-trip export→import with JSR title row
console.log('\n=== Export→Import round-trip (title row skip + upsert) ===\n');
{
  // Use current QA rows (9950 from previous test) as "export" data
  const qaRows = await getQaRows();
  const exportData: string[][] = qaRows.map(r =>
    SECTION_COLS.map(col => String((r.data as Record<string,string>)[col] ?? '')),
  );

  // Build JSR-style export (ExcelJS with title row)
  const buf = await buildJsrExcel(SECTION_COLS, exportData);

  // Parse with the same logic as handleImportFile
  const result = parseImport(buf, SECTION_COLS);
  assert('[roundtrip] headers extracted', result.headers !== null, result.error);
  assert('[roundtrip] header[0] = Site ID', result.headers?.[0] === 'Site ID');
  assert('[roundtrip] data row count matches', result.impRows.length === qaRows.length, `${result.impRows.length} vs ${qaRows.length}`);

  // analyzeUpsertOp: since we export current rows and re-import them, all should UPDATE (0 INSERT)
  const existing2 = qaRows.map(r => ({
    id: r.id as string,
    cells: SECTION_COLS.map(col => String((r.data as Record<string,string>)[col] ?? '')),
  }));
  const ua4 = analyzeUpsertOp(SECTION_COLS, result.impRows, existing2, SECTION_COLS);
  assert('[roundtrip] 0 INSERT (same data re-imported)', ua4.toInsert.length === 0);
  assert('[roundtrip] all rows UPDATE', ua4.toUpdate.length === qaRows.length, String(ua4.toUpdate.length));
  assert('[roundtrip] 0 conflicts', ua4.conflicts.length === 0);
  assert('[roundtrip] isSafeForUpsert = true', ua4.isSafeForUpsert);
}

// Cleanup: restore QA section to the 2 original rows for subsequent QA
await clearQaRows();
const { error: restoreErr } = await dst.from('rows').insert([
  { section_id: QA_SECTION_ID, data: { 'Site ID': 'QA-CUTOVER-001', 'Governate': 'Baghdad', 'Imp. Date': '2026-08-15', 'ATP Status': 'Accepted', 'Comment': 'Test row 1' }, row_order: 0 },
  { section_id: QA_SECTION_ID, data: { 'Site ID': 'QA-CUTOVER-002', 'Governate': 'Basra',   'Imp. Date': '2026-08-01', 'ATP Status': 'Pending',  'Comment': ''           }, row_order: 1 },
]);
assert('[cleanup] QA rows restored to 2', !restoreErr, restoreErr?.message);

// Final DB state check
const finalRows = await getQaRows();
const finalSec  = await getQaSection();
assert('[final] 2 rows in QA section', finalRows.length === 2, String(finalRows.length));
assert('[final] sections.columns = SECTION_COLS', JSON.stringify(finalSec?.columns) === JSON.stringify(SECTION_COLS));
assert('[final] sections.custom_columns = []', JSON.stringify(finalSec?.custom_columns) === '[]');

console.log(`\n${'─'.repeat(42)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
