// src/pdf/InvoicePdfDocument.tsx
//
// React-PDF (@react-pdf/renderer) rendering of the JSR Communications
// invoice, mirroring the Phase 4.4-4.7 premium HTML design in
// src/lib/invoicePrintTemplate.ts.
//
// Design principles (same contract as the HTML template):
//   • Zero business math. Every monetary value is read from the
//     `InvoicePrintModel` populated by `buildPrintModel(...)` in
//     src/pages/FinInvoices.tsx (which uses `invoiceCalc.ts` helpers).
//     This module never re-computes subtotals, remaining amounts,
//     percentages, or anything else — see step 8 grep verification.
//   • Populated-only rendering. Missing PO / bank / notes / payments
//     produce omissions, never blank rows or "—" placeholders (except
//     the two intentional dashes inside line-item cells that carry no
//     commercial context — see `moneyOrDash`).
//   • Deterministic output. React-PDF renders through pdfkit, not
//     browser print, so Chrome / Safari / Edge produce byte-different
//     but layout-identical PDFs. Only built-in fonts are used
//     (Helvetica family + Courier for monospaced account numbers) —
//     no external font registration.
//   • Page pagination. A4 portrait; the whole page is wrappable, and
//     `<View wrap={false}>` guards keep the totals box, cards, bank
//     block, payref strip, and individual table rows atomic. The line-
//     items table header uses `fixed` so it repeats on continued pages.

import {
  Document,
  Page,
  View,
  Text,
  Image,
  Font,
} from '@react-pdf/renderer';
import type { InvoicePrintModel } from '../lib/invoicePrintTemplate';
import { styles, STATUS_BG, STATUS_FG, colors } from './invoicePdfStyles';

// Disable React-PDF's automatic word hyphenation. Without this callback
// the layout engine will syllabify long words (email addresses, URLs,
// company names) when a text block feels tight, producing artefacts
// like "JI-DAR AL SOLB" or "Con-nect-ing". Treating every word as an
// unbreakable single unit forces wrapping only at real whitespace
// boundaries. Applied globally — the fontkit hyphenator is opt-out only.
Font.registerHyphenationCallback((word: string) => [word]);

// ── Format helpers ────────────────────────────────────────────────
// These match src/lib/invoicePrintTemplate.ts `fmtMoney` byte-for-byte
// (integer thousands with en-US grouping + trailing currency). Kept
// local so this file has no runtime deps beyond @react-pdf/renderer.
function fmtMoney(v: number | null | undefined, currency: string): string {
  if (v == null || !Number.isFinite(+v)) return '—';
  const rounded = Math.round(+v);
  return rounded.toLocaleString('en-US') + ' ' + currency;
}

function fmtMoneyOrDash(v: number | null | undefined, currency: string): string {
  if (v == null) return '—';
  return fmtMoney(v, currency);
}

// Clamp helper for progress-bar widths. Same behaviour as the HTML
// template: negative → 0, >100 → 100, non-finite → 0.
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

// ── Sub-components ────────────────────────────────────────────────

