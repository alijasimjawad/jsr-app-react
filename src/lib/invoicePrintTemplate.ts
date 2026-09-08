// src/lib/invoicePrintTemplate.ts
//
// Pure HTML builder for the external JSR Communications invoice.
//
// This module is intentionally React-free and Supabase-free. The caller
// (FinInvoices.tsx `printInvoice()` wrapper) assembles a fully-resolved
// `InvoicePrintModel` — every field the template needs — and this module
// returns the complete `<!doctype html>...</html>` document string.
//
// Phase 4.4 — premium redesign
//
// Design principles:
//   • No business calculations here. All monetary derivations
//     (previouslyInvoiced, remainingAfter, billedCommercialValueForPO,
//     remainingPOValue, subtotal, total, outstanding, receivedToDate) are
//     computed by the caller using src/lib/invoiceCalc.ts helpers and
//     passed in via the model. This keeps the calc/print concerns split
//     and lets tests exercise the helpers without a DOM.
//   • HTML escaping is mandatory for every DB-sourced text field: the
//     internal `escapeHtml()` helper maps `& < > " '`. Numbers are never
//     escaped (they come from typed accessors).
//   • The template runs in a *popup window* opened via
//     `window.open('', '_blank')` and populated with `document.write` —
//     the caller then calls `document.close()`. The template embeds a
//     small self-contained script that waits for every `<img>` to fire
//     `load`/`error` (Promise.all) before invoking `window.print()`.
//     A 1500ms safety `setTimeout` is included as a last-resort fallback
//     in case a browser blocks event dispatch, but the primary trigger
//     is the image-ready promise.
//   • Layout target: normal one-Site invoice fits on ONE A4 page
//     (portrait). Achieved via tight margins, a right-aligned totals
//     box, side-by-side progress cards, and populated-only rendering.
//   • Colour fidelity across engines: `-webkit-print-color-adjust: exact`
//     + `print-color-adjust: exact` on `body` and coloured elements.
//   • The template references the gold logo via a caller-supplied URL
//     (typically the Vite-bundled `src/assets/jsr-communications-gold.png`
//     asset URL). It never imports the asset itself — that would tie
//     this module to the bundler.

import type { PurchaseOrder, CompanySettings, BankAccount } from './invoiceTypes';

// ── Public model ─────────────────────────────────────────────────────

export interface InvoicePrintClient {
  company_name: string | null;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

export interface InvoicePrintLineItem {
  section_name: string | null;
  site_id: string | null;
  description: string | null;
  po_number: string | null;         // '' when line is not revenue-linked
  site_commercial: number | null;   // null → dash on print (custom line)
  previously_invoiced: number | null;
  this_invoice: number;
  remaining_after: number | null;
}

export interface InvoicePrintPayment {
  payment_date: string | null;
  amount: number;
  method: string | null;
  reference: string | null;
  notes: string | null;
  recorded_by: string | null;
}

export interface InvoicePrintModel {
  // Identity / dates
  invoice_number: string | null;
  status: string | null;
  issue_date: string | null;
  due_date: string | null;
  project_name: string | null;
  project_code: string | null;
  currency: string;                 // fallback 'IQD' when caller has no explicit currency

  // Milestone
  milestone_label: string | null;
  milestone_percent: number | null;

  // Notes (rendered as-is, escaped)
  notes: string | null;

  // Related rows (already narrowed to what the template renders)
  client: InvoicePrintClient | null;
  po: PurchaseOrder | null;
  company: CompanySettings | null;
  bank: BankAccount | null;         // best-match active/default for invoice currency

  // Line items (pre-derived — no calc in this module)
  items: InvoicePrintLineItem[];

  // Payment ledger (already recomputed from invoice_payments — NOT the
  // cached amount_received)
  payments: InvoicePrintPayment[];
  received_to_date: number;

  // Financial summary (already computed by caller)
  subtotal: number;
  discount: number;
  tax: number;
  total: number;                    // subtotal − discount + tax
  outstanding: number;              // total − received_to_date

  // PO billing progress (rendered only when `po` is present)
  po_previously_billed: number;     // billedCommercialValueForPO(history, ..., excluding this invoice)
  po_this_invoice_commercial: number; // subtotal of revenue-linked lines only
  po_total_billed_to_date: number;  // po_previously_billed + po_this_invoice_commercial
  po_remaining_to_invoice: number;  // remainingPOValue(po_amount, po_total_billed_to_date)

