/**
 * QA validation script for the Excel import header-detection logic.
 * Mirrors the parsing logic in handleImportFile exactly.
 * Run: npx tsx scripts/_qa_import_parse_test.ts
 */
import * as XLSX from 'xlsx';

const BRAND_APP_NAME = 'JSR Network Tracker';

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

function parseHeaders(raw: unknown[][]): { headers: string[] | null; dataStartIdx: number; error?: string } {
  if (!raw || raw.length < 1) return { headers: null, dataStartIdx: 0, error: 'Empty file' };

  let headerRowIdx = 0;
  const firstCell = formatImportCell((raw[0] as unknown[])[0]).trim();
  if (firstCell.startsWith(BRAND_APP_NAME)) {
    headerRowIdx = 1;
  }
  if (raw.length <= headerRowIdx) return { headers: null, dataStartIdx: 0, error: 'No header row found' };

  const rawHeaders = (raw[headerRowIdx] as unknown[]).map(h => formatImportCell(h).trim());
  const lastNonEmpty = rawHeaders.reduce((last, h, i) => h !== '' ? i : last, -1);
  if (lastNonEmpty === -1) return { headers: null, dataStartIdx: 0, error: 'No column headers found' };
  const impHeaders = rawHeaders.slice(0, lastNonEmpty + 1);

  const blankIdx = impHeaders.findIndex(h => h === '');
  if (blankIdx !== -1) return { headers: null, dataStartIdx: 0, error: `Blank header at column ${blankIdx + 1}` };

  const seen = new Set<string>();
  for (const h of impHeaders) {
    if (seen.has(h)) return { headers: null, dataStartIdx: 0, error: `Duplicate header "${h}"` };
    seen.add(h);
  }

  if (impHeaders.some(h => h.length > 100)) return { headers: null, dataStartIdx: 0, error: 'Header too long' };

  return { headers: impHeaders, dataStartIdx: headerRowIdx + 1 };
}

function buildJsrExportBuffer(headers: string[], dataRows: string[][]): ArrayBuffer {
  const titleText = `${BRAND_APP_NAME}  ·  MRC Project  ·  FTK     (Export: 2026-08-15)`;
  const wb = XLSX.utils.book_new();
  const wsData: unknown[][] = [
    [titleText, '', '', '', ''],  // row 1: title (merged cell simulated as first col, rest empty)
    headers,                        // row 2: real headers
    ...dataRows,                    // row 3+: data
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'FTK');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return buf;
}

