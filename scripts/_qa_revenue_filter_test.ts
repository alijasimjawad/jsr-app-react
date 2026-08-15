/**
 * Focused unit test for FinRevenue filteredRows() logic.
 *
 * Verifies:
 *   1. Default (All Months / All Years) shows null-month/year rows.
 *   2. Explicit month+year filter correctly includes matching rows.
 *   3. Explicit month+year filter correctly excludes non-matching rows.
 *   4. Project filter works independently of month/year.
 *   5. Null-month row is excluded when a specific month filter is applied.
 *
 * This is a pure logic test — no Supabase calls, no React, no network.
 * Run: npx tsx scripts/_qa_revenue_filter_test.ts
 */

// ── Mirror of FinRevenue RevRow interface ────────────────────────────────────
interface RevRow {
  id: string;
  project_name: string | null;
  section_name: string | null;
  site_id: string | null;
  amount: number;
  invoice_date: string | null;
  month: number | null;
  year: number | null;
  status: string | null;
  notes: string | null;
  added_by: string | null;
}

// ── Mirror of FinRevenue filteredRows() — exact same logic ───────────────────
function filteredRows(
  rows: RevRow[],
  fProj: string,
  fMonth: number,
  fYear: number,
): RevRow[] {
  return rows.filter(r =>
    (!fProj  || r.project_name === fProj) &&
    (!fMonth || r.month === fMonth) &&
    (!fYear  || r.year  === fYear),
  );
}

// ── Test fixtures ─────────────────────────────────────────────────────────────
const baseRow = (overrides: Partial<RevRow>): RevRow => ({
  id: 'test-id',
  project_name: 'MRC Project',
  section_name: 'TDD',
  site_id: 'SITE-001',
  amount: 0,
  invoice_date: null,
  month: null,
  year: null,
  status: 'Implemented - Pending ATP',
  notes: null,
  added_by: 'Test Runner',
  ...overrides,
});

const ROW_NULL_DATE   = baseRow({ id: 'r1', site_id: '5555', month: null, year: null });
const ROW_AUG_2026    = baseRow({ id: 'r2', site_id: '1001', month: 8,    year: 2026, invoice_date: '2026-08-01' });
const ROW_JAN_2026    = baseRow({ id: 'r3', site_id: '1002', month: 1,    year: 2026, invoice_date: '2026-01-15' });
const ROW_OTHER_PROJ  = baseRow({ id: 'r4', site_id: '2001', project_name: 'IPT Project', month: 8, year: 2026 });
const ALL_ROWS        = [ROW_NULL_DATE, ROW_AUG_2026, ROW_JAN_2026, ROW_OTHER_PROJ];

let passed = 0; let failed = 0;
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS  ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
function ids(rows: RevRow[]): string[] { return rows.map(r => r.id); }

console.log('\n=== FinRevenue filteredRows() Logic Test ===\n');

// ── Test 1: Default (All Months = 0, All Years = 0) ──────────────────────────
console.log('1. Default filters (fMonth=0, fYear=0) → All rows visible');
{
  const result = filteredRows(ALL_ROWS, '', 0, 0);
  assert('1.1  null-month row visible',     result.some(r => r.id === 'r1'));
  assert('1.2  Aug 2026 row visible',       result.some(r => r.id === 'r2'));
  assert('1.3  Jan 2026 row visible',       result.some(r => r.id === 'r3'));
  assert('1.4  other project row visible',  result.some(r => r.id === 'r4'));
  assert('1.5  total = 4 rows',             result.length === 4, `got ${result.length}`);
}

// ── Test 2: Explicit month+year filter includes matching rows ─────────────────
console.log('\n2. fMonth=8, fYear=2026 → only August 2026 rows (null-month excluded)');
{
  const result = filteredRows(ALL_ROWS, '', 8, 2026);
  assert('2.1  Aug 2026 MRC row visible',  result.some(r => r.id === 'r2'));
  assert('2.2  Aug 2026 IPT row visible',  result.some(r => r.id === 'r4'));
  assert('2.3  null-month row excluded',   !result.some(r => r.id === 'r1'),
    `ids=${ids(result).join(',')}`);
  assert('2.4  Jan 2026 row excluded',     !result.some(r => r.id === 'r3'));
  assert('2.5  total = 2 rows',            result.length === 2, `got ${result.length}`);
}

