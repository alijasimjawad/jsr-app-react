import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { iqd } from '../lib/finHelpers';
import { ensureProjectsLoaded, getProjectNames } from '../lib/projectsCache';
import { BRAND } from '../config/brand';
import type { PurchaseOrder, CompanySettings, BankAccount, PaymentMethod } from '../lib/invoiceTypes';
import {
  previouslyInvoicedForRevenue,
  remainingSiteValue,
  siteBillingStatus,
  billedCommercialValueForPO,
  remainingPOValue,
  invoiceSubtotal as calcInvoiceSubtotal,
  invoiceTotal as calcInvoiceTotal,
  outstanding as calcOutstanding,
} from '../lib/invoiceCalc';
import {
  buildInvoiceHTML,
  type InvoicePrintModel,
  type InvoicePrintLineItem,
} from '../lib/invoicePrintTemplate';
// Phase 4.8 — deterministic client-side PDF export via @react-pdf/renderer.
// Lives alongside the existing browser Print action; both consume the
// same `InvoicePrintModel`. The generator lazy-imports @react-pdf/renderer
// on first click so its ~1MB pdfkit bundle stays out of the main chunk.
import { generateInvoicePdf } from '../pdf/generateInvoicePdf';
// Gold logo — Phase 4 print/detail branding. App-wide chrome (Sidebar,
// Topbar, Login) stays on BRAND.logoLight (= jsr-logo.png) via
// src/config/brand.ts. The two assets are byte-identical today, so this
// import path is purely a namespacing decision that makes a later
// asset-only swap a no-op — no code change needed to re-skin.
import goldLogo from '../assets/jsr-communications-gold.png';
import css from './FinBilling.module.css';

// ── Types ─────────────────────────────────────────────────────
interface Client {
  id: string;
  company_name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
}

// Invoice shape extended with Phase 2 upgrade fields
// (mirrors InvoiceUpgradeFields from invoiceTypes.ts — kept inline so
// the local interface remains the single reference used across this
// page's state, without a spread-typed intermediate).
interface Invoice {
  id: string;
  invoice_number: string | null;
  client_id: string;
  project_name: string | null;
  project_code: string | null;
  status: string;
  issue_date: string | null;
  due_date: string | null;
  total_amount: number;
  amount_received: number;
  notes: string | null;
  created_by: string | null;
  po_id: string | null;
  milestone_label: string | null;
  milestone_percent: number | null;
  discount_amount: number;
  tax_amount: number;
}

interface InvoiceItem {
  id: string;
  invoice_id: string;
  site_id: string | null;
  section_name: string | null;
  description: string | null;
  amount: number;
  revenue_id: string | null;
}

// Compact history row — the only invoice_items columns we need for the
// cumulative Site / PO validation maps. Selecting narrower keeps the
// bulk fetch light.
interface InvoiceItemHistoryRow {
  invoice_id: string;
  revenue_id: string | null;
  amount: number;
}

interface Payment {
  id: string;
  invoice_id: string;
  payment_date: string | null;
  amount: number;
  reference: string | null;
  notes: string | null;
  recorded_by: string | null;
  // Phase 2 columns from invoice_payments — free-text at DB level, the
  // UI narrows method to PaymentMethod. bank_account_id records WHERE
  // the payment was received; the invoice's REQUESTED destination
  // account for print is picked from company defaults (see selectBank).
  method: PaymentMethod;
  bank_account_id: string | null;
}

// Revenue row extended with po_id from Phase 2. status is nullable at
// the DB level.
interface RevRow {
  id: string;
  project_name: string | null;
  section_name: string | null;
  site_id: string | null;
  amount: number | null;
  status: string | null;
  po_id: string | null;
}

// Persisted line-item shape + transient UX-only fields used while
// building the invoice. Fields prefixed with `_` are UI-only and are
// NEVER written to invoice_items (see saveInvoice payload).
interface LineItem {
  site_id: string | null;
  section_name: string | null;
  description: string | null;
  amount: number;
  revenue_id: string | null;
  _customId?: number;
  _commercialValue?: number;    // revenue.amount for this site
  _previouslyInvoiced?: number; // SUM of other invoices' items for this revenue_id
  _remainingBefore?: number;    // clamp(commercial - previouslyInvoiced, 0)
  _invoicePercent?: number;     // per-line percent bound to amount for display
}

// ── Status helpers ────────────────────────────────────────────
const STATUS_COLOR: Record<string, string> = {
  Draft: '#f1f5f9', Sent: '#dbeafe', Partial: '#fef3c7', Paid: '#dcfce7', Overdue: '#fee2e2',
};
const STATUS_TEXT: Record<string, string> = {
  Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};
const STATUS_PILL_ACTIVE: Record<string, string> = {
  '': '#1d4ed8', Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};

// ── Print helper ──────────────────────────────────────────────
//
// Phase 4: the HTML/CSS lives in src/lib/invoicePrintTemplate.ts as a
// pure `buildInvoiceHTML(model)` function. This wrapper composes the
// `InvoicePrintModel` from already-loaded page data (invoice + items +
// payments + PO + company_settings + bank_accounts + itemHistory) using
// the invoiceCalc.ts helpers — NO business math is duplicated here or
// in the template.
//
// Popup architecture is unchanged: window.open + document.write +
// document.close. The template embeds a self-contained script that
// waits for every <img> to fire load/error before calling
// window.print(), so the pre-Phase-4 blank-logo race is fixed at the
// template level, not by delaying anything in this wrapper.

// Pick the bank account we display on the invoice for a given
// currency. Rule per spec §14/K:
//   1. is_active=true AND is_default=true for that currency, OR
//   2. first is_active=true for that currency (sort_order applied by
//      the caller's initial fetch),
//   3. otherwise null → template gracefully hides Bank Details.
// No hard-coded fallback. The invoice_payments.bank_account_id column
// records where money WAS received; we deliberately do NOT read from it
// to decide where to REQUEST payment — those are two different concerns.
function selectBank(banks: BankAccount[], currency: string): BankAccount | null {
  const cur = (currency || 'IQD').toUpperCase();
  const active = banks.filter(b => b.is_active && (b.currency || '').toUpperCase() === cur);
  const def = active.find(b => b.is_default);
  return def || active[0] || null;
}

// Compose the print model. All numeric derivations use invoiceCalc.ts
// helpers so validation, live modal figures, and print stay in lock-step.
function buildPrintModel(
  inv: Invoice,
  client: Client | undefined,
  items: InvoiceItem[],
  payments: Payment[],
  po: PurchaseOrder | null,
  company: CompanySettings | null,
  bank: BankAccount | null,
  itemHistory: InvoiceItemHistoryRow[],
  invoicePoMap: Map<string, string | null>,
  revenueRows: RevRow[],
): InvoicePrintModel {
  // Currency: derive from PO if available, otherwise 'IQD' (there's no
  // invoices.currency column yet — a later phase can promote this).
  const currency = (po?.currency || 'IQD').toUpperCase();

  // Financial summary (recomputed — never read the cached
  // amount_received, per Payment Status spec).
  const subtotal        = calcInvoiceSubtotal(items);
  const total           = +inv.total_amount || 0;              // stored as subtotal − discount + tax
  const receivedToDate  = payments.reduce((s, p) => s + (+p.amount || 0), 0);
  const outstanding     = calcOutstanding(total, receivedToDate);

  // Commercial subtotal for PO progress — revenue-linked lines only.
  // Custom items (revenue_id === null) are NOT commercial value.
  const revItems        = items.filter(it => it.revenue_id);
  const commercialSub   = revItems.reduce((s, it) => s + (+it.amount || 0), 0);

  // PO progress figures. `po_previously_billed` excludes THIS invoice
  // so the "Total Billed to Date" reads as (prev) + (this).
  const poId            = po?.id || '';
  const poAmount        = +(po?.po_amount || 0);
  const poPrev          = po ? billedCommercialValueForPO(itemHistory, invoicePoMap, poId, inv.id) : 0;
  const poTotalToDate   = poPrev + commercialSub;
  const poRemaining     = po ? remainingPOValue(poAmount, poTotalToDate) : 0;

  // Line items — enrich with per-row derivations.
  const printItems: InvoicePrintLineItem[] = items.map(it => {
    const rev = it.revenue_id ? revenueRows.find(r => r.id === it.revenue_id) : undefined;
    if (!rev) {
      // Custom line — no commercial context. Print engine renders
      // dashes for empty columns (spec: "graceful degradation").
      return {
        section_name:         it.section_name,
        site_id:              it.site_id,
        description:          it.description,
        po_number:            '',
        site_commercial:      null,
        previously_invoiced:  null,
        this_invoice:         +(it.amount || 0),
        remaining_after:      null,
      };
    }
    const commercial   = +(rev.amount || 0);
    const prev         = previouslyInvoicedForRevenue(itemHistory, rev.id, inv.id);
    const thisAmt      = +(it.amount || 0);
    const remainAfter  = commercial - prev - thisAmt;   // raw — may be negative on legacy over-bill
    const linePOId     = rev.po_id;
    const linePONum    = linePOId
      ? (po && po.id === linePOId ? po.po_number : '')
      : '';
    return {
      section_name:         it.section_name,
      site_id:              it.site_id,
      description:          it.description,
      po_number:            linePONum,
      site_commercial:      commercial,
      previously_invoiced:  prev,
      this_invoice:         thisAmt,
      remaining_after:      remainAfter,
    };
  });

  // Bank payment reference. If exactly one revenue-linked line, use
  // Site ID; otherwise use project name.
  const singleRevLine = revItems.length === 1 ? revItems[0] : null;
  const refTail       = singleRevLine?.site_id
    ? 'Site ' + String(singleRevLine.site_id)
    : (inv.project_name || '');
  const paymentReference = [inv.invoice_number || '', refTail].filter(Boolean).join(' / ');

  return {
    invoice_number:              inv.invoice_number,
    status:                      inv.status,
    issue_date:                  inv.issue_date,
    due_date:                    inv.due_date,
    project_name:                inv.project_name,
    project_code:                inv.project_code,
    currency,
    milestone_label:             inv.milestone_label,
    milestone_percent:           inv.milestone_percent,
    notes:                       inv.notes,
    client:                      client
      ? { company_name: client.company_name, contact_person: client.contact_person, email: client.email, phone: client.phone, address: client.address }
      : null,
    po,
    company,
    bank,
    items:                       printItems,
    payments:                    payments.map(p => ({
      payment_date: p.payment_date,
      amount:       +(p.amount || 0),
      method:       p.method,
      reference:    p.reference,
      notes:        p.notes,
      recorded_by:  p.recorded_by,
    })),
    received_to_date:            receivedToDate,
    subtotal,
    discount:                    +(inv.discount_amount || 0),
    tax:                         +(inv.tax_amount      || 0),
    total,
    outstanding,
    po_previously_billed:        poPrev,
    po_this_invoice_commercial:  commercialSub,
    po_total_billed_to_date:     poTotalToDate,
    po_remaining_to_invoice:     poRemaining,
    logo_url:                    goldLogo,
    bank_payment_reference:      paymentReference,
    generated_at:                new Date().toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
  };
}

