// src/lib/invoiceCalc.ts
//
// Pure, deterministic calculation helpers for the client-facing invoice
// redesign. No React, no Supabase — this module is intentionally small
// enough that the Phase 4 print template can import it without dragging
// the invoice page in.
//
// All helpers coerce nulls/undefined to 0 internally to keep NaN out of
// the UI. Display-oriented helpers (remainingSiteValue, remainingPOValue)
// clamp to >= 0 so a legacy over-billed row never renders a negative
// number in the picker. Validation callers must NEVER rely on the clamp
// — the raw arithmetic (previouslyInvoiced + newAmount vs. cap) is what
// blocks a save, and it must see the true overshoot.
//
// Exports match names exactly — Phase 4 will import from here.
//
// NOTE on naming: this module deliberately re-uses the name `outstanding`
// alongside a top-level `invoiceTotal(subtotal, discount, tax)` helper.
// The existing FinInvoices.tsx print helper defines its own local
// `outstanding` variable inside `printInvoice()`; that stays untouched
// in Phase 3B (spec §5).

function n(v: number | null | undefined): number {
  const x = +(v ?? 0);
  return Number.isFinite(x) ? x : 0;
}

export function outstanding(invoiceTotal: number, received: number): number {
  return n(invoiceTotal) - n(received);
}

export function paymentPercentage(invoiceTotal: number, received: number): number {
  const t = n(invoiceTotal);
  if (t <= 0) return 0;
  return (n(received) / t) * 100;
}

export function previouslyInvoicedForRevenue(
  history: Array<{ revenue_id: string | null; amount: number; invoice_id: string }>,
  revenueId: string,
  excludeInvoiceId?: string | null,
): number {
  if (!revenueId) return 0;
  let sum = 0;
  for (const row of history) {
    if (row.revenue_id !== revenueId) continue;
    if (excludeInvoiceId && row.invoice_id === excludeInvoiceId) continue;
    sum += n(row.amount);
  }
  return sum;
}

export function remainingSiteValue(revenueAmount: number, previouslyInvoiced: number): number {
  return Math.max(n(revenueAmount) - n(previouslyInvoiced), 0);
}

// Three-state classification for a Site row in the invoice picker.
//   • 'missing_value'   — revenue.amount is null/NaN/<=0. UI shows an
//                         amber "Commercial Value Missing" badge; row is
//                         not selectable; save is blocked if it slips in.
//   • 'fully_invoiced'  — revenue.amount > 0 AND previouslyInvoiced has
//                         reached (or exceeded) it. UI shows the neutral
//                         "Fully Invoiced" badge; row is not selectable.
//   • 'available'       — revenue.amount > 0 AND some remaining value is
//                         still billable. UI shows the row as normal.
// Zero-value sites deliberately do NOT collapse into 'fully_invoiced':
// classifying "0 remaining because commercial=0" as fully-billed masks a
// data-quality problem (the site never had a commercial value assigned).
// Keep `remainingSiteValue` unchanged — it still clamps to >=0 for pure
// display math (line-item derivation, PO consumption) elsewhere.
export type SiteBillingStatus = 'missing_value' | 'fully_invoiced' | 'available';

export function siteBillingStatus(
  revenueAmount: number | null | undefined,
  previouslyInvoiced: number,
): SiteBillingStatus {
  const amt = Number(revenueAmount);
  if (!Number.isFinite(amt) || amt <= 0) return 'missing_value';
  if (n(previouslyInvoiced) >= amt) return 'fully_invoiced';
  return 'available';
}

export function billedCommercialValueForPO(
  history: Array<{ invoice_id: string; amount: number }>,
  invoicePoMap: Map<string, string | null>,
  poId: string,
  excludeInvoiceId?: string | null,
): number {
  if (!poId) return 0;
  let sum = 0;
  for (const row of history) {
    if (excludeInvoiceId && row.invoice_id === excludeInvoiceId) continue;
    const rowPo = invoicePoMap.get(row.invoice_id) ?? null;
    if (rowPo !== poId) continue;
    sum += n(row.amount);
  }
  return sum;
}

export function remainingPOValue(poAmount: number, billed: number): number {
  return Math.max(n(poAmount) - n(billed), 0);
}

export function invoiceSubtotal(items: Array<{ amount: number }>): number {
  let sum = 0;
  for (const it of items) sum += n(it.amount);
  return sum;
}

export function invoiceTotal(subtotal: number, discount: number, tax: number): number {
  return n(subtotal) - n(discount) + n(tax);
}
