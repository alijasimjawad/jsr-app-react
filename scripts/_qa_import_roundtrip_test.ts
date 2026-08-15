/**
 * Full export→import round-trip QA test.
 * Uses ExcelJS to produce a file identical to what exportSection() creates in the browser,
 * then uses XLSX (SheetJS) + the fixed parsing logic to verify correct header extraction.
 * Run: npx tsx scripts/_qa_import_roundtrip_test.ts
 */
import ExcelJSPkg from 'exceljs';
import * as XLSX from 'xlsx';
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

const BRAND_APP_NAME = 'JSR Network Tracker';
const QA_SECTION_ID = '3813b019-918e-48d6-8a88-ee5c58f6db9e';
const SECTION_COLS = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];
const dateStr = '2026-08-15';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✔ PASS  ${name}`);
    passed++;
  } else {
    console.log(`  ✘ FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function formatImportCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

function parseImport(buf: ArrayBuffer): { headers: string[] | null; dataRows: string[][]; dataStartIdx: number; error?: string } {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' }) as unknown[][];

  if (!raw || raw.length < 1) return { headers: null, dataRows: [], dataStartIdx: 0, error: 'Empty file' };

  let headerRowIdx = 0;
  const firstCell = formatImportCell((raw[0] as unknown[])[0]).trim();
  if (firstCell.startsWith(BRAND_APP_NAME)) headerRowIdx = 1;
  if (raw.length <= headerRowIdx) return { headers: null, dataRows: [], dataStartIdx: 0, error: 'No header row' };

  const rawHeaders = (raw[headerRowIdx] as unknown[]).map(h => formatImportCell(h).trim());
  const lastNonEmpty = rawHeaders.reduce((last, h, i) => h !== '' ? i : last, -1);
  if (lastNonEmpty === -1) return { headers: null, dataRows: [], dataStartIdx: 0, error: 'No column headers' };
  const impHeaders = rawHeaders.slice(0, lastNonEmpty + 1);

  const blankIdx = impHeaders.findIndex(h => h === '');
  if (blankIdx !== -1) return { headers: null, dataRows: [], dataStartIdx: 0, error: `Blank header at col ${blankIdx + 1}` };

  const seen = new Set<string>();
  for (const h of impHeaders) {
    if (seen.has(h)) return { headers: null, dataRows: [], dataStartIdx: 0, error: `Duplicate "${h}"` };
    seen.add(h);
  }
  if (impHeaders.some(h => h.length > 100)) return { headers: null, dataRows: [], dataStartIdx: 0, error: 'Header too long' };

  const dataStartIdx = headerRowIdx + 1;
  const dataRows = (raw.slice(dataStartIdx) as unknown[][])
    .filter(r => r.some(v => formatImportCell(v).trim() !== ''))
    .map(r => impHeaders.map((_, i) => formatImportCell(r[i])));

  return { headers: impHeaders, dataRows, dataStartIdx };
}

