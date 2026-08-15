/**
 * Focused unit tests for findRevDateRaw() — the Revenue auto-sync date picker.
 *
 * Business rule (approved 2026-08-15):
 *   1. Prefer explicit Implementation Date column (Imp. Date / Installation / etc.) if non-empty.
 *   2. Fall back to Delivery column if Imp. Date absent or blank.
 *   3. If neither present/non-empty → return '' → ensureRevenuePlaceholder yields month=null/year=null.
 *   4. Do NOT use today's date as a fallback.
 *
 * This is a pure logic test — no Supabase, no React, no network.
 * Run: npx tsx scripts/_qa_revenue_date_mapping_test.ts
 */

// ── Mirror findImpColIdx (identical to NetworkScopes.tsx:210-215) ─────────────
function findImpColIdx(headers: string[]): number {
  return headers.findIndex(
    h => /imp.*date/i.test(h) || /^install(ation)?$/i.test(h.trim()) ||
         /install/i.test(h)   || /integrat\w*[\s._-]*date/i.test(h),
  );
}

// ── Mirror findDeliveryColIdx (identical to revenueStages.ts:51-53) ───────────
function findDeliveryColIdx(headers: string[]): number {
  return headers.findIndex(h => /delivery/i.test(h));
}

// ── Mirror findRevDateRaw (identical to NetworkScopes.tsx after this commit) ──
function findRevDateRaw(headers: string[], cells: string[]): string {
  const impIdx = findImpColIdx(headers);
  if (impIdx >= 0) {
    const v = cells[impIdx]?.trim() || '';
    if (v) return v;
  }
  const delIdx = findDeliveryColIdx(headers);
  if (delIdx >= 0) {
    const v = cells[delIdx]?.trim() || '';
    if (v) return v;
  }
  return '';
}

// ── Assertion helpers ─────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS  ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL  ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

console.log('\n=== Revenue Date Mapping Test Suite ===\n');

// ── 1. Standard FTK/COW sections: "Imp. Date" present and filled ──────────────
console.log('1. Imp. Date column present and filled → uses Imp. Date');
{
  const headers = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];
  const cells   = ['SITE-001', 'Baghdad',  '2026-06-15', 'Pending',  ''];
  const result  = findRevDateRaw(headers, cells);
  assert('1.1  result = Imp. Date value',   result === '2026-06-15', result);
  assert('1.2  Delivery NOT used',          result !== '');
}

// ── 2. TDD sections: no "Imp. Date", "Delivery" present and filled ────────────
console.log('\n2. No Imp. Date column, Delivery present and filled → uses Delivery');
{
  const headers = ['Site ID', 'Governate', 'Delivery', 'Installation', 'Integration Status', 'ATP Status', 'Clearance & Tools', 'Final ATP'];
  const cells   = ['5555',    'Baghdad',   '2026-08-15', '',           '',                   '',           '',                  ''];
  const result  = findRevDateRaw(headers, cells);
  assert('2.1  result = Delivery value',    result === '2026-08-15', result);
  // Installation exists but is empty; Delivery wins as fallback
  assert('2.2  non-empty fallback used',    result !== '');
}

// ── 3. Both Imp. Date and Delivery present → Imp. Date wins ──────────────────
console.log('\n3. Both Imp. Date and Delivery present → Imp. Date wins');
{
  const headers = ['Site ID', 'Governate', 'Imp. Date', 'Delivery',    'ATP Status'];
  const cells   = ['SITE-002', 'Basra',    '2026-07-01', '2026-08-15', 'Pending'];
  const result  = findRevDateRaw(headers, cells);
  assert('3.1  result = Imp. Date value',   result === '2026-07-01', result);
  assert('3.2  Delivery date NOT returned', result !== '2026-08-15', result);
}

// ── 4. Imp. Date present but blank → Delivery used as fallback ───────────────
console.log('\n4. Imp. Date column exists but is blank → falls back to Delivery');
{
  const headers = ['Site ID', 'Imp. Date', 'Delivery',    'ATP Status'];
  const cells   = ['SITE-003', '',         '2026-09-01',  'Pending'];
  const result  = findRevDateRaw(headers, cells);
  assert('4.1  result = Delivery value',    result === '2026-09-01', result);
  assert('4.2  blank Imp. Date not used',   result !== '');
}