function printInvoice(model: InvoicePrintModel) {
  const html = buildInvoiceHTML(model);
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

// ── Component ─────────────────────────────────────────────────
export default function FinInvoices() {
  const { hasPerm, currentUser } = useAuth();
  const today = new Date().toISOString().split('T')[0];

  // ── Core data ─────────────────────────────────────────────
  const [clients,      setClients]      = useState<Client[]>([]);
  const [invoices,     setInvoices]     = useState<Invoice[]>([]);
  const [payments,     setPayments]     = useState<Payment[]>([]);
  const [items,        setItems]        = useState<InvoiceItem[]>([]);
  const [revenue,      setRevenue]      = useState<RevRow[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  // Phase 4: bulk-load company_settings (one row) + active bank_accounts
  // so print/detail composition never triggers additional per-render
  // queries. Both feed into buildPrintModel and the Detail modal's
  // Bank Details card. If the migration hasn't been applied yet, both
  // fetches gracefully return no rows and the template hides those
  // sections — no crash, no missing-column error surfaced to users.
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [bankAccounts,    setBankAccounts]    = useState<BankAccount[]>([]);
  // Bulk invoice_items history — one fetch, aggregated client-side into
  // the maps below. Replaces the old `invoicedIds` Set (which only knew
  // "is this revenue_id invoiced at all"). Cumulative validation needs
  // sums, not booleans.
  const [itemHistory,  setItemHistory]  = useState<InvoiceItemHistoryRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  // ── Invoice modal ─────────────────────────────────────────
  const [invModal,     setInvModal]     = useState(false);
  const [invEditId,    setInvEditId]    = useState<string | null>(null);
  const [invForm,      setInvForm]      = useState({
    clientId: '', number: '', project: '', projectCode: '', status: 'Draft', issueDate: today, dueDate: '', notes: '',
    poId: '', milestoneLabel: '', milestonePercent: '', discount: '0', tax: '0',
  });
  const [revSites,     setRevSites]     = useState<RevRow[]>([]);
  // Site classification sets — populated by loadPickerForProject via
  // siteBillingStatus(). Three states, two sets: 'available' is the
  // implicit default (not present in either set). Rows in either set
  // render disabled checkboxes with a status-specific badge.
  //   • fullyBilledIds  → "Fully Invoiced" (blue/grey)
  //   • missingValueIds → "Commercial Value Missing" (amber)
  const [fullyBilledIds,  setFullyBilledIds]  = useState<Set<string>>(new Set());
  const [missingValueIds, setMissingValueIds] = useState<Set<string>>(new Set());
  const [checkedRevs,  setCheckedRevs]  = useState<Set<string>>(new Set()); // currently-checked revenue IDs
  // Per-row spinner while an "Assign to PO" write is in-flight. Prevents
  // double-clicks from firing two UPDATEs. Cleared on success or error.
  const [assigningRevIds, setAssigningRevIds] = useState<Set<string>>(new Set());
  // Persistent, dismissable error banner for PO-assignment failures. A
  // 3.5s toast disappears too quickly to diagnose a real RLS/PostgREST
  // failure — this stays until the user dismisses it or the next assign
  // attempt succeeds.
  const [assignError, setAssignError] = useState<string | null>(null);
  // Persistent, dismissable info banner for Apply % edge cases (no
  // percentage / no selected sites / out-of-range). Separate from
  // invErr so it doesn't interfere with save-time validation.
  const [applyPctMsg, setApplyPctMsg] = useState<string | null>(null);
  // Overallocation confirm — mirrors FinPOs.tsx `overallocConfirm` state.
  // `revIds` is the list about to be assigned (single or bulk); `projected`
  // is the mapped total AFTER assignment; `poAmount` is the PO cap.
  const [overallocConfirm, setOverallocConfirm] = useState<
    { revIds: string[]; projected: number; poAmount: number; poNumber: string } | null
  >(null);
  const [customItems,  setCustomItems]  = useState<LineItem[]>([]);
  const [pickerLoad,   setPickerLoad]   = useState(false);
  const [pickerStatus, setPickerStatus] = useState('Select a project first');
  const [showCustForm, setShowCustForm] = useState(false);
  const [custForm,     setCustForm]     = useState({ site: '', desc: '', amt: '' });
  const [invErr,       setInvErr]       = useState('');
  // Per-line overrides for the "Invoice %" and "This Invoice Amount"
  // inputs in the line-item block. Keyed by revenue_id (for picker
  // rows) or custom _customId (for extras). Amount override wins over
  // the auto-computed value from percentage.
  const [lineAmountOverride, setLineAmountOverride] = useState<Record<string, number>>({});

  // Per-line override for the auto-generated "Site implementation — {site}"
  // description text. Keyed by revenue_id, same as lineAmountOverride.
  // Empty/absent → falls back to the auto text.
  const [lineDescOverride, setLineDescOverride] = useState<Record<string, string>>({});

  // Tracks the project name the revenue/site picker is currently loaded
  // for. The Project field is free text now (so the printed name can be
  // customized per customer request), but re-querying revenue rows on
  // every rename would wipe the already-selected sites whenever the typed
  // text doesn't exactly match a project in the database. We only reload
  // the picker when the field actually settles on a *different known*
  // project — a cosmetic rename is left alone.
  const loadedProjectRef = useRef<string>('');

  // ── Payment modal ─────────────────────────────────────────
  const [payModal,    setPayModal]    = useState(false);
  const [payInvId,    setPayInvId]    = useState<string | null>(null);
  const [payForm,     setPayForm]     = useState({ date: today, amount: '', reference: '', notes: '' });
  const [payErr,      setPayErr]      = useState('');

  // ── Detail modal ──────────────────────────────────────────
  const [detailId,       setDetailId]       = useState<string | null>(null);
  const [detailItems,    setDetailItems]    = useState<InvoiceItem[]>([]);
  const [detailPayments, setDetailPayments] = useState<Payment[]>([]);
  const [detailLoad,     setDetailLoad]     = useState(false);

  // ── Toast ─────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 4.8 — per-invoice busy set for the deterministic PDF export.
  // Prevents double-click re-entry per row and lets the row / modal
  // button swap its label to "Generating…" while pdfkit is running. The
  // detail-modal button also participates via `detailInv?.id`. Cleared
  // in a `finally` so a thrown error never leaves the button disabled.
  const [pdfBusy, setPdfBusy] = useState<Set<string>>(new Set());
  const isPdfBusy = (id: string) => pdfBusy.has(id);
  async function runPdfExport(id: string, model: InvoicePrintModel) {
    setPdfBusy(prev => { const next = new Set(prev); next.add(id); return next; });
    try {
      await generateInvoicePdf(model);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('pdf: generation failed', err);
      showToast('PDF generation failed: ' + msg, false);
    } finally {
      setPdfBusy(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const [FIN_PROJECTS, setFinProjects] = useState<string[]>([]);

  useEffect(() => {
    ensureProjectsLoaded().then(() => setFinProjects(getProjectNames()));
  }, []);

  if (!hasPerm('view_fin_invoices')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    // Single bulk fetch of invoice_items (all rows) — used both as the
    // per-invoice detail source and as the history feed for cumulative
    // Site / PO validation. No per-site sub-query.
    const [cl, inv, pym, itm, rev, po, cs, ba] = await Promise.all([
      supabase.from('clients').select('*').order('company_name'),
      supabase.from('invoices').select('*').order('created_at', { ascending: false }),
      supabase.from('invoice_payments').select('*'),
      supabase.from('invoice_items').select('*'),
      supabase.from('revenue').select('*').order('project_name').order('section_name').order('site_id'),
      supabase.from('purchase_orders').select('*').order('created_at', { ascending: false }),
      // Phase 4: company profile + active banks — single row and small
      // table respectively. Errors are tolerated (RLS or unmigrated
      // env) — print template just hides those sections.
      supabase.from('company_settings').select('*').limit(1).maybeSingle(),
      supabase.from('bank_accounts').select('*').eq('is_active', true).order('sort_order').order('bank_name'),
    ]);
    const invList: Invoice[] = inv.data || [];
    const itmList: InvoiceItem[] = itm.data || [];

    // Auto-overdue: find invoices with past due_date, not Paid/Overdue, amount_received < total
    const overdueToUpdate = invList.filter(i =>
      i.due_date && i.due_date < today &&
      i.status !== 'Paid' && i.status !== 'Overdue' &&
      (+i.amount_received || 0) < (+i.total_amount || 0)
    );
    if (overdueToUpdate.length > 0) {
      const ids = overdueToUpdate.map(i => i.id);
      await supabase.from('invoices').update({ status: 'Overdue' }).in('id', ids);
      overdueToUpdate.forEach(i => { i.status = 'Overdue'; });
    }

    setClients(cl.data || []);
    setInvoices(invList);
    setPayments(pym.data || []);
    setItems(itmList);
    setRevenue((rev.data || []) as RevRow[]);
    setPurchaseOrders((po.data || []) as PurchaseOrder[]);
    setCompanySettings((cs.data as CompanySettings | null) || null);
    setBankAccounts((ba.data || []) as BankAccount[]);
    // History rows for cumulative validation. Filtered to shape the
    // helpers expect (invoice_id + amount always present; revenue_id
    // may be null for custom items — which is fine because
    // previouslyInvoicedForRevenue only sums matches).
    setItemHistory(itmList.map(x => ({
      invoice_id: x.invoice_id,
      revenue_id: x.revenue_id,
      amount: +(x.amount || 0),
    })));
    setLoading(false);
  }, [today]);

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────
  const totalInvoiced    = invoices.reduce((s, r) => s + (+r.total_amount || 0), 0);
  const totalReceived    = invoices.reduce((s, r) => s + (+r.amount_received || 0), 0);
  const totalOutstanding = totalInvoiced - totalReceived;
  const overdueCount     = invoices.filter(r => r.status === 'Overdue').length;

  // invoiceId → po_id map for PO-level cumulative billing lookups.
  // Rebuilt from `invoices` state so it stays in sync after edits.
  const invoicePoMap = new Map<string, string | null>(
    invoices.map(i => [i.id, i.po_id ?? null] as const)
  );

  // Selected PO (if any) for the currently open modal.
  const selectedPO = invForm.poId ? purchaseOrders.find(p => p.id === invForm.poId) : undefined;

  // Discount / tax coerced to numbers for live-summary math. Nulls,
  // blanks, and NaN all collapse to 0.
  const discountNum = Math.max(0, +invForm.discount || 0);
  const taxNum      = Math.max(0, +invForm.tax || 0);
  const milestonePct = +invForm.milestonePercent || 0;

  // Revenue line items from checked boxes — with transient UX fields
  // populated for the line-item table (previouslyInvoiced, remainingBefore,
  // invoicePercent). Amount is override-first, then milestone-derived,
  // then commercial value.
  const revenueLineItems: LineItem[] = revSites
    .filter(r => checkedRevs.has(r.id))
    .map(r => {
      const commercial = +(r.amount || 0);
      const prevInv = previouslyInvoicedForRevenue(itemHistory, r.id, invEditId);
      const remainingBefore = remainingSiteValue(commercial, prevInv);
      const override = lineAmountOverride[r.id];
      // Milestone default: MIN(commercial × pct / 100, remainingBefore).
      // No override + no milestone → default to remainingBefore (the
      // user's most likely intent: "bill what's left"). That preserves
      // the pre-Phase-3B behavior when the site has never been invoiced
      // (remainingBefore === commercial).
      let amt: number;
      if (override !== undefined) {
        amt = override;
      } else if (milestonePct > 0) {
        amt = Math.min(commercial * milestonePct / 100, remainingBefore);
      } else {
        amt = remainingBefore;
      }
      const pct = commercial > 0 ? (amt / commercial) * 100 : 0;
      return {
        site_id: r.site_id,
        section_name: r.section_name || '',
        description: lineDescOverride[r.id]?.trim() || `Site implementation — ${r.site_id}`,
        amount: amt,
        revenue_id: r.id,
        _commercialValue: commercial,
        _previouslyInvoiced: prevInv,
        _remainingBefore: remainingBefore,
        _invoicePercent: pct,
      };
    });
  const allLineItems: LineItem[] = [...revenueLineItems, ...customItems];
  const invSubtotal = calcInvoiceSubtotal(allLineItems);
  const invTotal    = calcInvoiceTotal(invSubtotal, discountNum, taxNum);
  // Commercial subtotal — only revenue-linked lines count against a PO.
  // Custom items are NOT commercial value for PO consumption.
  const commercialSubtotal = calcInvoiceSubtotal(revenueLineItems);

  // Revenue picker grouped by section
  const revSections: Record<string, RevRow[]> = {};
  revSites.forEach(r => {
    const sec = r.section_name || 'No Section';
    if (!revSections[sec]) revSections[sec] = [];
    revSections[sec].push(r);
  });

  // Pending invoice revenue — cumulative view: a site stays "pending"
  // while its remaining commercial value is > 0. Replaces the old
  // "any invoice_item referenced it" boolean exclusion, so partially
  // billed sites now show up here (with the still-billable balance).
  const pendingRevenue = revenue
    .map(r => {
      const prev = previouslyInvoicedForRevenue(itemHistory, r.id, null);
      const remaining = remainingSiteValue(+(r.amount || 0), prev);
      return { r, remaining };
    })
    .filter(x => x.remaining > 0);
  const pendingByProj: Record<string, Array<{ r: RevRow; remaining: number }>> = {};
  pendingRevenue.forEach(x => {
    const p = x.r.project_name || 'Unknown';
    if (!pendingByProj[p]) pendingByProj[p] = [];
    pendingByProj[p].push(x);
  });
  const pendingTotal = pendingRevenue.reduce((s, x) => s + x.remaining, 0);

  // ── Load revenue picker for a project ────────────────────
  //
  // Loads ALL revenue rows for the project (no PO filter here — the picker
  // splits by po_id inside the render into Section A / B / C so newly-
  // created POs with zero mapped sites don't produce an empty picker).
  // Classification is delegated to siteBillingStatus() so a zero-value
  // site renders "Commercial Value Missing" rather than being silently
  // labelled "Fully Invoiced".
  async function loadPickerForProject(
    project: string,
    editId: string | null,
    autoSelectAll = false,
    poId: string | null = null,
  ) {
    if (!project) {
      loadedProjectRef.current = '';
      setRevSites([]);
      setFullyBilledIds(new Set());
      setMissingValueIds(new Set());
      setCheckedRevs(new Set());
      setPickerStatus('Select a project first');
      return;
    }
    loadedProjectRef.current = project;
    setPickerLoad(true);
    setPickerStatus('Loading sites…');
    // Fetch by project_name as before, but when a PO is bound also fetch by
    // po_id and merge. A PO's own project_name can be a PO-specific label
    // (e.g. "Baghdad-Zain -PO#11879 Redeploy Ericsson R") that doesn't
    // literally match the project_name stored on the revenue rows it's
    // already mapped to — without this, sites that are genuinely tied to
    // the PO (and count toward "Mapped Site Value") would silently vanish
    // from the picker.
    let sites: RevRow[];
    if (poId) {
      const [byProject, byPo] = await Promise.all([
        supabase.from('revenue').select('*').eq('project_name', project).order('section_name').order('site_id'),
        supabase.from('revenue').select('*').eq('po_id', poId).order('section_name').order('site_id'),
      ]);
      const merged = new Map<string, RevRow>();
      for (const r of (byProject.data || []) as RevRow[]) merged.set(r.id, r);
      for (const r of (byPo.data || []) as RevRow[]) merged.set(r.id, r);
      sites = Array.from(merged.values()).sort((a, b) =>
        (a.section_name || '').localeCompare(b.section_name || '') || (a.site_id || '').localeCompare(b.site_id || ''));
    } else {
      const { data } = await supabase.from('revenue').select('*').eq('project_name', project).order('section_name').order('site_id');
      sites = (data || []) as RevRow[];
    }
    setRevSites(sites);

    // Classify every row (siteBillingStatus is pure — no extra queries).
    // When editing, the current invoice's own history is excluded so the
    // rows it already claims stay selectable.
    const fullyBilled  = new Set<string>();
    const missingValue = new Set<string>();
    for (const r of sites) {
      const prev = previouslyInvoicedForRevenue(itemHistory, r.id, editId);
      const st = siteBillingStatus(r.amount, prev);
      if (st === 'fully_invoiced')   fullyBilled.add(r.id);
      else if (st === 'missing_value') missingValue.add(r.id);
    }
    setFullyBilledIds(fullyBilled);
    setMissingValueIds(missingValue);

    // Picker status string — scoped to the PO's Section A when a PO is
    // bound, otherwise the full project (backward-compat legacy flow).
    let statusMsg: string;
    if (poId) {
      const inScope = sites.filter(r => r.po_id === poId);
      const available = inScope.filter(r => !fullyBilled.has(r.id) && !missingValue.has(r.id)).length;
      const done      = inScope.filter(r => fullyBilled.has(r.id)).length;
      const missing   = inScope.filter(r => missingValue.has(r.id)).length;
      const parts = [`${available} available in PO`];
      if (done > 0)    parts.push(`${done} fully invoiced`);
      if (missing > 0) parts.push(`${missing} missing value`);
      statusMsg = parts.join(' · ');
    } else {
      const available = sites.length - fullyBilled.size - missingValue.size;
      const parts = [`${available} available`];
      if (fullyBilled.size  > 0) parts.push(`${fullyBilled.size} fully invoiced`);
      if (missingValue.size > 0) parts.push(`${missingValue.size} missing value`);
      statusMsg = parts.join(' · ');
    }
    setPickerStatus(statusMsg);
    setPickerLoad(false);

    if (autoSelectAll) {
      const inScope = poId ? sites.filter(r => r.po_id === poId) : sites;
      setCheckedRevs(new Set(
        inScope
          .filter(r => !fullyBilled.has(r.id) && !missingValue.has(r.id))
          .map(r => r.id),
      ));
    }
  }

  // ── Assign a Site (or bulk) to the selected PO ────────────────
  //
  // Mirrors the assignment guard in src/pages/FinPOs.tsx `tryAssign`. If
  // the projected mapped total after the write would exceed po_amount,
  // surface the same over-allocation modal (default Cancel, destructive
  // "Assign anyway"). On success, patches BOTH `revenue` state (so PO
  // summary math re-flows) AND `revSites` state (so the row moves from
  // Section B into Section A without a modal close/reopen). Does NOT
  // toggle the checkbox — the user still has to check it explicitly in
  // Section A before it becomes part of the invoice.
  async function commitAssignRevIds(revIds: string[], poId: string) {
    if (revIds.length === 0) return;
    setAssigningRevIds(prev => {
      const next = new Set(prev);
      revIds.forEach(id => next.add(id));
      return next;
    });
    try {
      const { data, error } = await supabase
        .from('revenue')
        .update({ po_id: poId })
        .in('id', revIds)
        .select('id, po_id');
      if (error) {
        console.error('assign: supabase update failed', error);
        setAssignError(`Could not assign to PO: ${error.message || 'unknown error'} (code ${error.code || '—'}). Check console for details.`);
        showToast(`Assign failed: ${error.message || 'unknown error'}`, false);
        return;
      }
      if (!data || data.length === 0) {
        // Update returned no rows — likely RLS silently filtered the row
        // out. Surface it rather than pretend the assign succeeded.
        const msg = 'Assign returned 0 rows updated — likely blocked by row-level security. Check permissions.';
        console.error('assign: zero rows updated');
        setAssignError(msg);
        showToast(msg, false);
        return;
      }
      setAssignError(null);
      setRevenue(list => list.map(r => revIds.includes(r.id) ? { ...r, po_id: poId } : r));
      setRevSites(list => list.map(r => revIds.includes(r.id) ? { ...r, po_id: poId } : r));
      showToast(revIds.length === 1 ? 'Site assigned to PO.' : `${revIds.length} sites assigned to PO.`, true);
    } catch (e: unknown) {
      const msg = (e as Error).message || 'Assignment failed.';
      console.error('assign: unexpected exception', e);
      setAssignError(msg);
      showToast(msg, false);
    } finally {
      setAssigningRevIds(prev => {
        const next = new Set(prev);
        revIds.forEach(id => next.delete(id));
        return next;
      });
    }
  }

  function tryAssignRevIds(revIds: string[]) {
    if (!selectedPO || revIds.length === 0) return;
    const poAmount = +(selectedPO.po_amount || 0);
    const currentMapped = revenue
      .filter(r => r.po_id === selectedPO.id)
      .reduce((s, r) => s + (+(r.amount || 0)), 0);
    const addition = revenue
      .filter(r => revIds.includes(r.id))
      .reduce((s, r) => s + (+(r.amount || 0)), 0);
    const projected = currentMapped + addition;
    if (poAmount > 0 && projected > poAmount) {
      setOverallocConfirm({ revIds, projected, poAmount, poNumber: selectedPO.po_number });
      return;
    }
    commitAssignRevIds(revIds, selectedPO.id);
  }

  function confirmOverallocAssign() {
    if (!overallocConfirm || !selectedPO) return;
    const ids = overallocConfirm.revIds;
    setOverallocConfirm(null);
    commitAssignRevIds(ids, selectedPO.id);
  }

  // ── Toggle section checkbox ───────────────────────────────
  // Only toggles rows whose po_id matches the currently selected PO
  // (Section A). Rows in Section B ("Available Project Sites") and
  // Section C ("Assigned to Another PO") are never bulk-toggled — they
  // require an explicit assignment step first. Missing-value and
  // fully-billed rows are also skipped regardless of PO.
  function toggleSection(secName: string, checked: boolean) {
    setCheckedRevs(prev => {
      const next = new Set(prev);
      const selectedPoId = invForm.poId || null;
      revSites.forEach(r => {
        if ((r.section_name || 'No Section') !== secName) return;
        if (fullyBilledIds.has(r.id) || missingValueIds.has(r.id)) return;
        // Only rows already linked to the selected PO (or, in the legacy
        // non-PO flow, any project row) are togglable by the section
        // checkbox. Prevents accidental selection of Section B / C rows.
        if (selectedPoId && r.po_id !== selectedPoId) return;
        if (checked) next.add(r.id); else next.delete(r.id);
      });
      return next;
    });
  }

  // ── Open invoice form ─────────────────────────────────────
  async function openInvModal(id: string | null) {
    setInvEditId(id);
    setInvErr('');
    setAssignError(null);
    setApplyPctMsg(null);
    setRevSites([]);
    setFullyBilledIds(new Set());
    setMissingValueIds(new Set());
    setOverallocConfirm(null);
    setCheckedRevs(new Set());
    setCustomItems([]);
    setShowCustForm(false);
    setCustForm({ site: '', desc: '', amt: '' });
    setLineAmountOverride({});
    setLineDescOverride({});
    setPickerStatus('Select a project first');
    if (id) {
      const inv = invoices.find(x => x.id === id);
      setInvForm({
        clientId:         inv?.client_id                     || '',
        number:           inv?.invoice_number                || '',
        project:          inv?.project_name                  || '',
        projectCode:      inv?.project_code                  || '',
        status:           inv?.status                        || 'Draft',
        issueDate:        inv?.issue_date                    || today,
        dueDate:          inv?.due_date                      || '',
        notes:            inv?.notes                         || '',
        poId:             inv?.po_id                         || '',
        milestoneLabel:   inv?.milestone_label               || '',
        milestonePercent: inv?.milestone_percent != null ? String(inv.milestone_percent) : '',
        discount:         String(+(inv?.discount_amount ?? 0) || 0),
        tax:              String(+(inv?.tax_amount      ?? 0) || 0),
      });
      // Load existing line items
      const { data: existingItems } = await supabase.from('invoice_items').select('*').eq('invoice_id', id);
      const existing: InvoiceItem[] = existingItems || [];
      const revItems = existing.filter(x => x.revenue_id);
      const custItemsList: LineItem[] = existing.filter(x => !x.revenue_id).map(x => ({ ...x, _customId: Date.now() + Math.random() }));
      setCustomItems(custItemsList);
      // Pre-populate the per-line amount overrides from the persisted
      // amounts so the modal renders the exact stored figures (not the
      // freshly-derived milestone default), then load the picker.
      const overrideMap: Record<string, number> = {};
      const descMap: Record<string, string> = {};
      for (const it of revItems) {
        if (!it.revenue_id) continue;
        overrideMap[it.revenue_id] = +(it.amount || 0);
        // Only carry the persisted description forward as an "override" if
        // it differs from the default auto text — otherwise every edit
        // would look pre-overridden even when the user never touched it.
        const defaultDesc = `Site implementation — ${it.site_id}`;
        if (it.description && it.description !== defaultDesc) {
          descMap[it.revenue_id] = it.description;
        }
      }
      setLineAmountOverride(overrideMap);
      setLineDescOverride(descMap);
      if (inv?.project_name) {
        await loadPickerForProject(inv.project_name, id, false, inv?.po_id || null);
        setCheckedRevs(new Set(revItems.map(x => x.revenue_id!).filter(Boolean)));
      }
    } else {
      const year  = new Date().getFullYear();
      const count = invoices.filter(i => i.invoice_number?.startsWith(`${BRAND.invoicePrefix}-${year}-`)).length + 1;
      setInvForm({
        clientId: '', number: `${BRAND.invoicePrefix}-${year}-${String(count).padStart(3, '0')}`,
        project: '', projectCode: '', status: 'Draft', issueDate: today, dueDate: '', notes: '',
        poId: '', milestoneLabel: '', milestonePercent: '', discount: '0', tax: '0',
      });
    }
    setInvModal(true);
  }

  async function invQuickCreate(projectName: string) {
    setInvEditId(null);
    setInvErr('');
    setRevSites([]);
    setFullyBilledIds(new Set());
    setMissingValueIds(new Set());
    setOverallocConfirm(null);
    setCheckedRevs(new Set());
    setCustomItems([]);
    setShowCustForm(false);
    setLineAmountOverride({});
    setLineDescOverride({});
    setPickerStatus('Select a project first');
    const year  = new Date().getFullYear();
    const count = invoices.filter(i => i.invoice_number?.startsWith(`${BRAND.invoicePrefix}-${year}-`)).length + 1;
    setInvForm({
      clientId: '', number: `${BRAND.invoicePrefix}-${year}-${String(count).padStart(3, '0')}`,
      project: projectName, projectCode: '', status: 'Draft', issueDate: today, dueDate: '', notes: '',
      poId: '', milestoneLabel: '', milestonePercent: '', discount: '0', tax: '0',
    });
    setInvModal(true);
    await loadPickerForProject(projectName, null, true, null);
  }

  // ── Save invoice ──────────────────────────────────────────
  //
  // Validation order (fail fast, most specific first):
  //   1. Required fields (client, number, issue date).
  //   2. Discount / tax non-negative, resulting total non-negative.
  //   3. Client/PO consistency: invoice.client_id === po.client_id;
  //      every selected revenue row's po_id === invoice.po_id.
  //   4. PO status: Cancelled blocks; Closed with remaining==0 blocks;
  //      Closed with remaining>0 requires explicit confirm.
  //   5. Site-level: previouslyInvoicedExcludingCurrent + itemAmount
  //      must not exceed revenue.amount for each line.
  //   6. PO-level: previousPOBilled + newCommercialSubtotal must not
  //      exceed po_amount (commercialSubtotal excludes custom items,
  //      discount, and tax).
  async function saveInvoice() {
    setInvErr('');
    if (!invForm.clientId)  { setInvErr('Please select a client.'); return; }
    if (!invForm.number)    { setInvErr('Invoice number is required.'); return; }
    if (!invForm.issueDate) { setInvErr('Issue date is required.'); return; }

    // Discount / tax sanity.
    if (discountNum < 0) { setInvErr('Discount cannot be negative.'); return; }
    if (taxNum      < 0) { setInvErr('Tax cannot be negative.'); return; }
    if (invTotal    < 0) { setInvErr('Invoice total cannot be negative. Reduce the discount.'); return; }

    // Milestone percent bounds (0 < x <= 100 when set).
    if (invForm.milestonePercent.trim() !== '') {
      const p = +invForm.milestonePercent;
      if (!Number.isFinite(p) || p <= 0 || p > 100) {
        setInvErr('Milestone percent must be greater than 0 and at most 100.');
        return;
      }
    }

    const po = invForm.poId ? purchaseOrders.find(p => p.id === invForm.poId) : undefined;

    // Client / PO consistency (spec §13).
    if (po) {
      if (po.client_id !== invForm.clientId) {
        setInvErr('Client does not match the selected PO. Choose a PO belonging to this client.');
        return;
      }
      const bad = revenueLineItems.find(li => {
        const rev = revenue.find(r => r.id === li.revenue_id);
        return rev && rev.po_id !== po.id;
      });
      if (bad) {
        setInvErr(`Site ${bad.site_id ?? ''} is not linked to the selected PO. Only sites mapped to this PO can be billed here.`);
        return;
      }
    }

    // PO status guards (spec §14). Selection-time UI already prevents
    // most of these, but re-verify at save so a stale form or a status
    // change mid-edit can't slip through.
    if (po) {
      const alreadyBilled = billedCommercialValueForPO(itemHistory, invoicePoMap, po.id, invEditId);
      const poRemaining   = remainingPOValue(+(po.po_amount || 0), alreadyBilled);
      if (po.status === 'Cancelled' && !invEditId) {
        setInvErr(`PO ${po.po_number} is Cancelled and cannot be used for new invoices.`);
        return;
      }
      if (po.status === 'Closed' && poRemaining <= 0 && !invEditId) {
        setInvErr(`PO ${po.po_number} is Closed with 0 remaining value — no further invoices allowed.`);
        return;
      }
      if (po.status === 'Closed' && poRemaining > 0 && !invEditId) {
        if (!window.confirm(`PO ${po.po_number} is Closed but still has ${iqd(poRemaining)} remaining. Create this invoice anyway?`)) {
          return;
        }
      }
    }

    // Site-level cumulative validation (spec §11). Excludes the current
    // invoice's own historical rows so an edit that lowers or holds a
    // line steady never trips its own past self. A zero-commercial-value
    // site slipping through (e.g. legacy edit path or race) is blocked
    // outright with a clear message — it must not consume PO capacity or
    // pretend to be "fully billed".
    for (const li of revenueLineItems) {
      if (!li.revenue_id) continue;
      const rev = revenue.find(r => r.id === li.revenue_id);
      if (!rev) continue;
      const commercial = +(rev.amount || 0);
      if (!Number.isFinite(commercial) || commercial <= 0) {
        setInvErr(`Site ${rev.site_id ?? li.revenue_id}: commercial value is missing — set it in Revenue before invoicing.`);
        return;
      }
      const prevInv    = previouslyInvoicedForRevenue(itemHistory, li.revenue_id, invEditId);
      const attempt    = +(li.amount || 0);
      // Raw arithmetic — NOT the clamped display remaining — is what
      // decides. A legacy over-billed row must still see the true
      // negative to be blocked.
      if (prevInv + attempt > commercial) {
        const maxAvail = Math.max(commercial - prevInv, 0);
        setInvErr(
          `Site ${rev.site_id ?? ''}: commercial value ${iqd(commercial)}, previously invoiced ${iqd(prevInv)}, `
          + `attempted ${iqd(attempt)}, maximum available ${iqd(maxAvail)}.`
        );
        return;
      }
    }

    // PO-level cumulative validation (spec §12). Uses the commercial
    // subtotal — NOT total_amount — so discount and tax never affect
    // PO consumption.
    if (po) {
      const previousPOBilled = billedCommercialValueForPO(itemHistory, invoicePoMap, po.id, invEditId);
      const attemptedTotal   = previousPOBilled + commercialSubtotal;
      const poAmount         = +(po.po_amount || 0);
      if (attemptedTotal > poAmount) {
        const overage = attemptedTotal - poAmount;
        setInvErr(
          `PO ${po.po_number}: PO value ${iqd(poAmount)}, already billed ${iqd(previousPOBilled)}, `
          + `this invoice ${iqd(commercialSubtotal)}, attempted total ${iqd(attemptedTotal)}, overage ${iqd(overage)}.`
        );
        return;
      }
    }

    // Persistence payload. total_amount = subtotal − discount + tax
    // (calcInvoiceTotal already applied above → invTotal). PO consumption
    // is invoiceSubtotal(items), not total_amount (see PO validation
    // block above, spec §22 scenarios E/F).
    const payload = {
      client_id:         invForm.clientId,
      invoice_number:    invForm.number.trim(),
      project_name:      invForm.project || null,
      project_code:      invForm.projectCode.trim() || null,
      issue_date:        invForm.issueDate,
      due_date:          invForm.dueDate || null,
      status:            invForm.status || 'Draft',
      total_amount:      invTotal,
      notes:             invForm.notes.trim() || null,
      created_by:        currentUser?.full_name || '',
      po_id:             invForm.poId || null,
      milestone_label:   invForm.milestoneLabel.trim() || null,
      milestone_percent: invForm.milestonePercent.trim() === '' ? null : +invForm.milestonePercent,
      discount_amount:   discountNum,
      tax_amount:        taxNum,
    };
    try {
      let invoiceId = invEditId;
      if (invEditId) {
        const { error } = await supabase.from('invoices').update(payload).eq('id', invEditId);
        if (error) throw error;
        setInvoices(list => list.map(i => i.id === invEditId ? { ...i, ...payload } : i));
        await supabase.from('invoice_items').delete().eq('invoice_id', invEditId);
      } else {
        const { data, error } = await supabase.from('invoices').insert(payload).select('*').single();
        if (error) throw error;
        setInvoices(list => [data, ...list]);
        invoiceId = data.id;
      }
      // Strip transient UI-only fields (leading _) from the payload —
      // invoice_items schema is unchanged (spec §5).
      if (allLineItems.length > 0 && invoiceId) {
        const itemPayloads = allLineItems.map(item => ({
          invoice_id:   invoiceId,
          site_id:      item.site_id || null,
          section_name: item.section_name || null,
          description:  item.description || null,
          amount:       +(item.amount || 0),
          revenue_id:   item.revenue_id || null,
        }));
        const { data: savedItems } = await supabase.from('invoice_items').insert(itemPayloads).select('*');
        if (savedItems) {
          setItems(prev => {
            const filtered = prev.filter(x => x.invoice_id !== invoiceId);
            return [...filtered, ...savedItems];
          });
          // Refresh itemHistory in-place: strip prior rows for this
          // invoice, append the fresh ones. Keeps the cumulative maps
          // accurate without a re-fetch.
          setItemHistory(prev => {
            const filtered = prev.filter(x => x.invoice_id !== invoiceId);
            return [
              ...filtered,
              ...savedItems.map((x: InvoiceItem) => ({
                invoice_id: x.invoice_id,
                revenue_id: x.revenue_id,
                amount: +(x.amount || 0),
              })),
            ];
          });
        }
      } else if (invEditId && invoiceId) {
        setItems(prev => prev.filter(x => x.invoice_id !== invoiceId));
        setItemHistory(prev => prev.filter(x => x.invoice_id !== invoiceId));
      }
      setInvModal(false);
      showToast(invEditId ? 'Invoice updated.' : 'Invoice created!', true);
    } catch (e: unknown) {
      setInvErr((e as Error).message);
    }
  }

  async function deleteInvoice(id: string) {
    const hasPayments = payments.some(p => p.invoice_id === id);
    if (hasPayments) {
      showToast('Cannot delete: this invoice has recorded payments. Remove or correct the payments first, or void the invoice.', false);
      return;
    }
    const inv = invoices.find(i => i.id === id);
    if (!window.confirm(`Delete invoice ${inv?.invoice_number || 'this invoice'}? This cannot be undone.`)) return;
    const { error: itemErr } = await supabase.from('invoice_items').delete().eq('invoice_id', id);
    if (itemErr) { showToast(itemErr.message, false); return; }
    const { error } = await supabase.from('invoices').delete().eq('id', id);
    if (error) { showToast(error.message, false); return; }
    setInvoices(list => list.filter(i => i.id !== id));
    setItems(list => list.filter(i => i.invoice_id !== id));
    setItemHistory(prev => prev.filter(x => x.invoice_id !== id));
    showToast('Invoice deleted.', true);
  }

  // ── Payment modal ─────────────────────────────────────────
  function openPayModal(invoiceId: string) {
    setPayInvId(invoiceId);
    setPayForm({ date: today, amount: '', reference: '', notes: '' });
    setPayErr('');
    setDetailId(null); // close detail if open
    setPayModal(true);
  }

  // ── Source-of-truth: recalculate invoice financial state from ledger ──────────
  async function recalcInvoice(invoiceId: string, updatedPayments: Payment[]) {
    const inv = invoices.find(i => i.id === invoiceId);
    if (!inv) return;
    const total    = +inv.total_amount || 0;
    const received = updatedPayments
      .filter(p => p.invoice_id === invoiceId)
      .reduce((s, p) => s + (+p.amount || 0), 0);
    const newStatus = received >= total && total > 0
      ? 'Paid'
      : received > 0
        ? 'Partial'
        : (inv.status === 'Paid' || inv.status === 'Partial') ? 'Draft' : inv.status;
    await supabase.from('invoices').update({ amount_received: received, status: newStatus }).eq('id', invoiceId);
    setInvoices(list => list.map(i => i.id === invoiceId ? { ...i, amount_received: received, status: newStatus } : i));
  }

  async function savePayment() {
    setPayErr('');
    if (!payForm.date)                            { setPayErr('Payment date is required.'); return; }
    if (!+payForm.amount || +payForm.amount <= 0) { setPayErr('Amount must be greater than 0.'); return; }
    const inv = invoices.find(x => x.id === payInvId);
    if (!inv || !payInvId) { setPayErr('Invoice not found.'); return; }
    const existingReceived = payments
      .filter(p => p.invoice_id === payInvId)
      .reduce((s, p) => s + (+p.amount || 0), 0);
    const total = +inv.total_amount || 0;
    if (total > 0 && existingReceived + +payForm.amount > total) {
      const maxAdd = total - existingReceived;
      setPayErr(`Payment would exceed invoice total. Maximum additional payment: ${maxAdd.toLocaleString()} IQD.`);
      return;
    }
    const payload = {
      invoice_id:   payInvId,
      payment_date: payForm.date,
      amount:       +payForm.amount,
      reference:    payForm.reference.trim() || null,
      notes:        payForm.notes.trim()     || null,
      recorded_by:  currentUser?.full_name   || '',
    };
    const { data: newPay, error } = await supabase.from('invoice_payments').insert(payload).select('*').single();
    if (error) { setPayErr(error.message); return; }
    const updatedPayments = [...payments, newPay as Payment];
    setPayments(updatedPayments);
    await recalcInvoice(payInvId, updatedPayments);
    setPayModal(false);
    showToast('Payment recorded!', true);
  }

  async function deletePayment(paymentId: string, invoiceId: string) {
    if (!window.confirm('Delete this payment record? This cannot be undone.')) return;
    const { error } = await supabase.from('invoice_payments').delete().eq('id', paymentId);
    if (error) { showToast(error.message, false); return; }
    const updatedPayments = payments.filter(p => p.id !== paymentId);
    setPayments(updatedPayments);
    setDetailPayments(dp => dp.filter(p => p.id !== paymentId));
    await recalcInvoice(invoiceId, updatedPayments);
    showToast('Payment deleted.', true);
  }

  // ── Detail modal ──────────────────────────────────────────
  async function openDetail(id: string) {
    setDetailId(id);
    setDetailLoad(true);
    const [di, dp] = await Promise.all([
      supabase.from('invoice_items').select('*').eq('invoice_id', id),
      supabase.from('invoice_payments').select('*').eq('invoice_id', id).order('payment_date'),
    ]);
    setDetailItems(di.data || []);
    setDetailPayments(dp.data || []);
    setDetailLoad(false);
  }

  // ── Filtered invoices ─────────────────────────────────────
  const filteredInvoices = statusFilter ? invoices.filter(i => i.status === statusFilter) : invoices;

  if (loading) return <div className={css.placeholder}>Loading…</div>;

  const detailInv = detailId ? invoices.find(x => x.id === detailId) : null;
  const detailClient = detailInv ? clients.find(c => c.id === detailInv.client_id) : undefined;

  // ── Render ────────────────────────────────────────────────
  return (
    <div className={css.page}>
      {/* Header */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Invoices</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
          {hasPerm('fin_invoices_add') && (
            <button className={css.btnAccent} onClick={() => openInvModal(null)}>+ New Invoice</button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className={css.kpiRow}>
        <div className={`${css.kpiCard} ${css.kpiBlue}`}>
          <div className={css.kpiLabel}>Total Invoiced</div>
          <div className={css.kpiValue}>{iqd(totalInvoiced)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiGreen}`}>
          <div className={css.kpiLabel}>Received</div>
          <div className={css.kpiValue}>{iqd(totalReceived)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiAmber}`}>
          <div className={css.kpiLabel}>Outstanding</div>
          <div className={css.kpiValue}>{iqd(totalOutstanding)}</div>
        </div>
        <div className={`${css.kpiCard} ${css.kpiRed}`}>
          <div className={css.kpiLabel}>Overdue</div>
          <div className={css.kpiValue}>{overdueCount}</div>
        </div>
      </div>

      {/* Status Filters */}
      <div className={css.statusPills}>
        {(['', 'Draft', 'Sent', 'Partial', 'Paid', 'Overdue'] as const).map(s => {
          const count   = s ? invoices.filter(r => r.status === s).length : invoices.length;
          const active  = statusFilter === s;
          const color   = STATUS_PILL_ACTIVE[s] || '#1d4ed8';
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all .15s',
                border: `1.5px solid ${active ? color : '#e2e8f0'}`,
                background: active ? color : 'transparent',
                color: active ? '#fff' : '#64748b',
              }}
            >
              {s || 'All'} <span style={{ opacity: .75 }}>({count})</span>
            </button>
          );
        })}
      </div>

      {/* Invoices Table */}
      <div className={css.tableWrap}>
        <table className={css.table} style={{ fontSize: 12 }}>
          <thead><tr>
            <th style={{ whiteSpace: 'nowrap' }}>Invoice #</th>
            <th>Client / Project</th>
            <th>Sites</th>
            <th>Dates</th>
            <th className={css.num}>Total</th>
            <th className={css.num}>Received</th>
            <th className={css.num}>Outstanding</th>
            <th>Status</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {filteredInvoices.length === 0
              ? <tr><td colSpan={9} className={css.empty}>{statusFilter ? `No ${statusFilter} invoices.` : 'No invoices yet. Click "+ New Invoice" to create your first invoice.'}</td></tr>
              : filteredInvoices.map(inv => {
                  const client      = clients.find(c => c.id === inv.client_id);
                  const outstanding = (+inv.total_amount || 0) - (+inv.amount_received || 0);
                  const invSites    = items.filter(x => x.invoice_id === inv.id);
                  const isOverdue   = inv.due_date && inv.due_date < today && inv.status !== 'Paid';
                  return (
                    <tr key={inv.id}>
                      <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{inv.invoice_number || '—'}</td>
                      <td style={{ maxWidth: 140 }}>
                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{client?.company_name || '—'}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inv.project_name || '—'}</div>
                      </td>
                      <td style={{ maxWidth: 160 }}>
                        {invSites.length === 0
                          ? <span style={{ color: '#94a3b8' }}>—</span>
                          : invSites.map(s => (
                              <span key={s.id} className={css.siteBadge}>
                                <span>{String(s.site_id || '')}</span>
                                {s.section_name && <span className={css.siteBadgeSec}>{s.section_name}</span>}
                              </span>
                            ))
                        }
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <div style={{ fontSize: 11, color: '#64748b' }}>📤 {inv.issue_date || '—'}</div>
                        <div style={{ fontSize: 11, color: isOverdue ? '#dc2626' : '#64748b', marginTop: 2 }}>⏱ {inv.due_date || '—'}</div>
                      </td>
                      <td className={css.num} style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(inv.total_amount || 0)}</td>
                      <td className={css.num} style={{ color: '#16a34a', fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(inv.amount_received || 0)}</td>
                      <td className={css.num} style={{ color: outstanding > 0 ? '#dc2626' : '#16a34a', fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(outstanding)}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: STATUS_COLOR[inv.status] || '#f1f5f9', color: STATUS_TEXT[inv.status] || '#475569' }}>
                          {inv.status || 'Draft'}
                        </span>
                      </td>
                      <td>
                        <div className={css.actWrap}>
                          <button className={css.actBtn} title="View Detail" onClick={() => openDetail(inv.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          </button>
                          {hasPerm('fin_invoices_edit') && (
                            <button className={css.actBtn} title="Edit" onClick={() => openInvModal(inv.id)}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                          )}
                          {hasPerm('fin_invoices_record_payment') && (
                            <button className={css.actBtn} title="Record Payment" onClick={() => openPayModal(inv.id)} style={{ color: '#16a34a' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                            </button>
                          )}
                          {hasPerm('fin_invoices_download_pdf') && (
                            <button className={css.actBtn} title="Download PDF" onClick={() => {
                              const client2 = clients.find(c => c.id === inv.client_id);
                              const invItems = items.filter(x => x.invoice_id === inv.id);
                              const invPayments = payments.filter(x => x.invoice_id === inv.id);
                              const po = inv.po_id ? purchaseOrders.find(p => p.id === inv.po_id) : null;
                              const currency = (po?.currency || 'IQD').toUpperCase();
                              const bank = selectBank(bankAccounts, currency);
                              const model = buildPrintModel(inv, client2, invItems, invPayments, po || null, companySettings, bank, itemHistory, invoicePoMap, revenue);
                              printInvoice(model);
                            }} style={{ color: '#7c3aed' }}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
                            </button>
                          )}
                          {hasPerm('fin_invoices_download_pdf') && (
                            /* Phase 4.8 — deterministic PDF export via @react-pdf/renderer.
                               Sits next to the existing Print button (which uses window.print
                               and depends on the browser engine). This one produces
                               byte-different but layout-identical output across Chrome /
                               Safari / Edge. Same permission gate; same model. */
                            <button
                              className={css.actBtn}
                              title="Download PDF (deterministic)"
                              disabled={isPdfBusy(inv.id)}
                              onClick={() => {
                                const client2 = clients.find(c => c.id === inv.client_id);
                                const invItems = items.filter(x => x.invoice_id === inv.id);
                                const invPayments = payments.filter(x => x.invoice_id === inv.id);
                                const po = inv.po_id ? purchaseOrders.find(p => p.id === inv.po_id) : null;
                                const currency = (po?.currency || 'IQD').toUpperCase();
                                const bank = selectBank(bankAccounts, currency);
                                const model = buildPrintModel(inv, client2, invItems, invPayments, po || null, companySettings, bank, itemHistory, invoicePoMap, revenue);
                                void runPdfExport(inv.id, model);
                              }}
                              style={{ color: '#0f172a' }}
                            >
                              {isPdfBusy(inv.id) ? (
                                <span style={{ fontSize: 9, fontWeight: 700 }}>…</span>
                              ) : (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#0f172a" strokeWidth="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                              )}
                            </button>
                          )}
                          {hasPerm('fin_invoices_delete') && (
                            <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => deleteInvoice(inv.id)}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
            }
          </tbody>
        </table>
      </div>

      {/* Pending Invoice Section */}
      {pendingRevenue.length === 0
        ? <div className={css.pendingAllDone}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle', marginRight: 6 }}><polyline points="20 6 9 17 4 12"/></svg>
            All revenue entries have been invoiced.
          </div>
        : <div className={css.pendingSection}>
            <div className={css.pendingHdr}>
              <div className={css.pendingTitle}>
                <span className={css.pendingSiteBadge}>{pendingRevenue.length} sites</span>
                Pending Invoice
              </div>
              <div className={css.pendingTotalAmt}>{iqd(pendingTotal)} not yet invoiced</div>
            </div>
            {Object.entries(pendingByProj).map(([proj, sites]) => (
              <div key={proj} className={css.pendingGroup}>
                <div className={css.pendingGroupHdr}>
                  <div className={css.pendingGroupName}>{proj}</div>
                  <div className={css.pendingGroupActions}>
                    <div className={css.pendingGroupMeta}>{sites.length} sites · {iqd(sites.reduce((s, x) => s + x.remaining, 0))}</div>
                    <button className={css.btnInvoiceNow} onClick={() => invQuickCreate(proj)}>⚡ Invoice Now</button>
                  </div>
                </div>
                <table className={css.table} style={{ fontSize: 12 }}>
                  <thead><tr><th>Section</th><th>Site ID</th><th>Status</th><th className={css.num}>Remaining (IQD)</th></tr></thead>
                  <tbody>
                    {sites.map(({ r, remaining }) => (
                      <tr key={r.id}>
                        <td style={{ color: '#64748b' }}>{r.section_name || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{String(r.site_id || '—')}</td>
                        <td>
                          <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, fontWeight: 600, background: r.status === 'Accepted' ? '#dcfce7' : '#fef3c7', color: r.status === 'Accepted' ? '#16a34a' : '#b45309' }}>
                            {r.status || '—'}
                          </span>
                        </td>
                        <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(remaining)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
      }

      {/* Invoice Modal */}
      {invModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setInvModal(false); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.modalTitle}>{invEditId ? 'Edit Invoice' : 'New Invoice'}</div>
            <div className={css.formGrid}>
              <div className={css.formField}>
                <label>Client *</label>
                <select className={css.formSel} value={invForm.clientId} onChange={e => setInvForm(f => ({ ...f, clientId: e.target.value }))}>
                  <option value="">— Select Client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div className={css.formField}>
                <label>Invoice # *</label>
                <input className={css.formInput} placeholder={`${BRAND.invoicePrefix}-2026-001`} maxLength={30}
                  value={invForm.number} onChange={e => setInvForm(f => ({ ...f, number: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Purchase Order</label>
                <select className={css.formSel}
                  value={invForm.poId}
                  disabled={!invForm.clientId}
                  onChange={e => {
                    const newPoId = e.target.value;
                    const po = newPoId ? purchaseOrders.find(p => p.id === newPoId) : undefined;
                    // Closed with remaining > 0 needs an explicit confirm
                    // at selection (re-verified at save). Cancelled and
                    // Closed-with-0-remaining are blocked outright for
                    // NEW invoices, and left selectable on edit (so an
                    // existing invoice can still be inspected).
                    if (po && !invEditId) {
                      const billed = billedCommercialValueForPO(itemHistory, invoicePoMap, po.id, null);
                      const rem    = remainingPOValue(+(po.po_amount || 0), billed);
                      if (po.status === 'Cancelled') {
                        showToast(`PO ${po.po_number} is Cancelled and cannot be selected for a new invoice.`, false);
                        return;
                      }
                      if (po.status === 'Closed' && rem <= 0) {
                        showToast(`PO ${po.po_number} is Closed with 0 remaining — no further invoices allowed.`, false);
                        return;
                      }
                      if (po.status === 'Closed' && rem > 0) {
                        if (!window.confirm(`PO ${po.po_number} is Closed but has ${iqd(rem)} remaining. Select anyway?`)) return;
                      }
                    }
                    setInvForm(f => ({
                      ...f,
                      poId: newPoId,
                      // When a PO is selected on NEW invoice, default project
                      // to the PO's project (spec §3). On edit, do not
                      // silently relink — preserve the existing project.
                      project: (!invEditId && po?.project_name) ? po.project_name : f.project,
                    }));
                    setCheckedRevs(new Set());
                    setLineAmountOverride({});
                    setLineDescOverride({});
                    const proj = (!invEditId && po?.project_name) ? po.project_name : invForm.project;
                    if (proj) loadPickerForProject(proj, invEditId, false, newPoId || null);
                  }}>
                  <option value="">— None (Legacy / Non-PO) —</option>
                  {(() => {
                    const forClient = purchaseOrders.filter(p => p.client_id === invForm.clientId);
                    const open      = forClient.filter(p => p.status === 'Open');
                    const other     = forClient.filter(p => p.status !== 'Open');
                    return [...open, ...other].map(p => (
                      <option key={p.id} value={p.id}
                        disabled={!invEditId && p.status === 'Cancelled'}
                        style={p.status !== 'Open' ? { color: '#94a3b8' } : undefined}>
                        {p.po_number} · {iqd(p.po_amount)} · {p.status}
                      </option>
                    ));
                  })()}
                </select>
              </div>
              <div className={css.formField}>
                <label>Project {selectedPO && !invEditId ? '(auto-filled from PO — type to change)' : ''}</label>
                <input className={css.formInput} list="fin-project-suggestions" placeholder="Type or pick a project…"
                  value={invForm.project}
                  onChange={e => {
                    // Just update the text as the user types — reloading the
                    // site picker on every keystroke would fire a Supabase
                    // query per character. The picker refreshes on blur/Enter
                    // instead, once the project name has settled.
                    const p = e.target.value;
                    setInvForm(f => ({ ...f, project: p }));
                  }}
                  onBlur={e => {
                    const p = e.target.value.trim();
                    // No actual change — nothing to reload.
                    if (p === loadedProjectRef.current) return;
                    // Cleared the field entirely: reset the picker to its
                    // empty "select a project" state.
                    if (!p) {
                      setCheckedRevs(new Set());
                      setLineAmountOverride({});
                      setLineDescOverride({});
                      loadPickerForProject('', invEditId, false, invForm.poId || null);
                      return;
                    }
                    // Only re-query revenue rows (and reset the picked
                    // sites) when the field settled on a genuinely
                    // different *known* project. A cosmetic rename — text
                    // typed for the printed invoice that doesn't match any
                    // real project — is left alone so it doesn't wipe the
                    // sites/overrides already selected.
                    if (!FIN_PROJECTS.includes(p)) return;
                    setCheckedRevs(new Set());
                    setLineAmountOverride({});
                    setLineDescOverride({});
                    loadPickerForProject(p, invEditId, false, invForm.poId || null);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
                <datalist id="fin-project-suggestions">
                  {FIN_PROJECTS.filter(p => p !== 'General').map(p => <option key={p} value={p} />)}
                </datalist>
              </div>
              <div className={css.formField}>
                <label>Project Code</label>
                <input className={css.formInput} placeholder="Optional — e.g. PC-00142" maxLength={40}
                  value={invForm.projectCode}
                  onChange={e => setInvForm(f => ({ ...f, projectCode: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Status</label>
                <select className={css.formSel} value={invForm.status} onChange={e => setInvForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="Draft">Draft</option>
                  <option value="Sent">Sent</option>
                  <option value="Partial">Partial</option>
                  <option value="Paid">Paid</option>
                  <option value="Overdue">Overdue</option>
                </select>
              </div>
              <div className={css.formField}>
                <label>Issue Date *</label>
                <input type="date" className={css.formInput} value={invForm.issueDate} onChange={e => setInvForm(f => ({ ...f, issueDate: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Due Date</label>
                <input type="date" className={css.formInput} value={invForm.dueDate} onChange={e => setInvForm(f => ({ ...f, dueDate: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={invForm.notes} onChange={e => setInvForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Billing Stage / Milestone Name</label>
                <input className={css.formInput} placeholder="e.g. First Milestone" maxLength={80}
                  value={invForm.milestoneLabel}
                  onChange={e => setInvForm(f => ({ ...f, milestoneLabel: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Invoice Percentage (%)</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="number" min={0} max={100} step="0.01" className={css.formInput}
                    placeholder="e.g. 70"
                    value={invForm.milestonePercent}
                    onChange={e => { setInvForm(f => ({ ...f, milestonePercent: e.target.value })); setApplyPctMsg(null); }} />
                  {(() => {
                    const pctRaw = invForm.milestonePercent.trim();
                    const pctNum = +pctRaw;
                    const pctValid = pctRaw !== '' && Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 100;
                    const hasSelection = checkedRevs.size > 0;
                    const btnDisabled = !pctValid || !hasSelection;
                    const btnLabel = pctValid ? `Apply ${pctNum}%` : 'Apply %';
                    return (
                      <button type="button" className={css.btnGhost}
                        disabled={btnDisabled}
                        title={
                          !pctValid ? 'Enter an invoice percentage between 0 and 100.'
                          : !hasSelection ? 'Select at least one Site before applying the percentage.'
                          : `Fill each selected line's amount with MIN(commercial × ${pctNum}/100, remaining)`
                        }
                        onClick={() => {
                          // Defensive: mirror the disabled-state checks so
                          // a race condition (e.g. sites unchecked between
                          // render and click) surfaces a visible message
                          // rather than a silent no-op.
                          if (!pctValid) { setApplyPctMsg('Enter an invoice percentage between 0 and 100.'); return; }
                          if (!hasSelection) { setApplyPctMsg('Select at least one Site before applying the percentage.'); return; }
                          setApplyPctMsg(null);
                          const next: Record<string, number> = { ...lineAmountOverride };
                          for (const r of revSites) {
                            if (!checkedRevs.has(r.id)) continue;
                            const commercial = +(r.amount || 0);
                            const prevInv    = previouslyInvoicedForRevenue(itemHistory, r.id, invEditId);
                            const remBefore  = remainingSiteValue(commercial, prevInv);
                            next[r.id] = Math.min(commercial * pctNum / 100, remBefore);
                          }
                          setLineAmountOverride(next);
                        }}>
                        {btnLabel}
                      </button>
                    );
                  })()}
                </div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>Applied to selected Sites only.</div>
                {applyPctMsg && (
                  <div style={{
                    background: '#fef3c7', color: '#92400e',
                    border: '1px solid #fde68a', borderRadius: 6,
                    padding: '6px 10px', marginTop: 6, fontSize: 12,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
                  }}>
                    <span>{applyPctMsg}</span>
                    <button type="button" onClick={() => setApplyPctMsg(null)}
                      style={{ background: 'transparent', border: 'none', color: '#92400e', cursor: 'pointer', fontWeight: 700 }}
                      title="Dismiss">×</button>
                  </div>
                )}
              </div>
              <div className={css.formField}>
                <label>Discount</label>
                <input type="number" min={0} step="1" className={css.formInput}
                  value={invForm.discount}
                  onChange={e => setInvForm(f => ({ ...f, discount: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Tax</label>
                <input type="number" min={0} step="1" className={css.formInput}
                  value={invForm.tax}
                  onChange={e => setInvForm(f => ({ ...f, tax: e.target.value }))} />
              </div>
              {invEditId && (
                <div className={css.formField}>
                  <label>Received to Date</label>
                  <div style={{ padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 14, fontWeight: 700, color: '#16a34a' }}>
                    {iqd(payments.filter(p => p.invoice_id === invEditId).reduce((s, p) => s + (+p.amount || 0), 0))}
                    <span style={{ fontSize: 11, fontWeight: 400, color: '#64748b', marginLeft: 8 }}>from payment ledger — read only</span>
                  </div>
                </div>
              )}
            </div>

            {/* PO summary card — only when a PO is bound. Uses helpers
                so figures stay in sync with saveInvoice() validation.
                Never confuse Remaining PO (billed vs. authorized) with
                Outstanding Payment (billed vs. received). */}
            {selectedPO && (() => {
              const alreadyBilled = billedCommercialValueForPO(itemHistory, invoicePoMap, selectedPO.id, invEditId);
              const remainingAfter = remainingPOValue(+(selectedPO.po_amount || 0), alreadyBilled + commercialSubtotal);
              const mappedSiteValue = revenue
                .filter(r => r.po_id === selectedPO.id)
                .reduce((s, r) => s + (+(r.amount || 0)), 0);
              return (
                <div style={{ marginTop: 14, padding: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                  <div className={css.pickerLabel} style={{ marginBottom: 8 }}>
                    PO CONSUMPTION — {selectedPO.po_number} ({selectedPO.currency || 'IQD'} · {selectedPO.status})
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, fontSize: 12 }}>
                    <div><div style={{ color: '#94a3b8' }}>PO Date</div><strong>{selectedPO.po_date || '—'}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>PO Value</div><strong>{iqd(selectedPO.po_amount)}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>Project</div><strong>{selectedPO.project_name || '—'}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>Mapped Site Value</div><strong>{iqd(mappedSiteValue)}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>Previously Billed</div><strong>{iqd(alreadyBilled)}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>This Invoice (Commercial)</div><strong style={{ color: '#2563eb' }}>{iqd(commercialSubtotal)}</strong></div>
                    <div><div style={{ color: '#94a3b8' }}>Remaining After Save</div>
                      <strong style={{ color: remainingAfter <= 0 ? '#dc2626' : '#16a34a' }}>{iqd(remainingAfter)}</strong>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Revenue Picker.
                Two rendering modes:
                  • When a PO is bound → split into Section A / B / C so
                    users can assign newly-mapped sites to the PO without
                    leaving the invoice modal (Issue 1 fix).
                  • When no PO is bound → keep the original flat grouped-
                    by-section picker (legacy no-PO invoices, spec §22).
                Row classification is driven by siteBillingStatus() —
                zero-value sites render an amber "Commercial Value
                Missing" badge instead of the misleading "Fully Invoiced"
                (Issue 2 fix). */}
            <div style={{ marginTop: 20 }}>
              <div className={css.pickerHdr}>
                <div className={css.pickerLabel}>SELECT SITES FROM REVENUE</div>
                <div className={css.pickerStatus}>{pickerLoad ? 'Loading…' : pickerStatus}</div>
              </div>
              {(() => {
                // A single reusable row renderer keeps Section A / B / C
                // visually identical apart from the trailing action slot.
                function renderSiteRow(
                  r: RevRow,
                  mode: 'selectable' | 'assignable' | 'otherPo',
                  otherPoNumber?: string,
                ) {
                  const isMissing     = missingValueIds.has(r.id);
                  const isFullyBilled = fullyBilledIds.has(r.id);
                  const prev = previouslyInvoicedForRevenue(itemHistory, r.id, invEditId);
                  const remaining = remainingSiteValue(+(r.amount || 0), prev);
                  const disabled = mode !== 'selectable' || isMissing || isFullyBilled;
                  // Wrapper element: <label> only for selectable rows
                  // (needed for checkbox click forwarding). For
                  // 'assignable' and 'otherPo' rows a plain <div> is
                  // used — a <label> around a <button> can synthesise
                  // an extra click on the labelable descendant and, on
                  // some browsers, swallow the intended button click.
                  const RowTag: 'label' | 'div' = mode === 'selectable' ? 'label' : 'div';
                  return (
                    <RowTag key={r.id}
                      className={`${css.pickerRow} ${disabled ? css.pickerRowDisabled : ''}`}
                      style={{ display: 'flex' }}
                    >
                      {mode === 'selectable' ? (
                        <input type="checkbox" disabled={disabled}
                          checked={!disabled && checkedRevs.has(r.id)}
                          onChange={e => {
                            setCheckedRevs(prev2 => {
                              const next = new Set(prev2);
                              if (e.target.checked) next.add(r.id); else next.delete(r.id);
                              return next;
                            });
                          }} />
                      ) : (
                        <span style={{ display: 'inline-block', width: 13 }} />
                      )}
                      <span className={css.pickerSiteId}>{String(r.site_id || '—')}</span>
                      <span className={css.pickerSec}>{r.section_name || ''}</span>
                      <span className={css.pickerStatus2}>{r.status || ''}</span>
                      {isMissing ? (
                        <span
                          className={css.pickerInvoicedBadge}
                          style={{ background: '#fef3c7', color: '#b45309' }}
                          title="Set the Site commercial value in Revenue before invoicing."
                        >Commercial Value Missing</span>
                      ) : isFullyBilled ? (
                        <span className={css.pickerInvoicedBadge}>Fully Invoiced</span>
                      ) : (mode === 'selectable' && prev > 0) ? (
                        <span className={css.pickerInvoicedBadge} style={{ background: '#fef3c7', color: '#b45309' }}>Partial</span>
                      ) : null}
                      {mode === 'otherPo' && otherPoNumber && (
                        <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic', marginLeft: 6 }}>
                          Assigned to {otherPoNumber}
                        </span>
                      )}
                      <span className={css.pickerAmt} title={`Commercial ${iqd(r.amount || 0)} · Remaining ${iqd(remaining)}`}>
                        {isMissing ? '—' : iqd(remaining)}
                      </span>
                      {mode === 'assignable' && (
                        <button
                          type="button"
                          className={css.actBtn}
                          style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: '#4f46e5' }}
                          disabled={assigningRevIds.has(r.id) || isMissing}
                          title={isMissing
                            ? 'Set commercial value in Revenue before assigning.'
                            : `Assign this Site to ${selectedPO?.po_number || 'this PO'}`}
                          onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            tryAssignRevIds([r.id]);
                          }}
                        >
                          {assigningRevIds.has(r.id) ? 'Assigning…' : 'Assign to PO'}
                        </button>
                      )}
                    </RowTag>
                  );
                }

                if (!invForm.project) {
                  return <div className={css.pickerBox}><div className={css.pickerEmpty}>← Select a project above to load sites</div></div>;
                }
                if (pickerLoad) {
                  return <div className={css.pickerBox}><div className={css.pickerEmpty}>Loading sites…</div></div>;
                }
                if (revSites.length === 0) {
                  return <div className={css.pickerBox}><div className={css.pickerEmpty}>No revenue entries found for this project.</div></div>;
                }

                // ── Legacy no-PO flow: original flat picker (unchanged
                // ── grouped-by-section layout, spec §22 backward compat).
                if (!selectedPO) {
                  return (
                    <div className={css.pickerBox}>
                      {Object.entries(revSections).map(([sec, sites]) => {
                        const availSites = sites.filter(r => !fullyBilledIds.has(r.id) && !missingValueIds.has(r.id));
                        const allChecked = availSites.length > 0 && availSites.every(r => checkedRevs.has(r.id));
                        return (
                          <div key={sec} style={{ borderBottom: '1px solid #e2e8f0' }}>
                            <div className={css.pickerSecHdr}>
                              <input type="checkbox" checked={allChecked}
                                onChange={e => toggleSection(sec, e.target.checked)} />
                              {sec}
                            </div>
                            {sites.map(r => renderSiteRow(r, 'selectable'))}
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                // ── PO-bound flow: Section A / B / C.
                const sectionA = revSites.filter(r =>
                  r.po_id === selectedPO.id &&
                  r.project_name === selectedPO.project_name
                );
                const sectionB = revSites.filter(r =>
                  r.po_id == null &&
                  r.project_name === selectedPO.project_name
                );
                const sectionC = revSites.filter(r =>
                  r.po_id != null &&
                  r.po_id !== selectedPO.id &&
                  r.project_name === selectedPO.project_name
                );
                const assignableIds = sectionB
                  .filter(r => !missingValueIds.has(r.id))
                  .map(r => r.id);
                return (
                  <div className={css.pickerBox}>
                    {/* Persistent assignment error banner — stays until
                        dismissed or superseded by a successful assign.
                        Toasts alone were disappearing before users could
                        read the failure reason. */}
                    {assignError && (
                      <div style={{
                        background: '#fef2f2', color: '#991b1b',
                        border: '1px solid #fecaca', borderRadius: 6,
                        padding: '8px 12px', margin: '8px 12px',
                        fontSize: 12, display: 'flex',
                        justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
                      }}>
                        <span><strong>Assign failed:</strong> {assignError}</span>
                        <button type="button" onClick={() => setAssignError(null)}
                          style={{ background: 'transparent', border: 'none', color: '#991b1b', cursor: 'pointer', fontWeight: 700 }}
                          title="Dismiss">×</button>
                      </div>
                    )}
                    {/* Section A */}
                    <div style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <div className={css.pickerSecHdr} style={{ background: '#eef2ff', color: '#1e293b' }}>
                        SITES ASSIGNED TO THIS PO
                        <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b', fontWeight: 500 }}>
                          ({sectionA.length})
                        </span>
                      </div>
                      {sectionA.length === 0
                        ? <div className={css.pickerEmpty} style={{ padding: '10px 12px', fontSize: 12 }}>
                            No Sites are mapped to this PO yet. Use the section below to assign Sites without leaving this modal.
                          </div>
                        : sectionA.map(r => renderSiteRow(r, 'selectable'))
                      }
                    </div>

                    {/* Section B */}
                    <div style={{ borderBottom: '1px solid #e2e8f0' }}>
                      <div className={css.pickerSecHdr} style={{ background: '#f0fdf4', color: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>
                          AVAILABLE PROJECT SITES
                          <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b', fontWeight: 500 }}>
                            ({sectionB.length})
                          </span>
                        </span>
                        {assignableIds.length > 1 && (
                          <button
                            type="button"
                            className={css.actBtn}
                            style={{ fontSize: 11, fontWeight: 700, color: '#4f46e5' }}
                            disabled={assignableIds.some(id => assigningRevIds.has(id))}
                            onClick={() => tryAssignRevIds(assignableIds)}
                            title={`Assign all ${assignableIds.length} available Sites to ${selectedPO.po_number}`}
                          >
                            Assign All ({assignableIds.length}) to PO
                          </button>
                        )}
                      </div>
                      {sectionB.length === 0
                        ? <div className={css.pickerEmpty} style={{ padding: '10px 12px', fontSize: 12 }}>
                            No unassigned Sites remain for this project.
                          </div>
                        : sectionB.map(r => renderSiteRow(r, 'assignable'))
                      }
                    </div>

                    {/* Section C — display only, no interaction */}
                    {sectionC.length > 0 && (
                      <div>
                        <div className={css.pickerSecHdr} style={{ background: '#f8fafc', color: '#64748b' }}>
                          ASSIGNED TO ANOTHER PO
                          <span style={{ marginLeft: 8, fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>
                            ({sectionC.length}) — reassignment happens in Purchase Orders
                          </span>
                        </div>
                        {sectionC.map(r => {
                          const otherPo = purchaseOrders.find(p => p.id === r.po_id);
                          return renderSiteRow(r, 'otherPo', otherPo?.po_number || 'another PO');
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className={css.pickerFooter}>
                <div className={css.pickerCount}>{revenueLineItems.length} site{revenueLineItems.length !== 1 ? 's' : ''} selected</div>
                <div className={css.pickerTotal}>Commercial: <span className={css.pickerTotalAmt}>{iqd(commercialSubtotal)}</span></div>
              </div>
            </div>

            {/* Per-line UX breakdown — Site ID, Section, Commercial Value,
                Previously Invoiced, Remaining Before, Invoice %, This
                Invoice Amount, Remaining After. Only revenue-linked
                selected lines appear here; custom items stay in their
                own "Extra / Custom Items" block. Values are editable
                per-line (amount input takes precedence over milestone
                default). */}
            {revenueLineItems.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div className={css.pickerLabel} style={{ marginBottom: 6 }}>LINE ITEM BREAKDOWN</div>
                <div style={{ overflowX: 'auto' }}>
                  <table className={css.table} style={{ fontSize: 11 }}>
                    <thead><tr>
                      <th>Site ID</th>
                      <th>Section</th>
                      <th>Description</th>
                      <th className={css.num}>Commercial</th>
                      <th className={css.num}>Prev. Invoiced</th>
                      <th className={css.num}>Remaining Before</th>
                      <th className={css.num}>Invoice %</th>
                      <th className={css.num}>This Invoice</th>
                      <th className={css.num}>Remaining After</th>
                    </tr></thead>
                    <tbody>
                      {revenueLineItems.map(li => {
                        const key = li.revenue_id || '';
                        const commercial = li._commercialValue || 0;
                        const prev       = li._previouslyInvoiced || 0;
                        const remBefore  = li._remainingBefore || 0;
                        const amount     = +(li.amount || 0);
                        const pctDisplay = li._invoicePercent || 0;
                        const remAfter   = commercial - prev - amount; // raw — may go negative to flag over-bill
                        const defaultDesc = `Site implementation — ${li.site_id}`;
                        return (
                          <tr key={key}>
                            <td style={{ fontWeight: 600 }}>{String(li.site_id || '—')}</td>
                            <td style={{ color: '#64748b' }}>{li.section_name || '—'}</td>
                            <td>
                              <input type="text"
                                className={css.formInput}
                                style={{ width: 160, fontSize: 11, padding: '3px 6px' }}
                                placeholder={defaultDesc}
                                value={lineDescOverride[key] ?? ''}
                                onChange={e => setLineDescOverride(o => ({ ...o, [key]: e.target.value }))} />
                            </td>
                            <td className={css.num}>{iqd(commercial)}</td>
                            <td className={css.num} style={{ color: '#64748b' }}>{iqd(prev)}</td>
                            <td className={css.num}>{iqd(remBefore)}</td>
                            <td className={css.num}>
                              <input type="number" min={0} max={100} step="0.01"
                                className={css.formInput}
                                style={{ width: 70, textAlign: 'right', fontSize: 11, padding: '3px 6px' }}
                                value={pctDisplay ? pctDisplay.toFixed(2) : ''}
                                onChange={e => {
                                  const pct = +e.target.value || 0;
                                  const derived = Math.min(commercial * pct / 100, remBefore);
                                  setLineAmountOverride(o => ({ ...o, [key]: derived }));
                                }} />
                            </td>
                            <td className={css.num}>
                              <input type="number" min={0} step="1"
                                className={css.formInput}
                                style={{ width: 110, textAlign: 'right', fontSize: 11, padding: '3px 6px' }}
                                value={amount}
                                onChange={e => setLineAmountOverride(o => ({ ...o, [key]: +e.target.value || 0 }))} />
                            </td>
                            <td className={css.num} style={{ color: remAfter < 0 ? '#dc2626' : '#16a34a', fontWeight: 700 }}>
                              {iqd(remAfter)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Custom Items */}
            <div style={{ marginTop: 18 }}>
              <div className={css.customHdr}>
                <div className={css.customLabel}>EXTRA / CUSTOM ITEMS</div>
                {hasPerm('fin_invoices_add_item') && (
                  <button className={css.btnAddItem} onClick={() => { setShowCustForm(true); setCustForm({ site: '', desc: '', amt: '' }); }}>+ Add Item</button>
                )}
              </div>
              {customItems.map(item => (
                <div key={item._customId} className={css.customItem}>
                  <span className={css.customItemId}>{String(item.site_id || 'Custom')}</span>
                  <span className={css.customItemDesc}>{item.description}</span>
                  <span className={css.customItemAmt}>{(+(item.amount || 0)).toLocaleString()} IQD</span>
                  <button className={css.btnRemoveItem} title="Remove"
                    onClick={() => setCustomItems(cs => cs.filter(c => c._customId !== item._customId))}>✕</button>
                </div>
              ))}
              {showCustForm && (
                <div className={css.customForm}>
                  <div className={css.customFormGrid}>
                    <input className={css.formInput} placeholder="Site ID (optional)"
                      value={custForm.site} onChange={e => setCustForm(f => ({ ...f, site: e.target.value }))} />
                    <input className={css.formInput} placeholder="Description *"
                      value={custForm.desc} onChange={e => setCustForm(f => ({ ...f, desc: e.target.value }))} />
                    <input type="number" className={css.formInput} placeholder="Amount (IQD) *"
                      value={custForm.amt} onChange={e => setCustForm(f => ({ ...f, amt: e.target.value }))} />
                  </div>
                  <div className={css.customFormActions}>
                    <button className={css.btnCancel} onClick={() => setShowCustForm(false)}>Cancel</button>
                    <button className={css.btnAdd} onClick={() => {
                      if (!custForm.desc.trim()) { showToast('Description is required', false); return; }
                      if (!+custForm.amt || +custForm.amt <= 0) { showToast('Amount must be greater than 0', false); return; }
                      setCustomItems(cs => [...cs, { site_id: custForm.site.trim() || null, section_name: null, description: custForm.desc.trim(), amount: +custForm.amt, revenue_id: null, _customId: Date.now() + Math.random() }]);
                      setShowCustForm(false);
                    }}>Add</button>
                  </div>
                </div>
              )}
            </div>

            {/* Live invoice totals — subtotal / discount / tax / total.
                Uses helpers so the modal's math and saveInvoice's
                persisted total_amount can never drift. */}
            <div className={css.totalBar} style={{ marginTop: 18 }}>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>
                Subtotal <strong style={{ color: '#1e293b' }}>{iqd(invSubtotal)}</strong>
              </div>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>
                Discount <strong style={{ color: '#dc2626' }}>{iqd(discountNum)}</strong>
              </div>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>
                Tax <strong style={{ color: '#2563eb' }}>{iqd(taxNum)}</strong>
              </div>
              <div className={css.totalBarItem} style={{ color: '#1e293b' }}>
                Invoice Total <strong style={{ color: invTotal < 0 ? '#dc2626' : '#16a34a', fontSize: 15 }}>{iqd(invTotal)}</strong>
              </div>
            </div>

            {invErr && <div className={css.modalErr}>{invErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setInvModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={saveInvoice}>Save Invoice</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Overallocation warning — Site → PO assignment. Wording mirrors
          the sibling flow in src/pages/FinPOs.tsx so users see the same
          copy across pages. Default Cancel; "Assign anyway" is
          destructive and leaves the PO over-allocated. */}
      {overallocConfirm && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setOverallocConfirm(null); }}>
          <div className={css.modal}>
            <div className={css.modalTitle} style={{ color: '#dc2626' }}>Over-allocation Warning</div>
            <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
              Assigning {overallocConfirm.revIds.length === 1 ? 'this site' : `these ${overallocConfirm.revIds.length} sites`} to PO{' '}
              <strong>{overallocConfirm.poNumber}</strong> would push mapped commercial value to{' '}
              <strong>{iqd(overallocConfirm.projected)}</strong>, exceeding the PO amount of{' '}
              <strong>{iqd(overallocConfirm.poAmount)}</strong> by{' '}
              <strong style={{ color: '#dc2626' }}>{iqd(overallocConfirm.projected - overallocConfirm.poAmount)}</strong>.
              <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
                Cancel and adjust the PO amount, or the revenue values, before continuing.
                "Assign anyway" will link the {overallocConfirm.revIds.length === 1 ? 'site' : 'sites'} but leave the PO in an over-allocated state.
              </div>
            </div>
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setOverallocConfirm(null)}>Cancel</button>
              <button className={css.btnDanger} onClick={confirmOverallocAssign}>Assign anyway</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Payment Modal */}
      {payModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setPayModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>Record Payment</div>
            <div className={css.formGrid}>
              <div className={css.formField}>
                <label>Payment Date *</label>
                <input type="date" className={css.formInput} value={payForm.date} onChange={e => setPayForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Amount (IQD) *</label>
                <input type="number" className={css.formInput} min={0} placeholder="0"
                  value={payForm.amount} onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Reference / Cheque #</label>
                <input className={css.formInput} placeholder="Optional…" maxLength={100}
                  value={payForm.reference} onChange={e => setPayForm(f => ({ ...f, reference: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={payForm.notes} onChange={e => setPayForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            {payErr && <div className={css.modalErr}>{payErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setPayModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={savePayment}>Record Payment</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Detail Modal */}
      {detailId && detailInv && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDetailId(null); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.detailHdr}>
              <div className={css.detailNumber}>{detailInv.invoice_number || 'Invoice'}</div>
              <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: STATUS_COLOR[detailInv.status] || '#f1f5f9', color: STATUS_TEXT[detailInv.status] || '#475569' }}>
                {detailInv.status || 'Draft'}
              </span>
            </div>
            <div className={css.detailMeta}>
              <strong>{detailClient?.company_name || '—'}</strong> &nbsp;·&nbsp; {detailInv.project_name || '—'}{detailInv.project_code ? ` (${detailInv.project_code})` : ''} &nbsp;·&nbsp; Issued: {detailInv.issue_date || '—'} &nbsp;·&nbsp; Due: {detailInv.due_date || '—'}
              {(() => {
                const po = detailInv.po_id ? purchaseOrders.find(p => p.id === detailInv.po_id) : undefined;
                const parts: string[] = [];
                if (po) parts.push(`PO: ${po.po_number}`);
                if (detailInv.milestone_label) parts.push(`Milestone: ${detailInv.milestone_label}`);
                if (detailInv.milestone_percent != null) parts.push(`${detailInv.milestone_percent}%`);
                return parts.length > 0
                  ? <div style={{ marginTop: 2, color: '#64748b' }}>{parts.join(' · ')}</div>
                  : null;
              })()}
              {detailInv.notes && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{detailInv.notes}</div>}
            </div>

            <div className={css.detailSectionLbl}>Line Items</div>
            <div className={css.detailBox}>
              {detailLoad
                ? <div className={css.detailEmpty}>Loading…</div>
                : detailItems.length === 0
                  ? <div className={css.detailEmpty}>No line items.</div>
                  : <table className={css.table} style={{ fontSize: 12 }}>
                      <thead><tr><th>Section</th><th>Site ID</th><th>Description</th><th className={css.num}>Amount</th></tr></thead>
                      <tbody>
                        {detailItems.map(item => (
                          <tr key={item.id}>
                            <td style={{ color: '#64748b' }}>{item.section_name || '—'}</td>
                            <td style={{ fontWeight: 600 }}>{String(item.site_id || '—')}</td>
                            <td style={{ color: '#64748b' }}>{item.description || '—'}</td>
                            <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(item.amount || 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
              }
            </div>

            <div className={css.detailSectionLbl}>Payment History</div>
            <div className={css.detailBox}>
              {detailLoad
                ? <div className={css.detailEmpty}>Loading…</div>
                : detailPayments.length === 0
                  ? <div className={css.detailEmpty}>No payments recorded yet.</div>
                  : <table className={css.table} style={{ fontSize: 12 }}>
                      <thead><tr><th>Date</th><th>Amount</th><th>Reference</th><th>Recorded By</th><th>Notes</th>{hasPerm('fin_invoices_record_payment') && <th></th>}</tr></thead>
                      <tbody>
                        {detailPayments.map(p => (
                          <tr key={p.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{p.payment_date || '—'}</td>
                            <td style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(p.amount || 0)}</td>
                            <td style={{ color: '#64748b' }}>{p.reference || '—'}</td>
                            <td style={{ color: '#64748b' }}>{p.recorded_by || '—'}</td>
                            <td style={{ color: '#64748b' }}>{p.notes || '—'}</td>
                            {hasPerm('fin_invoices_record_payment') && (
                              <td>
                                <button onClick={() => deletePayment(p.id, detailId!)} title="Delete payment"
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', fontSize: 14, padding: '2px 6px', lineHeight: 1 }}>
                                  🗑
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
              }
            </div>

            <div className={css.totalBar}>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>Total <strong style={{ color: '#1e293b' }}>{iqd(detailInv.total_amount || 0)}</strong></div>
              <div className={css.totalBarItem} style={{ color: '#16a34a' }}>Received <strong>{iqd(detailInv.amount_received || 0)}</strong></div>
              <div className={css.totalBarItem} style={{ color: '#dc2626' }}>Outstanding <strong>{iqd((+detailInv.total_amount || 0) - (+detailInv.amount_received || 0))}</strong></div>
            </div>

            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setDetailId(null)}>Close</button>
              {hasPerm('fin_invoices_download_pdf') && (
                <button className={css.btnPurple} onClick={() => {
                  const invItems = items.filter(x => x.invoice_id === detailInv.id);
                  const invPays  = payments.filter(x => x.invoice_id === detailInv.id);
                  const po = detailInv.po_id ? purchaseOrders.find(p => p.id === detailInv.po_id) : null;
                  const currency = (po?.currency || 'IQD').toUpperCase();
                  const bank = selectBank(bankAccounts, currency);
                  const model = buildPrintModel(detailInv, detailClient, invItems, invPays, po || null, companySettings, bank, itemHistory, invoicePoMap, revenue);
                  printInvoice(model);
                }}>📄 PDF</button>
              )}
              {hasPerm('fin_invoices_download_pdf') && (
                /* Phase 4.8 — deterministic PDF export (@react-pdf/renderer).
                   Sibling of the existing browser Print button; same model,
                   same permission, different renderer. Disables + swaps its
                   label to "Generating…" while pdfkit runs. */
                <button
                  className={css.btnGreen}
                  disabled={isPdfBusy(detailInv.id)}
                  title="Download PDF (deterministic)"
                  onClick={() => {
                    const invItems = items.filter(x => x.invoice_id === detailInv.id);
                    const invPays  = payments.filter(x => x.invoice_id === detailInv.id);
                    const po = detailInv.po_id ? purchaseOrders.find(p => p.id === detailInv.po_id) : null;
                    const currency = (po?.currency || 'IQD').toUpperCase();
                    const bank = selectBank(bankAccounts, currency);
                    const model = buildPrintModel(detailInv, detailClient, invItems, invPays, po || null, companySettings, bank, itemHistory, invoicePoMap, revenue);
                    void runPdfExport(detailInv.id, model);
                  }}
                >
                  {isPdfBusy(detailInv.id) ? 'Generating…' : 'Download PDF'}
                </button>
              )}
              {hasPerm('fin_invoices_record_payment') && (
                <button className={css.btnSave} onClick={() => { setDetailId(null); openPayModal(detailInv.id); }}>Record Payment</button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body
      )}
    </div>
  );
}