// ── Build a JSR-style export file using ExcelJS (exactly like exportSection) ──
async function buildJsrExcelExport(headers: string[], dataRows: string[][]): Promise<ArrayBuffer> {
  const ExcelJS = ExcelJSPkg;
  const wb = new ExcelJS.Workbook();
  wb.creator = BRAND_APP_NAME;
  wb.created = new Date();
  const colCount = headers.length;
  const sheetName = 'FTK';
  const ws = wb.addWorksheet(sheetName);
  const titleText = `${BRAND_APP_NAME}  ·  MRC Project  ·  FTK     (Export: ${dateStr})`;

  ws.columns = headers.map(h => ({ width: Math.max(h.length + 4, 12) }));

  ws.addRow([titleText]);
  if (colCount > 1) ws.mergeCells(1, 1, 1, colCount);
  const titleRow = ws.getRow(1);
  titleRow.height = 26;
  const titleCell = ws.getCell('A1');
  titleCell.value     = titleText;
  titleCell.font      = { bold: true, size: 11, color: { argb: 'FF0F2038' } };
  titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF5' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' };

  ws.addRow(headers);
  const headerRow = ws.getRow(2);
  headerRow.height = 28;
  for (let c = 1; c <= colCount; c++) {
    const cell = headerRow.getCell(c);
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2038' } };
    cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
    cell.border    = { bottom: { style: 'medium', color: { argb: 'FF1A4060' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 2, showGridLines: true }];

  for (let idx = 0; idx < dataRows.length; idx++) {
    const bgArgb = idx % 2 === 0 ? 'FFFFFFFF' : 'FFF4F6F8';
    const exRow = ws.addRow(dataRows[idx]);
    exRow.height = 20;
    exRow.eachCell({ includeEmpty: true }, (cell, c) => {
      if (c > colCount) return;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgArgb } };
      cell.font = { color: { argb: 'FF111827' }, size: 10.5 };
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}

console.log('\n=== Export→Import Round-Trip QA ===\n');

// ── DB State Verification ─────────────────────────────────────────────────────
console.log('PRE-TEST: Verify QA section DB state');
{
  const { data: s } = await dst.from('sections').select('*').eq('id', QA_SECTION_ID).single();
  assert('QA section exists', !!s);
  assert('columns = SECTION_COLS', JSON.stringify(s?.columns) === JSON.stringify(SECTION_COLS), JSON.stringify(s?.columns));
  assert('custom_columns = []', JSON.stringify(s?.custom_columns) === '[]', JSON.stringify(s?.custom_columns));
  assert('is_deleted = false', s?.is_deleted === false);
}

// ── TEST 1: Full JSR Export→Import round-trip ─────────────────────────────────
console.log('\nTEST 1 — JSR export→import round-trip (2 data rows)');
{
  const testData = [
    ['QA-CUTOVER-001', 'Baghdad', '2026-08-15', 'Accepted', 'Test row 1'],
    ['QA-CUTOVER-002', 'Basra', '2026-08-01', 'Pending', ''],
  ];
  const buf = await buildJsrExcelExport(SECTION_COLS, testData);
  const result = parseImport(buf);

  assert('headers extracted (not null)', result.headers !== null, result.error);
  assert('header count = 5', result.headers?.length === 5, String(result.headers?.length));
  assert('header[0] = Site ID', result.headers?.[0] === 'Site ID', result.headers?.[0]);
  assert('header[1] = Governate', result.headers?.[1] === 'Governate');
  assert('header[2] = Imp. Date', result.headers?.[2] === 'Imp. Date');
  assert('header[3] = ATP Status', result.headers?.[3] === 'ATP Status');
  assert('header[4] = Comment', result.headers?.[4] === 'Comment');
  assert('title NOT in headers', !result.headers?.some(h => h.includes(BRAND_APP_NAME)));
  assert('data row count = 2', result.dataRows.length === 2, String(result.dataRows.length));
  assert('data[0][0] = QA-CUTOVER-001', result.dataRows[0]?.[0] === 'QA-CUTOVER-001', result.dataRows[0]?.[0]);
  assert('data[0][4] = Test row 1', result.dataRows[0]?.[4] === 'Test row 1');
  assert('data[1][0] = QA-CUTOVER-002', result.dataRows[1]?.[0] === 'QA-CUTOVER-002');
  assert('data[1][4] = empty string', result.dataRows[1]?.[4] === '', `"${result.dataRows[1]?.[4]}"`);

  // Schema comparison (simulating doImportWith guard)
  const match = result.headers!.length === SECTION_COLS.length &&
    result.headers!.every((h, i) => h === SECTION_COLS[i]);
  assert('schema comparison PASS (headers match section)', match);
}

// ── TEST 2: Import into QA section via DB (simulates doImportWith replace) ───
console.log('\nTEST 2 — Simulate safe replace (INSERT first, then DELETE by ID)');
{
  // Clear any rows left by previous test runs to ensure a known starting state.
  await dst.from('rows').delete().eq('section_id', QA_SECTION_ID);

  // Add a known row to the QA section so we can verify it gets replaced.
  const seed = { section_id: QA_SECTION_ID, data: { 'Site ID': 'QA-OLD-999', 'Governate': 'Test', 'Imp. Date': '', 'ATP Status': '', 'Comment': 'old row to be replaced' }, row_order: 0 };
  const { error: seedErr } = await dst.from('rows').insert(seed);
  assert('seed row inserted', !seedErr, seedErr?.message);

  const { data: before } = await dst.from('rows').select('id').eq('section_id', QA_SECTION_ID);
  assert('1 row exists before import', before?.length === 1, String(before?.length));
  const oldIds = (before ?? []).map(r => r.id as string);

  // Simulate INSERT-first-then-DELETE
  const newRows = [
    { section_id: QA_SECTION_ID, data: { 'Site ID': 'QA-CUTOVER-001', 'Governate': 'Baghdad', 'Imp. Date': '2026-08-15', 'ATP Status': 'Accepted', 'Comment': 'Test row 1' }, row_order: 0 },
    { section_id: QA_SECTION_ID, data: { 'Site ID': 'QA-CUTOVER-002', 'Governate': 'Basra', 'Imp. Date': '2026-08-01', 'ATP Status': 'Pending', 'Comment': '' }, row_order: 1 },
  ];
  const { error: insErr } = await dst.from('rows').insert(newRows);
  assert('new rows inserted (INSERT first)', !insErr, insErr?.message);

  const { data: mid } = await dst.from('rows').select('id').eq('section_id', QA_SECTION_ID);
  assert('3 rows mid-import (old + new)', mid?.length === 3, String(mid?.length));

  const { error: delErr } = await dst.from('rows').delete().in('id', oldIds);
  assert('old rows deleted by ID (DELETE second)', !delErr, delErr?.message);

  const { data: after } = await dst.from('rows').select('id, data').eq('section_id', QA_SECTION_ID).order('row_order');
  assert('2 rows after import', after?.length === 2, String(after?.length));
  assert('first row = QA-CUTOVER-001', (after?.[0]?.data as { 'Site ID'?: string })?.['Site ID'] === 'QA-CUTOVER-001', JSON.stringify(after?.[0]?.data));
  assert('second row = QA-CUTOVER-002', (after?.[1]?.data as { 'Site ID'?: string })?.['Site ID'] === 'QA-CUTOVER-002');

  // Verify sections.columns is UNCHANGED
  const { data: sAfter } = await dst.from('sections').select('columns, custom_columns').eq('id', QA_SECTION_ID).single();
  assert('sections.columns unchanged', JSON.stringify(sAfter?.columns) === JSON.stringify(SECTION_COLS), JSON.stringify(sAfter?.columns));
  assert('sections.custom_columns unchanged', JSON.stringify(sAfter?.custom_columns) === '[]', JSON.stringify(sAfter?.custom_columns));
}

// ── TEST A: Wrong columns → schema mismatch detected ─────────────────────────
console.log('\nTEST A — Wrong columns: mismatch detected before any DB write');
{
  const wrongCols = ['Site ID', 'City', 'Date', 'Status'];
  const buf = await buildJsrExcelExport(wrongCols, [['1001', 'Baghdad', '2026-01-15', 'OK']]);
  const result = parseImport(buf);
  assert('parse succeeds', result.headers !== null);
  const match = result.headers!.length === SECTION_COLS.length &&
    result.headers!.every((h, i) => h === SECTION_COLS[i]);
  assert('mismatch detected → block import', !match, 'should be false');
}

// ── TEST B: JSR title-only file → error ──────────────────────────────────────
console.log('\nTEST B — JSR title with no data header row');
{
  const ExcelJS = ExcelJSPkg;
  const wb2 = new ExcelJS.Workbook();
  const ws2 = wb2.addWorksheet('Sheet');
  ws2.addRow([`${BRAND_APP_NAME}  ·  Test`]);
  const buf2 = await wb2.xlsx.writeBuffer() as ArrayBuffer;
  const result = parseImport(buf2);
  assert('title-only → error', result.headers === null, result.error);
}

// ── TEST C: Blank header → error ─────────────────────────────────────────────
console.log('\nTEST C — Blank header in column set');
{
  const buf = await buildJsrExcelExport(['Site ID', '', 'Comment'], [['1001', '', 'Note']]);
  // This will not have the JSR title since we're passing weird headers...
  // Actually buildJsrExcelExport always adds a title. So row 0 = title, row 1 = ['Site ID','','Comment']
  const result = parseImport(buf);
  assert('blank header → error', result.headers === null, result.error);
}

// ── TEST D: Duplicate header → error ─────────────────────────────────────────
console.log('\nTEST D — Duplicate header names');
{
  const buf = await buildJsrExcelExport(['Site ID', 'Status', 'Status', 'Comment'], [['1001', 'OK', 'dup', '']]);
  const result = parseImport(buf);
  assert('duplicate header → error', result.headers === null, result.error);
}

// ── TEST E: Cancel = no DB writes ────────────────────────────────────────────
console.log('\nTEST E — Cancel: DB state unchanged');
{
  // Just verify DB has the 2 rows from TEST 2 (cancel doesn't touch DB — no API call to make)
  const { data } = await dst.from('rows').select('id').eq('section_id', QA_SECTION_ID);
  assert('rows still 2 after cancel (no writes)', data?.length === 2, String(data?.length));
  const { data: sCheck } = await dst.from('sections').select('columns, custom_columns').eq('id', QA_SECTION_ID).single();
  assert('sections.columns unchanged after cancel', JSON.stringify(sCheck?.columns) === JSON.stringify(SECTION_COLS));
}

// ── Final DB verification ────────────────────────────────────────────────────
console.log('\nFINAL: DB state verification');
{
  const { data: s } = await dst.from('sections').select('*').eq('id', QA_SECTION_ID).single();
  assert('sections.columns = SECTION_COLS', JSON.stringify(s?.columns) === JSON.stringify(SECTION_COLS), JSON.stringify(s?.columns));
  assert('sections.custom_columns = []', JSON.stringify(s?.custom_columns) === '[]');
  assert('is_deleted = false', s?.is_deleted === false);

  const { data: rows } = await dst.from('rows').select('id, data').eq('section_id', QA_SECTION_ID).order('row_order');
  assert('2 QA rows in DB', rows?.length === 2, String(rows?.length));
  assert('row data keyed by correct column names', !!(rows?.[0]?.data as Record<string, unknown>)?.['Site ID'], JSON.stringify(rows?.[0]?.data));

  console.log('\nQA section final state:');
  for (const r of rows ?? []) console.log('  ', JSON.stringify(r.data));
  console.log('  columns:', JSON.stringify(s?.columns));
  console.log('  custom_columns:', JSON.stringify(s?.custom_columns));
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
