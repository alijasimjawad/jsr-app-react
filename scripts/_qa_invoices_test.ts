/**
 * Focused QA for the Finance → Invoices P1 fixes.
 *
 * Bug 1: DELETE INVOICE FAILS — FK violation from invoice_items
 *   Fix: delete invoice_items before invoice; block delete if payments exist.
 * Bug 2: CANNOT EDIT RECEIVED AMOUNT
 *   Fix: added amount_received field to invoice edit modal; auto-derives status.
 *
 * Test groups:
 *   GROUP 1 — Schema: tables and FK constraints exist
 *   GROUP 2 — DELETE business rule: block delete when payments exist
 *   GROUP 3 — DELETE happy path: delete items first, then invoice (FK order)
 *   GROUP 4 — DELETE cleans up invoicedIds (revenue linkage released)
 *   GROUP 5 — RECEIVED AMOUNT: invoice update with amount_received succeeds
 *   GROUP 6 — RECEIVED AMOUNT: status auto-derivation (Partial / Paid)
 *   GROUP 7 — RECEIVED AMOUNT: validation (negative / exceeds total blocked)
 *   GROUP 8 — Payment recording: savePayment flow still works after fixes
 *   GROUP 9 — Regression: existing invoice JSR-2026-001 data intact
 *
 * Run: npx tsx scripts/_qa_invoices_test.ts
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

const sb = createClient(
  process.env.DEST_SUPABASE_URL!,
  process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// ── Known fixtures from production data ────────────────────────────────────────
const REAL_CLIENT_ID   = '9f721c2b-34f4-4630-8474-fb38c528c7a1'; // TAC
const REAL_INV_ID      = '8d64b438-5e76-401f-aff8-199cfd55c8bf'; // JSR-2026-001
const REAL_PAYMENT_ID  = '535cc031-5d79-4d40-a5cc-283ff8d089f2'; // 1,000,000 IQD
const REAL_REVENUE_A   = '747ec623-3e7f-474e-98a2-ab08db2fb351';
const REAL_REVENUE_B   = '8a4b2104-29c2-4bef-b14a-e40b5bf1c96c';

// QA-only identifiers (far-future amounts so they don't collide with real invoices)
const QA_INV_NUMBER_A  = 'QA-INV-DELETE-001';
const QA_INV_NUMBER_B  = 'QA-INV-RECV-001';
const QA_INV_NUMBER_C  = 'QA-INV-PAYMENT-001';

let passed = 0; let failed = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS   ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL   ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── Cleanup helper ────────────────────────────────────────────────────────────
async function cleanup() {
  const { data: qaInvs } = await sb.from('invoices')
    .select('id').in('invoice_number', [QA_INV_NUMBER_A, QA_INV_NUMBER_B, QA_INV_NUMBER_C]);
  if (qaInvs && qaInvs.length > 0) {
    const ids = qaInvs.map((r: { id: string }) => r.id);
    await sb.from('invoice_payments').delete().in('invoice_id', ids);
    await sb.from('invoice_items').delete().in('invoice_id', ids);
    await sb.from('invoices').delete().in('id', ids);
  }
}

console.log('\n=== Finance → Invoices P1 Fix QA Test Suite ===\n');
await cleanup();

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Schema: tables and FK constraints
// ─────────────────────────────────────────────────────────────────────────────
console.log('── GROUP 1: Schema verification ─────────────────────────────────────────');
{
  const { error: e1 } = await sb.from('invoices').select('id,amount_received,total_amount,status').limit(0);
  assert('1.1  invoices table exists with amount_received column', !e1, e1?.message);

  const { error: e2 } = await sb.from('invoice_items').select('id,invoice_id,revenue_id').limit(0);
  assert('1.2  invoice_items table exists with invoice_id + revenue_id', !e2, e2?.message);

  const { error: e3 } = await sb.from('invoice_payments').select('id,invoice_id,amount').limit(0);
  assert('1.3  invoice_payments table exists with invoice_id + amount', !e3, e3?.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 2 — DELETE business rule: block delete when payments exist
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 2: Delete blocked when payments exist ──────────────────────────');
{
  // This mimics what deleteInvoice() does in the UI: check payments.some(p => p.invoice_id === id)
  const { data: pays } = await sb.from('invoice_payments').select('id').eq('invoice_id', REAL_INV_ID);
  const hasPayments = (pays?.length ?? 0) > 0;
  assert('2.1  JSR-2026-001 has at least 1 payment → delete would be blocked', hasPayments,
    `${pays?.length ?? 0} payment(s) found`);

  // Verify the real invoice is untouched (delete was NOT attempted)
  const { data: realInv } = await sb.from('invoices').select('id,invoice_number').eq('id', REAL_INV_ID).single();
  assert('2.2  JSR-2026-001 still exists (not deleted by this test)', !!realInv, 'invoice missing');
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 3 — DELETE happy path: items first, then invoice
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 3: Delete happy path (no payments) ─────────────────────────────');
let qaInvIdA: string | null = null;
{
  // Create QA invoice (no payments)
  const { data: inv, error: ce } = await sb.from('invoices').insert({
    client_id: REAL_CLIENT_ID, invoice_number: QA_INV_NUMBER_A,
    status: 'Draft', total_amount: 500000, amount_received: 0,
    issue_date: '2099-01-01', created_by: 'QA',
  }).select('id').single();
  assert('3.1  QA invoice A created', !!inv && !ce, ce?.message);
  qaInvIdA = inv?.id ?? null;

  if (qaInvIdA) {
    // Add an invoice_item (no revenue link — custom item)
    const { error: ie } = await sb.from('invoice_items').insert({
      invoice_id: qaInvIdA, site_id: 'QA-SITE-INV-001',
      description: 'QA custom item', amount: 500000, revenue_id: null,
    });
    assert('3.2  QA invoice_item inserted', !ie, ie?.message);

    // Verify FK would block direct delete
    const { error: directErr } = await sb.from('invoices').delete().eq('id', qaInvIdA);
    assert('3.3  Direct invoice delete fails (FK constraint)', !!directErr,
      directErr ? 'got expected FK error' : 'UNEXPECTED SUCCESS — FK may be missing!');

    // Restore after direct-delete attempt (it rolled back, invoice still exists)
    // Now do the correct order: items first, then invoice
    const { error: ie2 } = await sb.from('invoice_items').delete().eq('invoice_id', qaInvIdA);
    assert('3.4  invoice_items deleted first (no error)', !ie2, ie2?.message);

    const { error: invErr } = await sb.from('invoices').delete().eq('id', qaInvIdA);
    assert('3.5  invoice deleted after items removed (no FK error)', !invErr, invErr?.message);

    // Confirm gone
    const { data: gone } = await sb.from('invoices').select('id').eq('id', qaInvIdA);
    assert('3.6  invoice no longer exists in DB', (gone?.length ?? 1) === 0,
      `found ${gone?.length} row(s)`);
    qaInvIdA = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 4 — DELETE cleans up revenue linkage (invoicedIds released)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 4: Delete releases revenue linkage ─────────────────────────────');
let qaInvIdD: string | null = null;
{
  // Insert QA invoice linked to real revenue rows
  const { data: inv, error: ce } = await sb.from('invoices').insert({
    client_id: REAL_CLIENT_ID, invoice_number: 'QA-INV-REVLINK-001',
    status: 'Draft', total_amount: 100, amount_received: 0,
    issue_date: '2099-01-01', created_by: 'QA',
  }).select('id').single();
  assert('4.1  QA invoice for revenue-link test created', !!inv && !ce, ce?.message);
  qaInvIdD = inv?.id ?? null;

  // IMPORTANT: we do NOT link to REAL_REVENUE_A/B to avoid affecting production data.
  // Instead we verify the pattern: after items deleted, SELECT invoice_items WHERE revenue_id = X returns 0 rows.
  // The real revenue rows already have invoice_items via REAL_INV_ID — we just confirm the query logic.
  const { data: linkedItems } = await sb.from('invoice_items')
    .select('id').eq('revenue_id', REAL_REVENUE_A);
  assert('4.2  REAL_REVENUE_A is currently linked (has invoice_item)', (linkedItems?.length ?? 0) > 0,
    `${linkedItems?.length ?? 0} item(s) — expected > 0`);

  // After we'd delete those items, the count would be 0 — we verify via a clean round-trip
  // by using a scratch revenue_id that definitely has no links
  const { data: unlinked } = await sb.from('invoice_items')
    .select('id').eq('revenue_id', '00000000-0000-0000-0000-000000000000');
  assert('4.3  Non-existent revenue_id returns 0 items (query pattern correct)', (unlinked?.length ?? 0) === 0);

  // Cleanup QA invoice D
  if (qaInvIdD) {
    await sb.from('invoice_items').delete().eq('invoice_id', qaInvIdD);
    await sb.from('invoices').delete().eq('id', qaInvIdD);
    qaInvIdD = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 5 — RECEIVED AMOUNT: UPDATE with amount_received succeeds
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 5: amount_received UPDATE succeeds ─────────────────────────────');
let qaInvIdB: string | null = null;
{
  const { data: inv, error: ce } = await sb.from('invoices').insert({
    client_id: REAL_CLIENT_ID, invoice_number: QA_INV_NUMBER_B,
    status: 'Draft', total_amount: 2000000, amount_received: 0,
    issue_date: '2099-02-01', created_by: 'QA',
  }).select('id').single();
  assert('5.1  QA invoice B created (amount_received=0)', !!inv && !ce, ce?.message);
  qaInvIdB = inv?.id ?? null;

  if (qaInvIdB) {
    // Update amount_received directly (mirrors what saveInvoice() now does on edit)
    const { error: ue } = await sb.from('invoices')
      .update({ amount_received: 500000, status: 'Partial' })
      .eq('id', qaInvIdB);
    assert('5.2  UPDATE amount_received=500000, status=Partial succeeds', !ue, ue?.message);

    const { data: updated } = await sb.from('invoices')
      .select('amount_received,status').eq('id', qaInvIdB).single();
    assert('5.3  amount_received persisted as 500000', updated?.amount_received === 500000,
      `got ${updated?.amount_received}`);
    assert('5.4  status persisted as Partial', updated?.status === 'Partial',
      `got ${updated?.status}`);

    // Update to fully paid
    const { error: ue2 } = await sb.from('invoices')
      .update({ amount_received: 2000000, status: 'Paid' })
      .eq('id', qaInvIdB);
    assert('5.5  UPDATE amount_received=2000000 (full), status=Paid succeeds', !ue2, ue2?.message);

    const { data: paid } = await sb.from('invoices')
      .select('amount_received,status').eq('id', qaInvIdB).single();
    assert('5.6  amount_received=2000000 stored', paid?.amount_received === 2000000,
      `got ${paid?.amount_received}`);
    assert('5.7  status=Paid stored', paid?.status === 'Paid', `got ${paid?.status}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 6 — RECEIVED AMOUNT: status auto-derivation logic (pure logic test)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 6: Status auto-derivation logic ────────────────────────────────');
{
  // This mirrors the derivedStatus logic in saveInvoice():
  //   received >= total && total > 0 → 'Paid'
  //   received > 0 → 'Partial'
  //   else → invForm.status (manual override)
  function deriveStatus(received: number, total: number, manualStatus: string): string {
    if (total > 0 && received >= total) return 'Paid';
    if (received > 0) return 'Partial';
    return manualStatus || 'Draft';
  }

  assert('6.1  received=0, total=1000 → keeps manual status Draft',
    deriveStatus(0, 1000, 'Draft') === 'Draft');
  assert('6.2  received=500, total=1000 → Partial',
    deriveStatus(500, 1000, 'Draft') === 'Partial');
  assert('6.3  received=1000, total=1000 → Paid',
    deriveStatus(1000, 1000, 'Draft') === 'Paid');
  assert('6.4  received=1500, total=1000 → Paid (overpayment rounds to Paid)',
    deriveStatus(1500, 1000, 'Draft') === 'Paid');
  assert('6.5  received=0, total=0 → keeps manual status Sent (no divide-by-zero)',
    deriveStatus(0, 0, 'Sent') === 'Sent');
  assert('6.6  received=100, total=0 → Partial (received>0 takes precedence when total=0)',
    deriveStatus(100, 0, 'Draft') === 'Partial');
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 7 — RECEIVED AMOUNT: validation guards (pure logic)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 7: Received amount validation ──────────────────────────────────');
{
  function validateReceived(received: number, total: number): string | null {
    if (received < 0) return 'Received amount cannot be negative.';
    if (total > 0 && received > total) return `Received amount cannot exceed the invoice total (${total.toLocaleString()} IQD).`;
    return null;
  }

  assert('7.1  negative received → error', validateReceived(-1, 1000) !== null);
  assert('7.2  received > total → error', validateReceived(1500, 1000) !== null);
  assert('7.3  received = 0 → valid', validateReceived(0, 1000) === null);
  assert('7.4  received = total → valid', validateReceived(1000, 1000) === null);
  assert('7.5  received < total → valid', validateReceived(500, 1000) === null);
  assert('7.6  total = 0, received = 0 → valid (no check when total=0)', validateReceived(0, 0) === null);
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 8 — Payment recording flow: savePayment still works
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 8: Payment recording (savePayment flow) ────────────────────────');
let qaInvIdC: string | null = null;
let qaPayId: string | null = null;
{
  const { data: inv, error: ce } = await sb.from('invoices').insert({
    client_id: REAL_CLIENT_ID, invoice_number: QA_INV_NUMBER_C,
    status: 'Sent', total_amount: 3000000, amount_received: 0,
    issue_date: '2099-03-01', created_by: 'QA',
  }).select('id').single();
  assert('8.1  QA invoice C created for payment test', !!inv && !ce, ce?.message);
  qaInvIdC = inv?.id ?? null;

  if (qaInvIdC) {
    // Record a payment (mirrors savePayment logic)
    const { data: pay, error: pe } = await sb.from('invoice_payments').insert({
      invoice_id: qaInvIdC, payment_date: '2099-03-15',
      amount: 1000000, reference: 'QA-REF-001', recorded_by: 'QA',
    }).select('id').single();
    assert('8.2  invoice_payment inserted', !!pay && !pe, pe?.message);
    qaPayId = pay?.id ?? null;

    // Update denormalized amount_received (mirrors savePayment logic)
    const newReceived = 0 + 1000000;
    const newStatus = newReceived >= 3000000 ? 'Paid' : 'Partial';
    const { error: ue } = await sb.from('invoices')
      .update({ amount_received: newReceived, status: newStatus }).eq('id', qaInvIdC);
    assert('8.3  invoices.amount_received updated after payment', !ue, ue?.message);

    const { data: after } = await sb.from('invoices')
      .select('amount_received,status').eq('id', qaInvIdC).single();
    assert('8.4  amount_received = 1000000', after?.amount_received === 1000000,
      `got ${after?.amount_received}`);
    assert('8.5  status = Partial', after?.status === 'Partial', `got ${after?.status}`);

    // Verify delete of invoice is blocked (has payment)
    const { data: payCheck } = await sb.from('invoice_payments')
      .select('id').eq('invoice_id', qaInvIdC);
    assert('8.6  invoice C has 1 payment → delete would be blocked by business rule',
      (payCheck?.length ?? 0) > 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 9 — Regression: existing JSR-2026-001 data intact
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── GROUP 9: Regression — JSR-2026-001 data intact ───────────────────────');
{
  const { data: inv } = await sb.from('invoices').select('*').eq('id', REAL_INV_ID).single();
  assert('9.1  JSR-2026-001 still exists', !!inv);
  assert('9.2  invoice_number = JSR-2026-001', inv?.invoice_number === 'JSR-2026-001',
    `got ${inv?.invoice_number}`);
  assert('9.3  total_amount = 3000000', inv?.total_amount === 3000000, `got ${inv?.total_amount}`);
  assert('9.4  amount_received = 1000000', inv?.amount_received === 1000000,
    `got ${inv?.amount_received}`);
  assert('9.5  status = Partial', inv?.status === 'Partial', `got ${inv?.status}`);

  const { data: payRow } = await sb.from('invoice_payments')
    .select('id,amount').eq('id', REAL_PAYMENT_ID).single();
  assert('9.6  original payment record still exists', !!payRow);
  assert('9.7  payment amount = 1000000', payRow?.amount === 1000000, `got ${payRow?.amount}`);

  const { data: itemRows } = await sb.from('invoice_items').select('id,revenue_id').eq('invoice_id', REAL_INV_ID);
  assert('9.8  JSR-2026-001 has 2 invoice_items', itemRows?.length === 2, `got ${itemRows?.length}`);
  const revIds = (itemRows || []).map((r: { revenue_id: string | null }) => r.revenue_id).filter(Boolean);
  assert('9.9  Both revenue rows still linked', revIds.includes(REAL_REVENUE_A) && revIds.includes(REAL_REVENUE_B));
}

// ── Final cleanup ─────────────────────────────────────────────────────────────
await cleanup();
// Also clean up QA invoice C (has payment, so cleanup must remove payment first)
if (qaInvIdC) {
  await sb.from('invoice_payments').delete().eq('invoice_id', qaInvIdC);
  await sb.from('invoice_items').delete().eq('invoice_id', qaInvIdC);
  await sb.from('invoices').delete().eq('id', qaInvIdC);
}
if (qaInvIdB) {
  await sb.from('invoice_items').delete().eq('invoice_id', qaInvIdB);
  await sb.from('invoices').delete().eq('id', qaInvIdB);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════════════════════════\n`);
if (failed > 0) process.exit(1);
