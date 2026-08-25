// src/pdf/invoicePdfStyles.ts
//
// React-PDF stylesheet mirroring the Phase 4.4-4.7 premium HTML design
// tokens from src/lib/invoicePrintTemplate.ts. Kept as a separate module
// for readability; every colour / spacing decision here has a direct
// parallel in that HTML template so the two renderers stay visually
// aligned even though React-PDF uses a Yoga-based layout engine (not
// CSS) under the hood.
//
// Design tokens (kept in sync with the HTML template's :root vars):
//   navy       #0f172a  primary navy: headings, INVOICE TOTAL bg
//   navy2      #1e293b  body text, hist header bg
//   gold       #c9a961  accent: INVOICE label, stripes, dividers, footer
//   goldPale   #fdf9ee  billing stage bg, payment reference bg
//   border     #e2e8f0  subtle borders
//   muted      #64748b  secondary text
//   muted2     #94a3b8  labels above values
//   zebra      #f8fafc  alt rows
//   green      #16a34a  received / payment progress
//   red        #dc2626  outstanding only
//   barTrackGrey #e5e7eb billing progress track
//   barTrackRed  #fee2e2 payment progress track
//
// React-PDF has no CSS cascade, no media queries and no percentages
// outside width. All values are absolute (pt) unless expressing a bar
// fill ratio via width: `${pct}%` on the fill child <View>.

import { StyleSheet } from '@react-pdf/renderer';

export const colors = {
  navy: '#0f172a',
  navy2: '#1e293b',
  gold: '#c9a961',
  goldPale: '#fdf9ee',
  border: '#e2e8f0',
  muted: '#64748b',
  muted2: '#94a3b8',
  zebra: '#f8fafc',
  white: '#ffffff',
  green: '#16a34a',
  red: '#dc2626',
  barTrackGrey: '#e5e7eb',
  barTrackRed: '#fee2e2',
} as const;

// Status → colour tokens for the badge. Mirrors STATUS_BG / STATUS_FG in
// the HTML template so the pill looks identical on both surfaces.
export const STATUS_BG: Record<string, string> = {
  Draft: '#f1f5f9', Sent: '#dbeafe', Partial: '#fef3c7', Paid: '#dcfce7', Overdue: '#fee2e2',
};
export const STATUS_FG: Record<string, string> = {
  Draft: '#475569', Sent: '#1d4ed8', Partial: '#b45309', Paid: '#16a34a', Overdue: '#dc2626',
};