  // Presentation
  logo_url: string;                 // bundler-resolved URL for the gold logo
  bank_payment_reference: string;   // e.g. "INV-2026-001 / Baghdad Ring" or "INV-2026-001 / Site BGD-0123"
  generated_at: string;             // pre-formatted for footer
}

// ── HTML escape ─────────────────────────────────────────────────────
// Maps the five HTML-significant characters. Numbers are NEVER passed
// through this — the model exposes them as typed `number` fields.
function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Number formatter — kept local so this module has zero runtime deps.
// Matches src/lib/finHelpers.ts `iqd()` output shape (integer thousands
// with 'en-US' grouping) so screen and print figures are identical.
function fmtMoney(v: number | null | undefined, currency: string): string {
  if (v == null || !Number.isFinite(+v)) return '—';
  const rounded = Math.round(+v);
  return rounded.toLocaleString('en-US') + ' ' + currency;
}

function fmtMoneyOrDash(v: number | null | undefined, currency: string): string {
  if (v == null) return '—';
  return fmtMoney(v, currency);
}

// Wrap a formatted amount in a nowrap span so `1,200,000 IQD` never
// splits across two lines inside a narrow table column.
function nowrapMoney(v: number | null | undefined, currency: string): string {
  return `<span class="nowrap">${fmtMoney(v, currency)}</span>`;
}

function nowrapMoneyOrDash(v: number | null | undefined, currency: string): string {
  return `<span class="nowrap">${fmtMoneyOrDash(v, currency)}</span>`;
}

// Status → colour tokens for the badge. Matches the on-screen
// STATUS_COLOR / STATUS_TEXT maps in FinInvoices.tsx to keep visual
// language consistent across the two surfaces.
const STATUS_BG: Record<string, string> = {
  Draft: '#f1f5f9', Sent: '#dbeafe', Partial: '#fef3c7', Paid: '#dcfce7', Overdue: '#fee2e2',
};
const STATUS_FG: Record<string, string> = {
  Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};

// Clamp helper for progress bar widths. Some scenarios (legacy over-bill
// or a race with a stale ledger) can produce negative or >100 percentages;
// we clamp the *display* to 0–100 so the bar and captions stay sane.
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

// ── Section builders ────────────────────────────────────────────────

// §2 Header — two-column flex with a thin vertical gold divider.
// Left: gold logo (max-height 44px, max-width 40mm), brand name (navy
// 14–16pt bold), tagline (gold 9pt italic), then a compact contact line
// (address, city+country, phone, email, website) — populated-only.
// tax_id is intentionally NOT rendered here — kept out to preserve the
// clean header line.
// Right: INVOICE (gold 12pt bold letter-spacing 2px), invoice number
// (navy 14–16pt bold), status badge, then three label/value pairs
// (ISSUE DATE / DUE DATE / CURRENCY).
function buildHeader(m: InvoicePrintModel): string {
  const cs = m.company;
  const statusKey = m.status || 'Draft';

  // Company identity source: `company_settings.company_name` with a
  // literal 'JSR Communications' fallback ONLY when the DB row is
  // absent/null. Every other field is populated-only.
  const brandName = escapeHtml(cs?.company_name || 'JSR Communications');
  const brandTag  = escapeHtml(cs?.tagline      || 'Connecting the Future');

  // Compact inline company contact line — dot separated. Wraps to a
  // second line naturally. tax_id deliberately excluded — belongs in
  // company_settings, not on the header.
  const contactParts: string[] = [];
  if (cs?.address_line1) contactParts.push(escapeHtml(cs.address_line1));
  if (cs?.address_line2) contactParts.push(escapeHtml(cs.address_line2));
  const cityCountry = [cs?.city, cs?.country].filter(Boolean).join(', ');
  if (cityCountry)   contactParts.push(escapeHtml(cityCountry));
  if (cs?.phone)     contactParts.push(escapeHtml(cs.phone));
  if (cs?.email)     contactParts.push(escapeHtml(cs.email));
  if (cs?.website)   contactParts.push(escapeHtml(cs.website));
  const contactLine = contactParts.length > 0
    ? `<div class="hdr-company">${contactParts.join(' &nbsp;·&nbsp; ')}</div>`
    : '';

  return `
    <div class="header">
      <div class="hdr-left">
        <img src="${escapeHtml(m.logo_url)}" alt="${brandName}" class="hdr-logo" />
        <div class="hdr-brand-block">
          <div class="hdr-brand">${brandName}</div>
          <div class="hdr-tag">${brandTag}</div>
          ${contactLine}
        </div>
      </div>
      <div class="hdr-divider" aria-hidden="true"></div>
      <div class="hdr-right">
        <div class="hdr-inv-title">INVOICE</div>
        <div class="hdr-inv-num">${escapeHtml(m.invoice_number)}</div>
        <div class="hdr-status" style="background:${STATUS_BG[statusKey] || '#f1f5f9'};color:${STATUS_FG[statusKey] || '#475569'}">${escapeHtml(statusKey)}</div>
        <div class="hdr-meta">
          <div><span class="hdr-meta-k">ISSUE DATE</span><span class="hdr-meta-v">${escapeHtml(m.issue_date)}</span></div>
          <div><span class="hdr-meta-k">DUE DATE</span><span class="hdr-meta-v">${escapeHtml(m.due_date)}</span></div>
          <div><span class="hdr-meta-k">CURRENCY</span><span class="hdr-meta-v">${escapeHtml(m.currency)}</span></div>
        </div>
      </div>
    </div>
  `;
}

// §4 Parties + PO — two equal columns (grid 1fr 1fr, gap 24px).
// Column headers: BILL TO / INVOICE / PO DETAILS, muted 9pt uppercase
// letter-spacing 1.5px, 1px navy bottom border.
// For legacy no-PO invoices, PO Number / PO Date / PO Value rows are
// omitted entirely (no blank rows, no dashes).
function buildPartiesAndPO(m: InvoicePrintModel): string {
  const client = m.client;

  const billLines: string[] = [];
  if (client) {
    billLines.push('<div class="party-name">' + escapeHtml(client.company_name) + '</div>');
    if (client.contact_person) billLines.push('<div>' + escapeHtml(client.contact_person) + '</div>');
    if (client.phone)          billLines.push('<div>' + escapeHtml(client.phone) + '</div>');
    if (client.email)          billLines.push('<div>' + escapeHtml(client.email) + '</div>');
    if (client.address)        billLines.push('<div>' + escapeHtml(client.address) + '</div>');
  } else {
    billLines.push('<div class="dim">—</div>');
  }

  const p = m.po;
  const invoiceType = (m.milestone_label || m.milestone_percent != null)
    ? 'Milestone Invoice'
    : 'Standard Invoice';

  const rightRows: string[] = [];
  rightRows.push(`<div><span class="pd-k">Project</span><span class="pd-v">${escapeHtml(m.project_name)}</span></div>`);
  if (m.project_code) {
    rightRows.push(`<div><span class="pd-k">Project Code</span><span class="pd-v">${escapeHtml(m.project_code)}</span></div>`);
  }
  if (p) {
    rightRows.push(`<div><span class="pd-k">PO Number</span><span class="pd-v">${escapeHtml(p.po_number)}</span></div>`);
    rightRows.push(`<div><span class="pd-k">PO Date</span><span class="pd-v">${escapeHtml(p.po_date)}</span></div>`);
    rightRows.push(`<div><span class="pd-k">PO Value</span><span class="pd-v">${nowrapMoneyOrDash(p.po_amount, p.currency || m.currency)}</span></div>`);
  }
  rightRows.push(`<div><span class="pd-k">Invoice Type</span><span class="pd-v">${escapeHtml(invoiceType)}</span></div>`);

  return `
    <div class="parties">
      <div class="party-col">
        <div class="party-label">BILL TO</div>
        <div class="party-body">${billLines.join('')}</div>
      </div>
      <div class="party-col">
        <div class="party-label">INVOICE / PO DETAILS</div>
        <div class="pd-grid">${rightRows.join('')}</div>
      </div>
    </div>
  `;
}

// §5 Billing Stage — full-width strip below the two columns. Only
// rendered when milestone_label or milestone_percent is populated.
// Handles all three shapes: label+pct, label-only, pct-only.
function buildBillingStage(m: InvoicePrintModel): string {
  if (m.milestone_percent == null && !m.milestone_label) return '';
  const parts: string[] = [];
  if (m.milestone_label) parts.push(escapeHtml(m.milestone_label));
  if (m.milestone_percent != null) parts.push(String(m.milestone_percent) + '%');
  return `<div class="stage-strip"><span class="stage-lbl">BILLING STAGE:</span> <span class="stage-val">${parts.join(' — ')}</span></div>`;
}

// §6 Line items — 7 columns with locked <colgroup> widths.
// Numeric columns are right-aligned, nowrap, tabular-nums. Description
// is the only wrap-capable column. Headers use navy background, white
// uppercase text.
function buildLineItems(m: InvoicePrintModel): string {
  const currency = m.currency;
  const rows = m.items.length === 0
    ? `<tr><td colspan="7" class="empty-row">No line items on this invoice.</td></tr>`
    : m.items.map((it, i) => `
        <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
          <td>${escapeHtml(it.section_name)}</td>
          <td class="mono">${escapeHtml(it.site_id)}</td>
          <td class="desc">${escapeHtml(it.description)}</td>
          <td class="num">${nowrapMoneyOrDash(it.site_commercial, currency)}</td>
          <td class="num dim">${nowrapMoneyOrDash(it.previously_invoiced, currency)}</td>
          <td class="num bold">${nowrapMoney(it.this_invoice, currency)}</td>
          <td class="num">${nowrapMoneyOrDash(it.remaining_after, currency)}</td>
        </tr>
      `).join('');
  return `
    <table class="items-table">
      <colgroup>
        <col style="width:9%" />
        <col style="width:8%" />
        <col style="width:23%" />
        <col style="width:15%" />
        <col style="width:16%" />
        <col style="width:14%" />
        <col style="width:15%" />
      </colgroup>
      <thead>
        <tr>
          <th>SECTION</th>
          <th>SITE ID</th>
          <th>DESCRIPTION</th>
          <th class="num">COMMERCIAL<br>VALUE</th>
          <th class="num">PREVIOUSLY<br>INVOICED</th>
          <th class="num">THIS<br>INVOICE</th>
          <th class="num">REMAINING<br>AFTER</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// §7 Financial summary — right-aligned totals box.
// Hides Discount + Tax rows when BOTH are 0 (clean single-line summary
// on invoices with no adjustments). Shows both if either is non-zero.
// INVOICE TOTAL row is a heavy navy stripe with white text.
function buildInvoiceTotal(m: InvoicePrintModel): string {
  const c = m.currency;
  const hasAdj = (+m.discount || 0) !== 0 || (+m.tax || 0) !== 0;
  const adjRows = hasAdj
    ? `
      <div class="totals-row"><span class="totals-k">Commercial Subtotal</span><span class="totals-v">${nowrapMoney(m.subtotal, c)}</span></div>
      <div class="totals-row"><span class="totals-k">Discount</span><span class="totals-v neg">${nowrapMoney(m.discount, c)}</span></div>
      <div class="totals-row"><span class="totals-k">Tax</span><span class="totals-v pos">${nowrapMoney(m.tax, c)}</span></div>
    `
    : `
      <div class="totals-row"><span class="totals-k">Commercial Subtotal</span><span class="totals-v">${nowrapMoney(m.subtotal, c)}</span></div>
    `;
  return `
    <div class="totals-wrap">
      <div class="totals-box">
        ${adjRows}
        <div class="totals-grand"><span>INVOICE TOTAL</span><span>${nowrapMoney(m.total, c)}</span></div>
      </div>
    </div>
  `;
}

// §8/§9 Progress + Payment cards — side-by-side (grid 1fr 1fr, gap 12px).
// Legacy no-PO invoices: LEFT card omitted; RIGHT card spans full width
// via a 1fr grid.
// Progress bars: LEFT navy fill on light-grey track, RIGHT green fill on
// light-red track. Bar widths clamped 0–100 for display only.
// Captions preserve full labels — "Remaining to Invoice" (billing) and
// "Outstanding" (payment) are load-bearing and never abbreviated.
function buildProgressAndPayment(m: InvoicePrintModel): string {
  const c = m.currency;
  const hasPO = !!m.po;

  const progress = (() => {
    if (!m.po) return '';
    const poValue = +(m.po.po_amount || 0);
    const rawPct  = poValue > 0 ? (m.po_total_billed_to_date / poValue) * 100 : 0;
    const pct     = clampPct(rawPct);
    return `
      <div class="card">
        <div class="card-title">PO / BILLING PROGRESS</div>
        <div class="card-row"><span class="card-k">PO Value</span><span class="card-v">${nowrapMoney(poValue, c)}</span></div>
        <div class="card-row"><span class="card-k">Previously Billed</span><span class="card-v">${nowrapMoney(m.po_previously_billed, c)}</span></div>
        <div class="card-row"><span class="card-k">This Invoice</span><span class="card-v">${nowrapMoney(m.po_this_invoice_commercial, c)}</span></div>
        <div class="card-row"><span class="card-k">Total Billed</span><span class="card-v">${nowrapMoney(m.po_total_billed_to_date, c)}</span></div>
        <div class="card-row"><span class="card-k">Remaining to Invoice</span><span class="card-v">${nowrapMoney(m.po_remaining_to_invoice, c)}</span></div>
        <div class="bar-wrap bar-billing"><div class="bar-fill bar-navy" style="width:${pct.toFixed(2)}%"></div></div>
        <div class="bar-caption">${pct.toFixed(1)}% of PO value billed</div>
      </div>
    `;
  })();

  const rawPay      = m.total > 0 ? (m.received_to_date / m.total) * 100 : 0;
  const payPct      = clampPct(rawPay);
  const outPct      = clampPct(100 - payPct);
  const payPctLabel = m.total > 0 ? payPct.toFixed(1) + '%' : '—';
  const payment = `
    <div class="card">
      <div class="card-title">PAYMENT STATUS</div>
      <div class="card-row"><span class="card-k">Invoice Total</span><span class="card-v">${nowrapMoney(m.total, c)}</span></div>
      <div class="card-row"><span class="card-k">Received</span><span class="card-v pos">${nowrapMoney(m.received_to_date, c)}</span></div>
      <div class="card-row"><span class="card-k">Outstanding</span><span class="card-v ${m.outstanding > 0 ? 'neg' : 'pos'}">${nowrapMoney(m.outstanding, c)}</span></div>
      <div class="card-row"><span class="card-k">Payment %</span><span class="card-v">${payPctLabel}</span></div>
      <div class="bar-wrap bar-payment"><div class="bar-fill bar-green" style="width:${payPct.toFixed(2)}%"></div></div>
      <div class="bar-caption">${payPct.toFixed(1)}% received &nbsp;•&nbsp; ${outPct.toFixed(1)}% outstanding</div>
    </div>
  `;

  return `<div class="cards-row ${hasPO ? 'cards-row-2' : 'cards-row-1'}">${progress}${payment}</div>`;
}

// §10 Payment history — empty case: single italic line "No payments
// recorded." (NOT a table). Populated case: compact 5-column table
// (DATE / AMOUNT / METHOD / REFERENCE / RECORDED BY). Notes intentionally
// dropped for horizontal room.
function buildPaymentHistory(m: InvoicePrintModel): string {
  const c = m.currency;
  const header = `<div class="section-title">PAYMENT HISTORY</div>`;
  if (m.payments.length === 0) {
    return `
      <div class="hist-block">
        ${header}
        <div class="hist-empty">No payments recorded.</div>
      </div>
    `;
  }
  const rows = m.payments.map(p => `
    <tr>
      <td>${escapeHtml(p.payment_date)}</td>
      <td class="num pos bold">${nowrapMoney(p.amount, c)}</td>
      <td>${escapeHtml(p.method)}</td>
      <td class="dim">${escapeHtml(p.reference)}</td>
      <td class="dim">${escapeHtml(p.recorded_by)}</td>
    </tr>
  `).join('');
  return `
    <div class="hist-block">
      ${header}
      <table class="hist-table">
        <colgroup>
          <col style="width:16%" />
          <col style="width:22%" />
          <col style="width:18%" />
          <col style="width:24%" />
          <col style="width:20%" />
        </colgroup>
        <thead>
          <tr>
            <th>DATE</th>
            <th class="num">AMOUNT</th>
            <th>METHOD</th>
            <th>REFERENCE</th>
            <th>RECORDED BY</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// §11 Bank details — hidden entirely when model.bank is null.
// Fields grid is 3-column (repeat(3, 1fr)) with label-above-value
// pattern. Followed by the Payment Reference strip (gold-pale bg,
// gold left border).
function buildBankDetails(m: InvoicePrintModel): string {
  const b = m.bank;
  if (!b) return '';
  const cells: string[] = [];
  if (b.bank_name)      cells.push(`<div class="bank-cell"><div class="bank-k">Bank Name</div><div class="bank-v">${escapeHtml(b.bank_name)}</div></div>`);
  if (b.account_name)   cells.push(`<div class="bank-cell"><div class="bank-k">Account Name</div><div class="bank-v">${escapeHtml(b.account_name)}</div></div>`);
  if (b.account_number) cells.push(`<div class="bank-cell"><div class="bank-k">Account Number</div><div class="bank-v mono">${escapeHtml(b.account_number)}</div></div>`);
  if (b.iban)           cells.push(`<div class="bank-cell"><div class="bank-k">IBAN</div><div class="bank-v mono">${escapeHtml(b.iban)}</div></div>`);
  if (b.swift)          cells.push(`<div class="bank-cell"><div class="bank-k">SWIFT</div><div class="bank-v mono">${escapeHtml(b.swift)}</div></div>`);
  if (b.currency)       cells.push(`<div class="bank-cell"><div class="bank-k">Currency</div><div class="bank-v">${escapeHtml(b.currency)}</div></div>`);
  return `
    <div class="bank-block">
      <div class="section-title">BANK DETAILS</div>
      <div class="bank-grid">${cells.join('')}</div>
      <div class="payref-strip">
        <div class="payref-line"><span class="payref-lbl">PAYMENT REFERENCE:</span> <span class="payref-val">${escapeHtml(m.bank_payment_reference)}</span></div>
        <div class="payref-note">Please include the Invoice Number in the payment reference.</div>
      </div>
    </div>
  `;
}

// Notes — optional. Single-line style, small font.
function buildNotes(m: InvoicePrintModel): string {
  if (!m.notes) return '';
  return `<div class="notes-line"><strong>Notes:</strong> ${escapeHtml(m.notes)}</div>`;
}

// §12 Footer — thin gold divider above, then a single centered line.
// Website + email appended only when populated. No page numbers, no
// injected URL / date.
function buildFooter(m: InvoicePrintModel): string {
  const cs = m.company;
  const bits: string[] = ['Generated by JSR Network Tracker'];
  if (cs?.website) bits.push(escapeHtml(cs.website));
  if (cs?.email)   bits.push(escapeHtml(cs.email));
  return `<div class="footer">${bits.join(' &nbsp;•&nbsp; ')}</div>`;
}

// ── CSS ─────────────────────────────────────────────────────────────
//
// Phase 4.4 palette (declared as CSS variables at the top of the block
// so the whole template can be re-themed by editing these six values):
//   --navy       #0f172a  primary navy: headings, INVOICE TOTAL
//   --navy-2     #1e293b  body text, table headers
//   --gold       #c9a961  accent: INVOICE label, stripes, dividers, footer
//   --gold-pale  #fdf9ee  billing stage bg, payment reference bg
//   --border     #e2e8f0  subtle borders
//   --muted      #64748b  secondary text
//   --muted-2    #94a3b8  labels above values
//   --zebra      #f8fafc  alt rows / subtle backgrounds
//   --green      #16a34a  received / payment progress
//   --red        #dc2626  outstanding only
//
// Page-break strategy is deliberately narrow: only five selectors get
// the no-split rule (.totals-box, .card, .bank-block, .payref-strip,
// .items-table tr). The items table itself is set to auto so a long
// line-item list can span multiple pages cleanly; the header repeats
// via `thead { display: table-header-group; }`.

const INVOICE_CSS = `
  :root {
    --navy: #0f172a;
    --navy-2: #1e293b;
    --gold: #c9a961;
    --gold-pale: #fdf9ee;
    --border: #e2e8f0;
    --muted: #64748b;
    --muted-2: #94a3b8;
    --zebra: #f8fafc;
    --green: #16a34a;
    --red: #dc2626;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    color: var(--navy-2);
    background: #fff;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    line-height: 1.4;
  }

  /* Slightly asymmetric page margins: 10mm top / 8mm bottom gives ~2mm
     extra usable vertical space, which keeps the single-page footer
     landing rule safe on typical 1-3 site invoices without shrinking
     typography or the logo. Horizontal margins unchanged. */
  @page { size: A4 portrait; margin: 10mm 12mm 8mm 12mm; }

  @media screen {
    html, body { background: #f1f5f9; }
    body {
      max-width: 210mm;
      margin: 12mm auto;
      padding: 14mm;
      background: #ffffff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      border-radius: 2px;
    }
  }

  @media print {
    html, body { background: #fff; }
    body { padding: 0; margin: 0; box-shadow: none; border-radius: 0; max-width: none; }
    .print-hint { display: none !important; }
  }

  /* Page-break guards — five selectors, applied at all media (browser
     also honours them in print). */
  .totals-box    { page-break-inside: avoid; }
  .card          { page-break-inside: avoid; }
  .bank-block    { page-break-inside: avoid; }
  .payref-strip  { page-break-inside: avoid; }
  .items-table tr { page-break-inside: avoid; }
  .items-table    { page-break-inside: auto; }
  thead           { display: table-header-group; }

  /* Popup-only tip. Hidden on paper. */
  .print-hint {
    background: #eef2ff;
    color: #4338ca;
    border: 1px solid #c7d2fe;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 11px;
    margin-bottom: 12px;
    font-weight: 600;
  }

  .nowrap { white-space: nowrap; }
  .num  { text-align: right; }
  .pos  { color: var(--green); }
  .neg  { color: var(--red); }
  .dim  { color: var(--muted); }
  .bold { font-weight: 700; }
  .mono { font-family: 'SF Mono', Menlo, Consolas, monospace; font-weight: 600; color: var(--navy-2); }

  /* §2 Header — two-column flex with a thin vertical gold divider */
  .header {
    display: flex;
    align-items: stretch;
    gap: 18px;
    border-bottom: 2px solid var(--navy);
    padding-bottom: 12px;
    margin-bottom: 14px;
  }
  .hdr-left  { display: flex; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 0; }
  .hdr-divider {
    flex: 0 0 auto;
    width: 2px;
    background: var(--gold);
    align-self: stretch;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .hdr-right { flex: 0 0 auto; text-align: right; min-width: 195px; }

  .hdr-logo { max-height: 50px; max-width: 40mm; object-fit: contain; display: block; flex: 0 0 auto; }
  .hdr-brand-block { line-height: 1.25; min-width: 0; }
  .hdr-brand { font-size: 15pt; font-weight: 800; color: var(--navy); letter-spacing: -0.3px; }
  .hdr-tag   { font-size: 9pt; color: var(--gold); font-weight: 600; font-style: italic; margin-top: 1px; }
  .hdr-company { font-size: 8.5pt; color: var(--muted); margin-top: 4px; line-height: 1.5; }

  .hdr-inv-title { font-size: 12pt; font-weight: 700; color: var(--gold); letter-spacing: 2px; line-height: 1; }
  .hdr-inv-num   { font-size: 15pt; font-weight: 800; color: var(--navy); margin-top: 3px; }
  .hdr-status {
    display: inline-block; padding: 2px 10px; border-radius: 12px;
    font-size: 8pt; font-weight: 700; margin-top: 4px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .hdr-meta { margin-top: 8px; font-size: 9.5pt; }
  .hdr-meta > div {
    display: flex; justify-content: flex-end; align-items: baseline;
    gap: 10px; padding: 1px 0;
  }
  .hdr-meta-k { color: var(--muted-2); font-weight: 600; text-transform: uppercase; letter-spacing: .4px; font-size: 8pt; }
  .hdr-meta-v { color: var(--navy); font-weight: 700; min-width: 70px; text-align: left; font-size: 9.5pt; }

  /* §4 Parties + PO — two equal columns with underlined section labels */
  .parties {
    display: grid; grid-template-columns: 1fr 1fr; gap: 24px;
    margin-bottom: 12px;
  }
  .party-label {
    font-size: 9pt; font-weight: 700; color: var(--muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    border-bottom: 1px solid var(--navy);
    padding-bottom: 4px; margin-bottom: 6px;
  }
  .party-body { font-size: 9.5pt; color: var(--navy-2); line-height: 1.55; }
  .party-body > div { padding: 1px 0; }
  .party-name { font-weight: 800; color: var(--navy); font-size: 11pt; }

  .pd-grid {
    display: grid; grid-template-columns: 1fr; gap: 2px 12px;
    font-size: 9.5pt;
  }
  .pd-grid > div {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 10px; padding: 1px 0;
  }
  .pd-k { color: var(--muted); font-weight: 500; }
  .pd-v { color: var(--navy); font-weight: 700; text-align: right; }

  /* §5 Billing stage — full-width strip, gold-pale bg, gold left border */
  .stage-strip {
    background: var(--gold-pale);
    border-left: 4px solid var(--gold);
    padding: 8px 14px;
    border-radius: 3px;
    margin-bottom: 12px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .stage-lbl { color: var(--gold); font-weight: 700; font-size: 9pt; text-transform: uppercase; letter-spacing: 1px; margin-right: 6px; }
  .stage-val { color: var(--navy); font-weight: 700; font-size: 11pt; }

  /* §6 Line items table — navy header, zebra body */
  .items-table {
    width: 100%; border-collapse: collapse;
    margin: 0 0 8px; font-size: 9pt;
    table-layout: fixed;
  }
  .items-table th {
    background: var(--navy); color: #fff;
    font-size: 7.75pt; font-weight: 700; text-transform: uppercase; letter-spacing: .25px;
    line-height: 1.15;
    padding: 5px 4px; text-align: left; vertical-align: middle;
    /* Header labels are allowed to wrap onto two lines (see the explicit
       <br> in the four financial headers). Only body money cells are
       nowrap. */
    white-space: normal;
    /* Subtle white divider between header cells so the column sequence
       stays visually obvious even when a label wraps. Cleared on the
       last cell for a clean right edge. */
    border-right: 1px solid rgba(255,255,255,0.15);
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .items-table th:last-child { border-right: none; }
  /* Wrapped numeric headers stay centered above right-aligned body
     values — matches the spec: "Header text must stay centered inside
     its own column". */
  .items-table th.num { text-align: center; }
  .items-table td {
    padding: 5px 8px; border-bottom: 1px solid var(--border);
    color: var(--navy-2); vertical-align: top;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .items-table td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .items-table td.desc { white-space: normal; overflow-wrap: break-word; color: var(--muted); }
  .items-table .row-even { background: #ffffff; }
  .items-table .row-odd  { background: var(--zebra); }
  .empty-row { text-align: center; color: var(--muted-2); padding: 10px !important; }

  /* §7 Totals — right-aligned block */
  .totals-wrap { display: flex; justify-content: flex-end; margin-top: 8px; }
  .totals-box {
    min-width: 65mm; max-width: 78mm;
    border: 1px solid var(--border); border-radius: 4px;
    overflow: hidden;
    background: #ffffff;
  }
  .totals-row {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 14px; padding: 5px 12px;
    font-size: 9pt; color: var(--navy-2);
  }
  .totals-k { color: var(--muted); font-weight: 500; }
  .totals-v { color: var(--navy); font-weight: 700; font-size: 9.5pt; white-space: nowrap; }
  .totals-grand {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 14px; padding: 9px 12px;
    background: var(--navy); color: #ffffff;
    font-size: 12pt; font-weight: 800;
    text-transform: uppercase; letter-spacing: .5px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .totals-grand span { white-space: nowrap; }

  /* §8/§9 Progress + Payment cards */
  .cards-row {
    display: grid; gap: 12px;
    margin-top: 14px;
  }
  .cards-row-2 { grid-template-columns: 1fr 1fr; }
  .cards-row-1 { grid-template-columns: 1fr; }
  .card {
    border: 1px solid var(--border); border-radius: 4px;
    padding: 12px 14px; background: #ffffff;
    font-size: 9pt;
  }
  .card-title {
    font-size: 9pt; font-weight: 700; color: var(--navy);
    text-transform: uppercase; letter-spacing: 1.5px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 6px; margin-bottom: 8px;
  }
  .card-row {
    display: flex; justify-content: space-between; align-items: baseline;
    gap: 10px; padding: 2px 0;
    font-size: 9pt;
  }
  .card-k { color: var(--muted); }
  .card-v { color: var(--navy); font-weight: 700; font-size: 10pt; white-space: nowrap; }

  .bar-wrap {
    height: 5px; border-radius: 3px; overflow: hidden;
    display: block; margin-top: 8px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .bar-billing { background: #e5e7eb; }
  .bar-payment { background: #fee2e2; }
  .bar-fill  { height: 100%; display: block; }
  .bar-navy  { background: var(--navy); }
  .bar-green { background: var(--green); }
  .bar-caption {
    font-size: 8pt; color: var(--muted); margin-top: 4px;
  }

  /* §10 Payment history + §11 Bank — shared section title */
  .section-title {
    font-size: 9pt; font-weight: 700; color: var(--muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px; margin-bottom: 6px;
  }
  .hist-block { margin-top: 14px; }
  .hist-empty {
    font-size: 9pt; color: var(--muted); font-style: italic;
    padding: 2px 0;
  }
  .hist-table {
    width: 100%; border-collapse: collapse;
    font-size: 8.5pt; table-layout: fixed;
  }
  .hist-table th {
    background: var(--navy-2); color: #fff;
    font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
    padding: 5px 8px; text-align: left;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .hist-table th.num { text-align: right; white-space: nowrap; }
  .hist-table td {
    padding: 4px 8px; border-bottom: 1px solid var(--border);
    color: var(--navy-2); font-variant-numeric: tabular-nums;
  }
  .hist-table td.num { text-align: right; white-space: nowrap; }

  /* §11 Bank details */
  .bank-block { margin-top: 14px; }
  .bank-grid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 4px 16px; font-size: 9pt;
  }
  .bank-cell { padding: 2px 0; }
  .bank-k { color: var(--muted); font-size: 8pt; text-transform: uppercase; letter-spacing: .3px; font-weight: 600; }
  .bank-v { color: var(--navy); font-size: 9.5pt; font-weight: 700; margin-top: 1px; }

  .payref-strip {
    background: var(--gold-pale);
    border-left: 4px solid var(--gold);
    padding: 8px 14px;
    border-radius: 3px;
    margin-top: 10px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .payref-line { color: var(--navy); }
  .payref-lbl  { color: var(--gold); font-size: 8.5pt; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; }
  .payref-val  { color: var(--navy); font-weight: 700; font-size: 11pt; white-space: nowrap; }
  .payref-note { color: var(--muted-2); font-style: italic; font-size: 8pt; margin-top: 2px; }

  /* Notes — subtle, small */
  .notes-line {
    font-size: 8.5pt; color: var(--muted); margin-top: 10px;
    padding: 4px 10px; border-left: 2px solid var(--border);
    white-space: pre-wrap;
  }
  .notes-line strong { color: var(--navy); }

  /* Section 12 Footer -- thin gold divider, centered muted line.
     Deliberately NO page-break rules. Phase 4.6 tried keeping the
     footer with the previous element via page-break-before avoid +
     page-break-inside avoid; that backfired: when the user has the
     browser Headers and footers enabled in the print dialog (which
     reserves ~15mm of physical page for URL / date / page number),
     page-break-inside avoid made the entire footer atomic, so Chrome
     moved the whole ~8.5mm block to page 2 rather than allow it to sit
     in the ~5-7mm remaining space on page 1. Without those constraints
     the browser is free to place this single-line element in normal
     flow directly under Payment Reference, which is what we want.
     Chrome will not visually split a 1-line footer in practice.
     Chrome trimmed to 6px + 4px + explicit line-height 1.2 reclaims
     ~3mm and keeps the total footer box under ~5.5mm, comfortably
     inside whatever gap remains on page 1 even under the reduced print
     area caused by browser headers/footers being on. */
  .footer {
    margin-top: 6px; padding-top: 4px;
    border-top: 1px solid var(--gold);
    font-size: 8pt; color: var(--muted); text-align: center;
    line-height: 1.2;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
`;

// ── Public entry point ─────────────────────────────────────────────

/**
 * Build the full HTML document string for an invoice print / preview.
 *
 * The caller writes the returned string into a popup window opened via
 * `window.open('', '_blank')` and then calls `document.close()`. The
 * embedded `<script>` waits for all images (typically just the gold
 * logo) to fire `load` or `error` via Promise.all, and only then calls
 * `window.print()`. A 1500ms `setTimeout` fires the same handler as a
 * safety net in case a browser fails to dispatch the image events.
 *
 * The `.print-hint` div is a popup-only tip (hidden by `@media print`)
 * telling the user how to disable the browser's URL/date/page-number
 * headers/footers in the print dialog. There is no cross-browser CSS
 * way to suppress those from the page itself.
 */
export function buildInvoiceHTML(model: InvoicePrintModel): string {
  const title = model.invoice_number || 'Invoice';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>${INVOICE_CSS}</style>
</head>
<body>
  <div class="print-hint">Tip: In the browser print dialog, uncheck "Headers and footers" (More settings) for a clean PDF.</div>
  ${buildHeader(model)}
  ${buildPartiesAndPO(model)}
  ${buildBillingStage(model)}
  ${buildLineItems(model)}
  ${buildInvoiceTotal(model)}
  ${buildProgressAndPayment(model)}
  ${buildPaymentHistory(model)}
  ${buildBankDetails(model)}
  ${buildNotes(model)}
  ${buildFooter(model)}
  <script>
    // Wait for every image to resolve (load OR error) before triggering
    // the print dialog. A blank <img> that fails to load still resolves
    // via 'error' so we never hang. The 1500ms setTimeout is a last-
    // resort fallback in case a browser suppresses both events.
    (function () {
      var printed = false;
      function doPrint() {
        if (printed) return;
        printed = true;
        try { window.focus(); } catch (e) {}
        window.print();
      }
      var imgs = Array.prototype.slice.call(document.images || []);
      if (imgs.length === 0) { doPrint(); return; }
      var pending = imgs.length;
      function tick() { pending -= 1; if (pending <= 0) doPrint(); }
      imgs.forEach(function (img) {
        if (img.complete) { tick(); return; }
        img.addEventListener('load',  tick, { once: true });
        img.addEventListener('error', tick, { once: true });
      });
      setTimeout(doPrint, 1500);
    })();
  </script>
</body>
</html>`;
}