function buildPlainExcelBuffer(headers: string[], dataRows: string[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  const wsData: unknown[][] = [headers, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return buf;
}

function readRaw(buf: ArrayBuffer): unknown[][] {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' }) as unknown[][];
}

const SECTION_COLS = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];
const DATA_ROW_1 = ['1001', 'Baghdad', '2026-01-15', 'Accepted', 'Test site'];
const DATA_ROW_2 = ['1002', 'Basra', '2026-02-20', 'Pending', ''];

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

console.log('\n=== Import Parse Logic QA ===\n');

// ── TEST 1: JSR export round-trip header detection ─────────────────────────
console.log('TEST 1 — JSR export: title row detected, real headers extracted');
{
  const buf = buildJsrExportBuffer(SECTION_COLS, [DATA_ROW_1, DATA_ROW_2]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('headers detected', result.headers !== null, result.error);
  assert('title row skipped', result.headers?.[0] !== BRAND_APP_NAME);
  assert('header[0] = Site ID', result.headers?.[0] === 'Site ID', JSON.stringify(result.headers));
  assert('header[4] = Comment', result.headers?.[4] === 'Comment');
  assert('header count = 5', result.headers?.length === 5, String(result.headers?.length));
  assert('dataStartIdx = 2', result.dataStartIdx === 2, String(result.dataStartIdx));

  // Verify data rows are correctly indexed
  const dataRows = (raw.slice(result.dataStartIdx) as unknown[][])
    .filter(r => r.some(v => formatImportCell(v).trim() !== ''))
    .map(r => result.headers!.map((_, i) => formatImportCell(r[i])));
  assert('data row count = 2', dataRows.length === 2, String(dataRows.length));
  assert('data row 1 site ID', dataRows[0][0] === '1001', dataRows[0][0]);
}

// ── TEST 2: Plain Excel (no title row) ────────────────────────────────────
console.log('\nTEST 2 — Plain Excel: headers in row 1, no title skip');
{
  const buf = buildPlainExcelBuffer(SECTION_COLS, [DATA_ROW_1]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('headers detected', result.headers !== null, result.error);
  assert('header[0] = Site ID', result.headers?.[0] === 'Site ID');
  assert('header count = 5', result.headers?.length === 5);
  assert('dataStartIdx = 1', result.dataStartIdx === 1, String(result.dataStartIdx));
}

// ── TEST A: Wrong columns (headers differ) ────────────────────────────────
console.log('\nTEST A — Wrong columns: parse succeeds but section comparison blocks');
{
  const wrongCols = ['Site ID', 'City', 'Date', 'Status'];
  const buf = buildJsrExportBuffer(wrongCols, [['1001', 'Baghdad', '2026-01-15', 'OK']]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('parse succeeds', result.headers !== null);
  // Simulate the schema comparison:
  const match = result.headers!.length === SECTION_COLS.length &&
    result.headers!.every((h, i) => h === SECTION_COLS[i]);
  assert('schema mismatch detected', !match, 'should be false');
}

// ── TEST B: Malformed — title only, no real header row ───────────────────
console.log('\nTEST B — Malformed: title row only, no header row follows');
{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([[`${BRAND_APP_NAME} · Test`]]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('no header row → error', result.headers === null, result.error);
}

// ── TEST C: Blank header in middle of column set ──────────────────────────
console.log('\nTEST C — Blank header in column set');
{
  const buf = buildPlainExcelBuffer(['Site ID', '', 'Comment'], [['1001', '', 'Note']]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('blank header → error', result.headers === null, result.error);
}

// ── TEST D: Duplicate header names ───────────────────────────────────────
console.log('\nTEST D — Duplicate header names');
{
  const buf = buildPlainExcelBuffer(['Site ID', 'Status', 'Status'], [['1001', 'OK', 'dup']]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  assert('duplicate header → error', result.headers === null, result.error);
}

// ── TEST E: Title row would have been treated as header (old bug) ─────────
console.log('\nTEST E — Regression: old bug reproduced then fixed');
{
  // Simulate what the old code would have done (read raw[0] as headers):
  const buf = buildJsrExportBuffer(SECTION_COLS, [DATA_ROW_1]);
  const raw = readRaw(buf);
  const oldBugHeaders = (raw[0] as unknown[]).map(h => formatImportCell(h).trim());
  assert('old bug: title in header[0]', oldBugHeaders[0].startsWith(BRAND_APP_NAME));

  // New code correctly skips it:
  const result = parseHeaders(raw);
  assert('new code: title NOT in header[0]', result.headers?.[0] === 'Site ID');
}

// ── TEST F: JSR export data values correct after parse ────────────────────
console.log('\nTEST F — Data values correctly extracted after title skip');
{
  const buf = buildJsrExportBuffer(SECTION_COLS, [DATA_ROW_1, DATA_ROW_2]);
  const raw = readRaw(buf);
  const result = parseHeaders(raw);
  const dataRows = (raw.slice(result.dataStartIdx) as unknown[][])
    .filter(r => r.some(v => formatImportCell(v).trim() !== ''))
    .map(r => result.headers!.map((_, i) => formatImportCell(r[i])));
  assert('2 data rows extracted', dataRows.length === 2, String(dataRows.length));
  assert('row1 governate = Baghdad', dataRows[0][1] === 'Baghdad', dataRows[0][1]);
  assert('row2 site ID = 1002', dataRows[1][0] === '1002', dataRows[1][0]);
  assert('row2 comment = empty', dataRows[1][4] === '', `"${dataRows[1][4]}"`);
}

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