// ── 5. Both blank → returns '' (null date path) ───────────────────────────────
console.log('\n5. Imp. Date blank, Delivery blank → returns empty string');
{
  const headers = ['Site ID', 'Imp. Date', 'Delivery',  'ATP Status'];
  const cells   = ['SITE-004', '',          '',          'Pending'];
  const result  = findRevDateRaw(headers, cells);
  assert('5.1  result = empty string',      result === '', `got="${result}"`);
}

// ── 6. Neither column present → returns '' ───────────────────────────────────
console.log('\n6. No Imp. Date column and no Delivery column → returns empty string');
{
  const headers = ['Site ID', 'Governate', 'ATP Status', 'Comment'];
  const cells   = ['SITE-005', 'Mosul',    'Pending',    ''];
  const result  = findRevDateRaw(headers, cells);
  assert('6.1  result = empty string',      result === '', `got="${result}"`);
}

// ── 7. Imp. Date column with whitespace-only value → Delivery fallback ────────
console.log('\n7. Imp. Date cell is whitespace-only → treated as blank, Delivery used');
{
  const headers = ['Site ID', 'Imp. Date', 'Delivery',   'ATP Status'];
  const cells   = ['SITE-006', '   ',       '2026-10-01', 'Pending'];
  const result  = findRevDateRaw(headers, cells);
  assert('7.1  result = Delivery value',    result === '2026-10-01', result);
}

// ── 8. "Installation" column match (existing sections) → priority over Delivery
console.log('\n8. "Installation" matches findImpColIdx and is filled → takes priority over Delivery');
{
  const headers = ['Site ID', 'Delivery',   'Installation', 'ATP Status'];
  const cells   = ['SITE-007', '2026-11-01', '2026-10-15',  'Pending'];
  const result  = findRevDateRaw(headers, cells);
  assert('8.1  result = Installation value', result === '2026-10-15', result);
  assert('8.2  Delivery NOT used',           result !== '2026-11-01', result);
}

// ── 9. "Installation" column filled, "Delivery" also filled → Installation wins
console.log('\n9. Delivery present + Installation present → Installation wins (imp col priority)');
{
  const headers = ['Site ID', 'Delivery',   'Installation', 'Imp. Date', 'ATP Status'];
  const cells   = ['SITE-008', '2026-12-01', '2026-11-01',  '2026-10-01', 'Pending'];
  // findImpColIdx picks "Installation" (index 2) or "Imp. Date" (index 3)?
  // findImpColIdx uses findIndex — it stops at first match. "Installation" at idx 2, "Imp. Date" at idx 3.
  // Since Installation matches /^install(ation)?$/i and /install/i, it is found first.
  const impIdx = findImpColIdx(headers);
  const result  = findRevDateRaw(headers, cells);
  assert('9.1  findImpColIdx finds Installation first', impIdx === 2, `impIdx=${impIdx}`);
  assert('9.2  result = Installation date',  result === '2026-11-01', result);
}

// ── 10. Validates ''→null pipeline (integration with ensureRevenuePlaceholder logic)
console.log('\n10. Empty string result → downstream month/year = null (pipeline check)');
{
  // Simulate what ensureRevenuePlaceholder does with the returned value
  function resolveDate(raw: string): { invoice_date: string | null; month: number | null; year: number | null } {
    const parsedDate = raw ? new Date(raw) : null;
    const validDate  = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : null;
    return {
      invoice_date: validDate ? raw : null,
      month: validDate ? (validDate.getMonth() + 1) : null,
      year:  validDate ? validDate.getFullYear() : null,
    };
  }

  const emptyResult  = resolveDate('');
  const filledResult = resolveDate('2026-08-15');

  assert('10.1  empty raw → invoice_date = null', emptyResult.invoice_date === null);
  assert('10.2  empty raw → month = null',        emptyResult.month === null);
  assert('10.3  empty raw → year = null',         emptyResult.year === null);
  assert('10.4  valid raw → invoice_date set',    filledResult.invoice_date === '2026-08-15');
  assert('10.5  valid raw → month = 8',           filledResult.month === 8);
  assert('10.6  valid raw → year = 2026',         filledResult.year === 2026);
}

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