// ── Test 3: Month-only filter ─────────────────────────────────────────────────
console.log('\n3. fMonth=8, fYear=0 (All Years) → all August rows regardless of year');
{
  const result = filteredRows(ALL_ROWS, '', 8, 0);
  assert('3.1  Aug 2026 MRC visible',      result.some(r => r.id === 'r2'));
  assert('3.2  Aug 2026 IPT visible',      result.some(r => r.id === 'r4'));
  assert('3.3  null-month excluded',       !result.some(r => r.id === 'r1'));
  assert('3.4  Jan 2026 excluded',         !result.some(r => r.id === 'r3'));
}

// ── Test 4: Year-only filter ──────────────────────────────────────────────────
console.log('\n4. fMonth=0, fYear=2026 → all 2026 rows regardless of month');
{
  const result = filteredRows(ALL_ROWS, '', 0, 2026);
  assert('4.1  Aug 2026 MRC visible',      result.some(r => r.id === 'r2'));
  assert('4.2  Jan 2026 visible',          result.some(r => r.id === 'r3'));
  assert('4.3  Aug 2026 IPT visible',      result.some(r => r.id === 'r4'));
  assert('4.4  null-month excluded',       !result.some(r => r.id === 'r1'),
    `ids=${ids(result).join(',')}`);
}

// ── Test 5: Project filter with default date filters ──────────────────────────
console.log('\n5. fProj="MRC Project", fMonth=0, fYear=0 → only MRC rows');
{
  const result = filteredRows(ALL_ROWS, 'MRC Project', 0, 0);
  assert('5.1  null-month MRC row visible', result.some(r => r.id === 'r1'));
  assert('5.2  Aug 2026 MRC row visible',  result.some(r => r.id === 'r2'));
  assert('5.3  Jan 2026 MRC row visible',  result.some(r => r.id === 'r3'));
  assert('5.4  IPT row excluded',          !result.some(r => r.id === 'r4'));
  assert('5.5  total = 3 rows',            result.length === 3, `got ${result.length}`);
}

// ── Test 6: Project + month filter combined ───────────────────────────────────
console.log('\n6. fProj="MRC Project", fMonth=8, fYear=2026 → MRC August 2026 only');
{
  const result = filteredRows(ALL_ROWS, 'MRC Project', 8, 2026);
  assert('6.1  Aug 2026 MRC visible',      result.some(r => r.id === 'r2'));
  assert('6.2  null-month excluded',       !result.some(r => r.id === 'r1'));
  assert('6.3  Jan 2026 excluded',         !result.some(r => r.id === 'r3'));
  assert('6.4  IPT row excluded',          !result.some(r => r.id === 'r4'));
  assert('6.5  total = 1 row',             result.length === 1, `got ${result.length}`);
}

// ── Test 7: Empty rows → no crash ─────────────────────────────────────────────
console.log('\n7. Empty rows array → returns empty (no crash)');
{
  const result = filteredRows([], '', 0, 0);
  assert('7.1  returns empty array', result.length === 0);
}

// ── Test 8: The exact bug scenario (old default = Aug 2026) ───────────────────
console.log('\n8. OLD bug: fMonth=8 fYear=2026 → null-month auto-sync row was invisible');
{
  const autoSyncRow = baseRow({ id: 'auto', site_id: '5555', month: null, year: null });
  const bugResult   = filteredRows([autoSyncRow], '', 8, 2026);
  const fixResult   = filteredRows([autoSyncRow], '', 0, 0);
  assert('8.1  OLD default (Aug 2026) hid the row', bugResult.length === 0,
    `expected 0, got ${bugResult.length}`);
  assert('8.2  NEW default (All) shows the row',    fixResult.length === 1,
    `expected 1, got ${fixResult.length}`);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