export const styles = StyleSheet.create({
  // A4 portrait; margins mirror the HTML template's @page rule
  // (10mm top / 12mm side / 8mm bottom → converted to pt at 1mm ≈ 2.834pt).
  page: {
    paddingTop: 28,
    paddingBottom: 22,
    paddingLeft: 34,
    paddingRight: 34,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: colors.navy2,
    lineHeight: 1.4,
  },

  // ── Header ──────────────────────────────────────────────────
  // Deterministic 3-child row with ABSOLUTE pt widths — no flex-grow, no
  // flex-shrink on any header child. Prior attempts using `flex: 1` +
  // `minWidth: 0` triggered React-PDF / Yoga to collapse the brand block
  // to an ultra-narrow column and wrap the company name character-by-
  // character. With explicit widths, layout is deterministic:
  //   page usable width ≈ 527pt (A4 595.28 − 34*2)
  //   hdrLeft       340pt
  //   hdrDivider    22pt (2pt line + 10pt on each side via marginHorizontal)
  //   hdrRight      160pt
  //   ------------------
  //   total         522pt (5pt spare inside usable width)
  header: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: 2,
    borderBottomColor: colors.navy,
    // Phase 5D micro-polish: tightened the gap between the header
    // content and the navy divider below (10+8 = 18pt total → 6+7 =
    // 13pt total, ~5pt reclaim) for a more premium feel without
    // crowding. Nothing else in the header changed.
    paddingBottom: 6,
    marginBottom: 7,
  },
  hdrLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: 340,
    flexShrink: 0,
    flexGrow: 0,
  },
  hdrLogo: {
    // Phase 5C micro-polish: logo bumped 90→100pt width, 46→51pt height
    // (~11% both dimensions) for more intentional presence next to the
    // company name block. objectFit:'contain' preserves aspect ratio —
    // never stretched. Height stays well within the brand-block's own
    // multi-line height so it does not lengthen the header row.
    width: 100,
    height: 51,
    objectFit: 'contain',
    marginRight: 10,
    flexShrink: 0,
  },
  // Company text block gets the EXACT remaining left-area width:
  // 340 − 100 (logo) − 10 (marginRight) = 230pt. Explicit width means
  // React-PDF wraps Text children at word boundaries instead of shrinking
  // the block to an intrinsic-content minimum.
  hdrBrandBlock: {
    flexDirection: 'column',
    width: 230,
    flexShrink: 0,
    flexGrow: 0,
  },
  hdrBrand: {
    fontSize: 15,
    fontFamily: 'Helvetica-Bold',
    color: colors.navy,
    // Explicit lineHeight is critical: without it, React-PDF renders
    // bold 15pt Text with a lineHeight that visually looks almost
    // overlapped when the company name wraps to two lines (e.g.
    // "JIDAR AL SOLB ALRASIKH / COMPANY"). 1.2 gives clean separation
    // while still reading as one company name.
    lineHeight: 1.2,
  },
  hdrTag: {
    fontSize: 9,
    fontFamily: 'Helvetica-Oblique',
    color: colors.gold,
    // marginTop 1 → 4: a wrapped 2-line company name needs a visible
    // gap before the tagline, otherwise the tagline appears to touch
    // the second line of the name.
    marginTop: 4,
    lineHeight: 1.3,
  },
  hdrCompany: {
    fontSize: 8,
    color: colors.muted,
    // marginTop 4 → 6: slightly larger, controlled gap after tagline
    // before the address block starts.
    marginTop: 6,
    lineHeight: 1.35,
  },
  hdrCompany2: {
    fontSize: 8,
    color: colors.muted,
    marginTop: 1,
    lineHeight: 1.35,
  },
  hdrCompany3: {
    fontSize: 8,
    color: colors.muted,
    marginTop: 1,
    lineHeight: 1.35,
  },
  hdrDivider: {
    // Phase 5C micro-polish: was `alignSelf: 'stretch'` (100% of header
    // row height) → now stretched + inset with `marginVertical: 9pt`
    // top and bottom. On a typical header content height ~80pt, this
    // gives the divider ~62pt visible height ≈ 78% — a premium accent
    // rather than a structural wall. Vertical centering is automatic
    // because the top and bottom margins are equal. Colour, width, and
    // horizontal position unchanged.
    width: 2,
    backgroundColor: colors.gold,
    marginHorizontal: 10,
    marginVertical: 9,
    flexShrink: 0,
    flexGrow: 0,
    alignSelf: 'stretch',
  },
  hdrRight: {
    flexDirection: 'column',
    alignItems: 'flex-end',
    width: 160,
    flexShrink: 0,
    flexGrow: 0,
  },
  hdrInvTitle: {
    // Phase 5E: tracking reduced 2 → 1.2 to match the Safari reference —
    // 2pt looks artificially stretched in the deterministic renderer's
    // Helvetica. Same visual intent, less mechanical feel.
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
    color: colors.gold,
    letterSpacing: 1.2,
  },
  hdrInvNum: {
    fontSize: 14,
    fontFamily: 'Helvetica-Bold',
    color: colors.navy,
    marginTop: 3,
  },
  hdrStatus: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    fontSize: 8,
    fontFamily: 'Helvetica-Bold',
  },
  hdrMeta: {
    marginTop: 8,
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  hdrMetaRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'baseline',
    paddingVertical: 1,
  },
  hdrMetaK: {
    color: colors.muted2,
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.4,
    marginRight: 8,
  },
  hdrMetaV: {
    color: colors.navy,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    minWidth: 70,
  },

  // ── Parties + PO ────────────────────────────────────────────
  parties: {
    flexDirection: 'row',
    marginBottom: 10,
  },
  partyCol: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  partyColLeft: { marginRight: 18 },
  partyLabel: {
    // Phase 5E: BILL TO / INVOICE / PO DETAILS — 1.2 → 0.8.
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.muted,
    letterSpacing: 0.8,
    borderBottomWidth: 1,
    borderBottomColor: colors.navy,
    paddingBottom: 3,
    marginBottom: 5,
  },
  partyBody: {
    fontSize: 9,
    color: colors.navy2,
    lineHeight: 1.5,
  },
  partyLine: { paddingVertical: 1 },
  partyName: {
    fontFamily: 'Helvetica-Bold',
    color: colors.navy,
    fontSize: 10.5,
    paddingVertical: 1,
  },
  pdRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 1,
  },
  pdK: { color: colors.muted, fontSize: 9 },
  pdV: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
    textAlign: 'right',
  },

  // ── Billing stage ───────────────────────────────────────────
  stageStrip: {
    backgroundColor: colors.goldPale,
    borderLeftWidth: 4,
    borderLeftColor: colors.gold,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 2,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  stageLbl: {
    color: colors.gold,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8.5,
    letterSpacing: 1,
    marginRight: 6,
  },
  stageVal: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
  },

  // ── Items table ─────────────────────────────────────────────
  // Phase 5C micro-polish: was 4pt → 2pt. Combined with the totalsWrap
  // marginTop trim below, total gap between line-items table and totals
  // box drops from 8pt to 4pt — a subtle tightening that keeps the two
  // sections reading as one financial group without letting them touch.
  itemsTable: { marginBottom: 2 },
  itemsHead: {
    flexDirection: 'row',
    backgroundColor: colors.navy,
    // Header row uses View-per-cell (not bare Text) so single-line and
    // two-line labels can be vertically centered against the SAME cell
    // height. Without alignItems: 'stretch' the cells shrink to fit
    // their intrinsic text height and the two-line labels sit taller
    // than the single-line ones — producing the misaligned baselines
    // reported in Phase 5F. Stretch + minHeight on the row + per-cell
    // justifyContent:'center' guarantees uniform header height.
    alignItems: 'stretch',
    minHeight: 26,
  },
  // Header cell wrapper. Each column gets a <View> with padding and
  // justifyContent:'center' so its <Text> child is vertically centered
  // within the shared minHeight. Horizontal alignment is applied via
  // the child Text's textAlign so it doesn't interact with justify.
  thCell: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    justifyContent: 'center',
  },
  thText: {
    color: colors.white,
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.25,
    lineHeight: 1.15,
  },
  thAlignLeft:   { textAlign: 'left' },
  thAlignCenter: { textAlign: 'center' },
  itemsRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    // alignItems: 'center' vertically centers every cell against the
    // tallest cell in the row (usually the wrapping description). Without
    // it, single-line numeric cells align to the top while the
    // description takes 2+ lines, breaking the visual baseline.
    alignItems: 'center',
  },
  rowEven: { backgroundColor: colors.white },
  rowOdd: { backgroundColor: colors.zebra },
  td: {
    fontSize: 8.5,
    color: colors.navy2,
    padding: 4,
    lineHeight: 1.3,
  },
  tdNum: { textAlign: 'right' },
  tdDim: { color: colors.muted },
  tdBold: { fontFamily: 'Helvetica-Bold' },
  tdMono: {
    fontFamily: 'Courier-Bold',
    color: colors.navy2,
    textAlign: 'center',
  },
  tdDesc: { color: colors.muted },
  emptyRow: {
    padding: 10,
    textAlign: 'center',
    color: colors.muted2,
    fontSize: 9,
  },

  // Column widths (matching the HTML colgroup: 9/8/23/15/16/14/15%).
  colSection:     { width: '9%' },
  colSite:        { width: '8%' },
  colDesc:        { width: '23%' },
  colCommercial:  { width: '15%' },
  colPrev:        { width: '16%' },
  colThis:        { width: '14%' },
  colRemain:      { width: '15%' },

  // ── Totals ──────────────────────────────────────────────────
  // Phase 5D micro-polish: totals box widened (was 185-220pt, now
  // 240-280pt) so it visually anchors to the four right-hand numeric
  // columns of the line-items table (COMMERCIAL VALUE + PREVIOUSLY +
  // THIS + REMAINING = ~316pt combined). Previously the box floated
  // far right with too much blank space to its left; now it reads as
  // a natural extension of the numeric grid. Still right-aligned via
  // justifyContent: 'flex-end'. Attach-gap tightened marginTop 6→4.
  totalsWrap: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    // Phase 5C micro-polish: 4 → 2. Paired with itemsTable.marginBottom
    // trim above. Total gap items → totals: 8pt → 4pt (spec target
    // 4-6pt reduction).
    marginTop: 2,
  },
  totalsBox: {
    minWidth: 240,
    maxWidth: 280,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: colors.white,
  },
  totalsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  totalsK: { color: colors.muted, fontSize: 8.5 },
  totalsV: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
  },
  totalsPos: { color: colors.green },
  totalsNeg: { color: colors.red },
  totalsGrand: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: colors.navy,
  },
  totalsGrandK: {
    color: colors.white,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  totalsGrandV: {
    color: colors.white,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
  },

  // ── Progress + Payment cards ─────────────────────────────────
  cardsRow: { flexDirection: 'row', marginTop: 10 },
  cardBothLeft: { marginRight: 10 },
  card: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 3,
    padding: 10,
    backgroundColor: colors.white,
  },
  cardTitle: {
    // Phase 5E: PO / BILLING PROGRESS + PAYMENT STATUS — 1.2 → 0.8.
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.navy,
    letterSpacing: 0.8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 5,
    marginBottom: 6,
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingVertical: 1.5,
  },
  cardK: { color: colors.muted, fontSize: 8.5 },
  cardV: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
    fontSize: 9.5,
  },
  cardVPos: { color: colors.green },
  cardVNeg: { color: colors.red },
  barWrap: {
    height: 5,
    borderRadius: 3,
    marginTop: 8,
    overflow: 'hidden',
  },
  barWrapBilling: { backgroundColor: colors.barTrackGrey },
  barWrapPayment: { backgroundColor: colors.barTrackRed },
  barFillNavy: { height: 5, backgroundColor: colors.navy },
  barFillGreen: { height: 5, backgroundColor: colors.green },
  barCaption: {
    fontSize: 7.5,
    color: colors.muted,
    marginTop: 3,
  },

  // ── Payment history ─────────────────────────────────────────
  // Phase 5D micro-trim: 10 → 8. Recovers ~4pt across Payment History
  // + Bank Details to help absorb the new Authorization section's
  // vertical cost while keeping the invoice on one A4 page.
  sectionBlock: { marginTop: 8 },
  sectionTitle: {
    // Phase 5E: PAYMENT HISTORY + BANK DETAILS — 1.2 → 0.8.
    // Phase 5D.1: marginBottom 5 → 3 (applied twice = 4pt reclaimed for
    // one-page fit after Authorization).
    fontSize: 8.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.muted,
    letterSpacing: 0.8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingBottom: 3,
    marginBottom: 3,
  },
  histEmpty: {
    // Phase 5D.1: paddingVertical 2 → 1 (saves 2pt; the empty state is
    // just one italic line, doesn't need much breathing room).
    fontSize: 9,
    color: colors.muted,
    fontFamily: 'Helvetica-Oblique',
    paddingVertical: 1,
  },
  histHead: {
    flexDirection: 'row',
    backgroundColor: colors.navy2,
  },
  histTh: {
    color: colors.white,
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    padding: 4,
    letterSpacing: 0.5,
  },
  histRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  histTd: {
    fontSize: 8,
    color: colors.navy2,
    padding: 4,
  },

  // Payment history column widths (16/22/18/24/20%).
  histColDate:  { width: '16%' },
  histColAmt:   { width: '22%' },
  histColMeth:  { width: '18%' },
  histColRef:   { width: '24%' },
  histColUser:  { width: '20%' },

  // ── Bank details ────────────────────────────────────────────
  bankGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  bankCell: {
    width: '33.33%',
    paddingVertical: 2,
    paddingRight: 10,
  },
  bankK: {
    color: colors.muted,
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    letterSpacing: 0.3,
  },
  bankV: {
    color: colors.navy,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginTop: 1,
  },
  bankVMono: {
    color: colors.navy,
    fontSize: 9,
    fontFamily: 'Courier-Bold',
    marginTop: 1,
  },
  payrefStrip: {
    // Phase 5D.1: paddingVertical 6→4 (saves 4pt), marginTop 8→6
    // (saves 2pt). Gold accent, colours, radius, horizontal padding
    // unchanged — only vertical breath is tightened.
    backgroundColor: colors.goldPale,
    borderLeftWidth: 4,
    borderLeftColor: colors.gold,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 2,
    marginTop: 6,
  },
  payrefLine: { flexDirection: 'row', alignItems: 'baseline' },
  payrefLbl: {
    // Phase 5E: PAYMENT REFERENCE — 1 → 0.6.
    color: colors.gold,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    letterSpacing: 0.6,
    marginRight: 6,
  },
  payrefVal: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
    fontSize: 10.5,
  },
  payrefNote: {
    color: colors.muted2,
    fontFamily: 'Helvetica-Oblique',
    fontSize: 7.5,
    marginTop: 2,
  },

  // ── Notes + Footer ──────────────────────────────────────────
  notesLine: {
    fontSize: 8.5,
    color: colors.muted,
    marginTop: 8,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
  },
  notesStrong: {
    color: colors.navy,
    fontFamily: 'Helvetica-Bold',
  },
  footer: {
    // Phase 5D.1: marginTop 8→6 (saves 2pt).
    marginTop: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: colors.gold,
    fontSize: 7.5,
    color: colors.muted,
    textAlign: 'center',
  },

  // ── Phase 5D: Authorization (Signature + Company Stamp) ─────
  // Compact two-column row rendered between Notes and Footer. No boxes,
  // no borders — just whitespace, a small uppercase label, a reserved
  // signing/stamp area, a thin signature line on the left, and a role
  // label. Design tokens only (navy / gold / muted / white). No
  // fabricated names or seals. Target total block height ~40pt.
  authRow: {
    // Phase 5D.1: marginTop 10→8 (saves 2pt).
    flexDirection: 'row',
    marginTop: 8,
  },
  authLeft:  { width: '58%', paddingRight: 12 },
  authRight: { width: '42%', paddingLeft: 12 },
  authLabel: {
    // Phase 5D.1: marginBottom 3→2 (saves 1pt).
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.gold,
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  authLabelRight: {
    fontSize: 7.5,
    fontFamily: 'Helvetica-Bold',
    color: colors.gold,
    letterSpacing: 0.6,
    marginBottom: 2,
    textAlign: 'center',
  },
  // Phase 5D.1: reserved signing/stamp height 18 → 12pt. Still ample
  // for an inked signature or a small overlaid company stamp.
  authSpace: { height: 12 },
  authLine: {
    // Phase 5D.1: width 85% → 58% (spec § "shorten signature line to
    // ~55–60% of the left column"); marginBottom 2 → 1 (saves 1pt).
    borderBottomWidth: 0.75,
    borderBottomColor: colors.muted2,
    marginBottom: 1,
    width: '58%',
  },
  authRole: {
    fontSize: 8,
    color: colors.muted,
  },
});