function Header({ m }: { m: InvoicePrintModel }) {
  const cs = m.company;
  const statusKey = m.status || 'Draft';
  const brandName = cs?.company_name || 'JSR Communications';
  const brandTag  = cs?.tagline      || 'Connecting the Future';

  // Contact broken into up to THREE separate Text lines so React-PDF has
  // real word-boundary wrap points AND so a very long address can't force
  // its parent block wider than the reserved column. Each line is its
  // own <Text> — never a single joined string.
  //   Line 1: address (address_line1 [— address_line2])
  //   Line 2: city/country · phone
  //   Line 3: email · website
  // Empty lines omitted. Population uses the same fields as the HTML
  // template's contactParts.
  const addrParts: string[] = [];
  if (cs?.address_line1) addrParts.push(cs.address_line1);
  if (cs?.address_line2) addrParts.push(cs.address_line2);
  const addressLine = addrParts.join(' — ');

  const line2Parts: string[] = [];
  const cityCountry = [cs?.city, cs?.country].filter(Boolean).join(', ');
  if (cityCountry) line2Parts.push(cityCountry);
  if (cs?.phone)   line2Parts.push(cs.phone);
  const contactLine2 = line2Parts.join('  ·  ');

  const line3Parts: string[] = [];
  if (cs?.email)   line3Parts.push(cs.email);
  if (cs?.website) line3Parts.push(cs.website);
  const contactLine3 = line3Parts.join('  ·  ');

  return (
    <View style={styles.header} wrap={false}>
      <View style={styles.hdrLeft}>
        {m.logo_url ? (
          <Image src={m.logo_url} style={styles.hdrLogo} />
        ) : null}
        <View style={styles.hdrBrandBlock}>
          <Text style={styles.hdrBrand}>{brandName}</Text>
          <Text style={styles.hdrTag}>{brandTag}</Text>
          {addressLine  ? <Text style={styles.hdrCompany}>{addressLine}</Text>   : null}
          {contactLine2 ? <Text style={styles.hdrCompany2}>{contactLine2}</Text> : null}
          {contactLine3 ? <Text style={styles.hdrCompany3}>{contactLine3}</Text> : null}
        </View>
      </View>
      <View style={styles.hdrDivider} />
      <View style={styles.hdrRight}>
        <Text style={styles.hdrInvTitle}>INVOICE</Text>
        <Text style={styles.hdrInvNum}>{m.invoice_number || ''}</Text>
        <Text
          style={[
            styles.hdrStatus,
            {
              backgroundColor: STATUS_BG[statusKey] || '#f1f5f9',
              color: STATUS_FG[statusKey] || '#475569',
            },
          ]}
        >
          {statusKey}
        </Text>
        <View style={styles.hdrMeta}>
          <View style={styles.hdrMetaRow}>
            <Text style={styles.hdrMetaK}>ISSUE DATE</Text>
            <Text style={styles.hdrMetaV}>{m.issue_date || ''}</Text>
          </View>
          <View style={styles.hdrMetaRow}>
            <Text style={styles.hdrMetaK}>DUE DATE</Text>
            <Text style={styles.hdrMetaV}>{m.due_date || ''}</Text>
          </View>
          <View style={styles.hdrMetaRow}>
            <Text style={styles.hdrMetaK}>CURRENCY</Text>
            <Text style={styles.hdrMetaV}>{m.currency}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function PartiesAndPO({ m }: { m: InvoicePrintModel }) {
  const client = m.client;
  const p = m.po;
  const invoiceType = (m.milestone_label || m.milestone_percent != null)
    ? 'Milestone Invoice'
    : 'Standard Invoice';

  return (
    <View style={styles.parties} wrap={false}>
      <View style={[styles.partyCol, styles.partyColLeft]}>
        <Text style={styles.partyLabel}>BILL TO</Text>
        <View style={styles.partyBody}>
          {client ? (
            <>
              <Text style={styles.partyName}>{client.company_name || ''}</Text>
              {client.contact_person ? <Text style={styles.partyLine}>{client.contact_person}</Text> : null}
              {client.phone          ? <Text style={styles.partyLine}>{client.phone}</Text>          : null}
              {client.email          ? <Text style={styles.partyLine}>{client.email}</Text>          : null}
              {client.address        ? <Text style={styles.partyLine}>{client.address}</Text>        : null}
            </>
          ) : (
            <Text style={[styles.partyLine, { color: colors.muted }]}>—</Text>
          )}
        </View>
      </View>
      <View style={styles.partyCol}>
        <Text style={styles.partyLabel}>INVOICE / PO DETAILS</Text>
        <View>
          <View style={styles.pdRow}>
            <Text style={styles.pdK}>Project</Text>
            <Text style={styles.pdV}>{m.project_name || ''}</Text>
          </View>
          {m.project_code ? (
            <View style={styles.pdRow}>
              <Text style={styles.pdK}>Project Code</Text>
              <Text style={styles.pdV}>{m.project_code}</Text>
            </View>
          ) : null}
          {p ? (
            <>
              <View style={styles.pdRow}>
                <Text style={styles.pdK}>PO Number</Text>
                <Text style={styles.pdV}>{p.po_number || ''}</Text>
              </View>
              <View style={styles.pdRow}>
                <Text style={styles.pdK}>PO Date</Text>
                <Text style={styles.pdV}>{p.po_date || ''}</Text>
              </View>
              <View style={styles.pdRow}>
                <Text style={styles.pdK}>PO Value</Text>
                <Text style={styles.pdV}>{fmtMoneyOrDash(p.po_amount, p.currency || m.currency)}</Text>
              </View>
            </>
          ) : null}
          <View style={styles.pdRow}>
            <Text style={styles.pdK}>Invoice Type</Text>
            <Text style={styles.pdV}>{invoiceType}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

function BillingStage({ m }: { m: InvoicePrintModel }) {
  if (m.milestone_percent == null && !m.milestone_label) return null;
  const parts: string[] = [];
  if (m.milestone_label)         parts.push(m.milestone_label);
  if (m.milestone_percent != null) parts.push(String(m.milestone_percent) + '%');
  return (
    <View style={styles.stageStrip} wrap={false}>
      <Text style={styles.stageLbl}>BILLING STAGE:</Text>
      <Text style={styles.stageVal}>{parts.join(' — ')}</Text>
    </View>
  );
}

function LineItems({ m }: { m: InvoicePrintModel }) {
  const currency = m.currency;
  // React-PDF has no <table> primitive: we build a stack of Views with
  // fixed flex-basis widths (percent) matching the HTML colgroup. The
  // header <View fixed> repeats on continued pages (React-PDF feature).
  // Individual rows use wrap={false} so a description cell that spans
  // multiple visual lines isn't split mid-row across a page boundary.
  return (
    <View style={styles.itemsTable}>
      {/* Header uses <View>+<Text> per cell (not bare <Text>) so single-
          and two-line labels can vertically-center against the SAME
          shared cell height. Bare Text has no justifyContent, so mixed
          1/2-line labels produce misaligned baselines. */}
      <View style={styles.itemsHead} fixed>
        <View style={[styles.thCell, styles.colSection]}>
          <Text style={[styles.thText, styles.thAlignLeft]}>SECTION</Text>
        </View>
        <View style={[styles.thCell, styles.colSite]}>
          <Text style={[styles.thText, styles.thAlignCenter]}>SITE ID</Text>
        </View>
        <View style={[styles.thCell, styles.colDesc]}>
          <Text style={[styles.thText, styles.thAlignLeft]}>DESCRIPTION</Text>
        </View>
        <View style={[styles.thCell, styles.colCommercial]}>
          <Text style={[styles.thText, styles.thAlignCenter]}>{'COMMERCIAL\nVALUE'}</Text>
        </View>
        <View style={[styles.thCell, styles.colPrev]}>
          <Text style={[styles.thText, styles.thAlignCenter]}>{'PREVIOUSLY\nINVOICED'}</Text>
        </View>
        <View style={[styles.thCell, styles.colThis]}>
          <Text style={[styles.thText, styles.thAlignCenter]}>{'THIS\nINVOICE'}</Text>
        </View>
        <View style={[styles.thCell, styles.colRemain]}>
          <Text style={[styles.thText, styles.thAlignCenter]}>{'REMAINING\nAFTER'}</Text>
        </View>
      </View>
      {m.items.length === 0 ? (
        <View style={styles.itemsRow} wrap={false}>
          <Text style={styles.emptyRow}>No line items on this invoice.</Text>
        </View>
      ) : (
        m.items.map((it, i) => (
          <View
            key={i}
            style={[styles.itemsRow, i % 2 === 0 ? styles.rowEven : styles.rowOdd]}
            wrap={false}
          >
            <Text style={[styles.td, styles.colSection]}>{it.section_name || ''}</Text>
            <Text style={[styles.td, styles.tdMono, styles.colSite]}>{it.site_id || ''}</Text>
            <Text style={[styles.td, styles.tdDesc, styles.colDesc]}>{it.description || ''}</Text>
            <Text style={[styles.td, styles.tdNum, styles.colCommercial]}>{fmtMoneyOrDash(it.site_commercial, currency)}</Text>
            <Text style={[styles.td, styles.tdNum, styles.tdDim, styles.colPrev]}>{fmtMoneyOrDash(it.previously_invoiced, currency)}</Text>
            <Text style={[styles.td, styles.tdNum, styles.tdBold, styles.colThis]}>{fmtMoney(it.this_invoice, currency)}</Text>
            <Text style={[styles.td, styles.tdNum, styles.colRemain]}>{fmtMoneyOrDash(it.remaining_after, currency)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function InvoiceTotal({ m }: { m: InvoicePrintModel }) {
  const c = m.currency;
  // Discount + Tax rows are hidden together when BOTH are 0 — mirrors
  // the HTML template's `hasAdj` guard. Shows both if either is non-zero.
  const hasAdj = (+m.discount || 0) !== 0 || (+m.tax || 0) !== 0;
  return (
    <View style={styles.totalsWrap}>
      <View style={styles.totalsBox} wrap={false}>
        <View style={styles.totalsRow}>
          <Text style={styles.totalsK}>Commercial Subtotal</Text>
          <Text style={styles.totalsV}>{fmtMoney(m.subtotal, c)}</Text>
        </View>
        {hasAdj ? (
          <>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsK}>Discount</Text>
              <Text style={[styles.totalsV, styles.totalsNeg]}>{fmtMoney(m.discount, c)}</Text>
            </View>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsK}>Tax</Text>
              <Text style={[styles.totalsV, styles.totalsPos]}>{fmtMoney(m.tax, c)}</Text>
            </View>
          </>
        ) : null}
        <View style={styles.totalsGrand}>
          <Text style={styles.totalsGrandK}>INVOICE TOTAL</Text>
          <Text style={styles.totalsGrandV}>{fmtMoney(m.total, c)}</Text>
        </View>
      </View>
    </View>
  );
}

function ProgressAndPayment({ m }: { m: InvoicePrintModel }) {
  const c = m.currency;
  const hasPO = !!m.po;

  // LEFT: billing progress — only when PO present. Bar fill is clamped
  // 0-100 for display; the DB values themselves are never clamped.
  const leftCard = m.po ? (() => {
    const poValue = +(m.po.po_amount || 0);
    const rawPct  = poValue > 0 ? (m.po_total_billed_to_date / poValue) * 100 : 0;
    const pct     = clampPct(rawPct);
    return (
      <View style={hasPO ? [styles.card, styles.cardBothLeft] : styles.card} wrap={false}>
        <Text style={styles.cardTitle}>PO / BILLING PROGRESS</Text>
        <View style={styles.cardRow}>
          <Text style={styles.cardK}>PO Value</Text>
          <Text style={styles.cardV}>{fmtMoney(poValue, c)}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.cardK}>Previously Billed</Text>
          <Text style={styles.cardV}>{fmtMoney(m.po_previously_billed, c)}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.cardK}>This Invoice</Text>
          <Text style={styles.cardV}>{fmtMoney(m.po_this_invoice_commercial, c)}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.cardK}>Total Billed</Text>
          <Text style={styles.cardV}>{fmtMoney(m.po_total_billed_to_date, c)}</Text>
        </View>
        <View style={styles.cardRow}>
          <Text style={styles.cardK}>Remaining to Invoice</Text>
          <Text style={styles.cardV}>{fmtMoney(m.po_remaining_to_invoice, c)}</Text>
        </View>
        <View style={[styles.barWrap, styles.barWrapBilling]}>
          <View style={[styles.barFillNavy, { width: `${pct.toFixed(2)}%` }]} />
        </View>
        <Text style={styles.barCaption}>{pct.toFixed(1)}% of PO value billed</Text>
      </View>
    );
  })() : null;

  const rawPay      = m.total > 0 ? (m.received_to_date / m.total) * 100 : 0;
  const payPct      = clampPct(rawPay);
  const outPct      = clampPct(100 - payPct);
  const payPctLabel = m.total > 0 ? payPct.toFixed(1) + '%' : '—';

  const rightCard = (
    <View style={styles.card} wrap={false}>
      <Text style={styles.cardTitle}>PAYMENT STATUS</Text>
      <View style={styles.cardRow}>
        <Text style={styles.cardK}>Invoice Total</Text>
        <Text style={styles.cardV}>{fmtMoney(m.total, c)}</Text>
      </View>
      <View style={styles.cardRow}>
        <Text style={styles.cardK}>Received</Text>
        <Text style={[styles.cardV, styles.cardVPos]}>{fmtMoney(m.received_to_date, c)}</Text>
      </View>
      <View style={styles.cardRow}>
        <Text style={styles.cardK}>Outstanding</Text>
        <Text style={[styles.cardV, m.outstanding > 0 ? styles.cardVNeg : styles.cardVPos]}>
          {fmtMoney(m.outstanding, c)}
        </Text>
      </View>
      <View style={styles.cardRow}>
        <Text style={styles.cardK}>Payment %</Text>
        <Text style={styles.cardV}>{payPctLabel}</Text>
      </View>
      <View style={[styles.barWrap, styles.barWrapPayment]}>
        <View style={[styles.barFillGreen, { width: `${payPct.toFixed(2)}%` }]} />
      </View>
      <Text style={styles.barCaption}>{payPct.toFixed(1)}% received  •  {outPct.toFixed(1)}% outstanding</Text>
    </View>
  );

  return (
    <View style={styles.cardsRow}>
      {leftCard}
      {rightCard}
    </View>
  );
}

function PaymentHistory({ m }: { m: InvoicePrintModel }) {
  const c = m.currency;
  return (
    <View style={styles.sectionBlock}>
      <Text style={styles.sectionTitle}>PAYMENT HISTORY</Text>
      {m.payments.length === 0 ? (
        <Text style={styles.histEmpty}>No payments recorded.</Text>
      ) : (
        <View>
          <View style={styles.histHead} fixed>
            <Text style={[styles.histTh, styles.histColDate]}>DATE</Text>
            <Text style={[styles.histTh, styles.histColAmt, styles.tdNum]}>AMOUNT</Text>
            <Text style={[styles.histTh, styles.histColMeth]}>METHOD</Text>
            <Text style={[styles.histTh, styles.histColRef]}>REFERENCE</Text>
            <Text style={[styles.histTh, styles.histColUser]}>RECORDED BY</Text>
          </View>
          {m.payments.map((p, i) => (
            <View key={i} style={styles.histRow} wrap={false}>
              <Text style={[styles.histTd, styles.histColDate]}>{p.payment_date || ''}</Text>
              <Text style={[styles.histTd, styles.histColAmt, styles.tdNum, styles.tdBold, { color: colors.green }]}>
                {fmtMoney(p.amount, c)}
              </Text>
              <Text style={[styles.histTd, styles.histColMeth]}>{p.method || ''}</Text>
              <Text style={[styles.histTd, styles.histColRef, styles.tdDim]}>{p.reference || ''}</Text>
              <Text style={[styles.histTd, styles.histColUser, styles.tdDim]}>{p.recorded_by || ''}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function BankDetails({ m }: { m: InvoicePrintModel }) {
  const b = m.bank;
  if (!b) return null;
  const cells: React.ReactNode[] = [];
  if (b.bank_name)      cells.push(<Cell key="bn" k="Bank Name"      v={b.bank_name} />);
  if (b.account_name)   cells.push(<Cell key="an" k="Account Name"   v={b.account_name} />);
  if (b.account_number) cells.push(<Cell key="ao" k="Account Number" v={b.account_number} mono />);
  if (b.iban)           cells.push(<Cell key="ib" k="IBAN"           v={b.iban}           mono />);
  if (b.swift)          cells.push(<Cell key="sw" k="SWIFT"          v={b.swift}          mono />);
  if (b.currency)       cells.push(<Cell key="cu" k="Currency"       v={b.currency} />);

  return (
    <View style={styles.sectionBlock} wrap={false}>
      <Text style={styles.sectionTitle}>BANK DETAILS</Text>
      <View style={styles.bankGrid}>{cells}</View>
      <View style={styles.payrefStrip} wrap={false}>
        <View style={styles.payrefLine}>
          <Text style={styles.payrefLbl}>PAYMENT REFERENCE:</Text>
          <Text style={styles.payrefVal}>{m.bank_payment_reference || ''}</Text>
        </View>
        <Text style={styles.payrefNote}>Please include the Invoice Number in the payment reference.</Text>
      </View>
    </View>
  );
}

function Cell({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.bankCell}>
      <Text style={styles.bankK}>{k.toUpperCase()}</Text>
      <Text style={mono ? styles.bankVMono : styles.bankV}>{v}</Text>
    </View>
  );
}

function Notes({ m }: { m: InvoicePrintModel }) {
  if (!m.notes) return null;
  return (
    <View style={styles.notesLine}>
      <Text>
        <Text style={styles.notesStrong}>Notes: </Text>
        {m.notes}
      </Text>
    </View>
  );
}

// Phase 5D — Authorized Signature (left) + Company Stamp (right).
// Compact two-column authorization row placed between Notes and Footer.
// No fabricated signatory name / title / seal — no data source exists
// in InvoicePrintModel or company_settings today (schema not modified
// in this phase). Uses whitespace and thin lines rather than boxes,
// per the approved premium invoice style. wrap={false} keeps the row
// atomic so the signature line never splits across pages; on genuine
// multi-page invoices the block renders once, after final content,
// immediately before the footer (natural flow, no fixed positioning).
function Authorization(_props: { m: InvoicePrintModel }) {
  return (
    <View style={styles.authRow} wrap={false}>
      <View style={styles.authLeft}>
        <Text style={styles.authLabel}>AUTHORIZED SIGNATURE</Text>
        <View style={styles.authSpace} />
        <View style={styles.authLine} />
        <Text style={styles.authRole}>Authorized Signatory</Text>
      </View>
      <View style={styles.authRight}>
        <Text style={styles.authLabelRight}>COMPANY STAMP</Text>
        <View style={styles.authSpace} />
      </View>
    </View>
  );
}

function Footer({ m }: { m: InvoicePrintModel }) {
  const cs = m.company;
  const bits: string[] = ['Generated by JSR Network Tracker'];
  if (cs?.website) bits.push(cs.website);
  if (cs?.email)   bits.push(cs.email);
  return <Text style={styles.footer}>{bits.join('  •  ')}</Text>;
}

// ── Root document ─────────────────────────────────────────────────

export interface InvoicePdfDocumentProps {
  model: InvoicePrintModel;
}

export function InvoicePdfDocument({ model }: InvoicePdfDocumentProps) {
  return (
    <Document
      title={model.invoice_number || 'Invoice'}
      author={model.company?.company_name || 'JSR Communications'}
      creator="JSR Network Tracker"
      producer="JSR Network Tracker (React-PDF)"
    >
      <Page size="A4" style={styles.page} wrap>
        <Header m={model} />
        <PartiesAndPO m={model} />
        <BillingStage m={model} />
        <LineItems m={model} />
        <InvoiceTotal m={model} />
        <ProgressAndPayment m={model} />
        <PaymentHistory m={model} />
        <BankDetails m={model} />
        <Notes m={model} />
        <Authorization m={model} />
        <Footer m={model} />
      </Page>
    </Document>
  );
}
