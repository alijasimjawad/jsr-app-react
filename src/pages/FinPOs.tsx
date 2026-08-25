import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { iqd } from '../lib/finHelpers';
import { ensureProjectsLoaded, getProjectNames } from '../lib/projectsCache';
import type { PurchaseOrder } from '../lib/invoiceTypes';
import css from './FinBilling.module.css';

// ── Types ─────────────────────────────────────────────────────
// Local shapes for the joined data we need to render this page. We
// intentionally do NOT redefine PurchaseOrder — it comes from
// invoiceTypes.ts, which is the Phase 2 source of truth for the schema.
// Client/RevRow mirror the columns FinInvoices.tsx / FinRevenue.tsx read;
// duplicating the minimal shape here keeps this page self-contained
// without editing those files.
interface Client {
  id: string;
  company_name: string;
}

interface RevRow {
  id: string;
  project_name: string | null;
  section_name: string | null;
  site_id: string | null;
  amount: number | null;
  po_id: string | null;
}

interface POForm {
  po_number:      string;
  client_id:      string;
  project_name:   string;
  po_date:        string;
  po_amount:      string;
  currency:       string;
  status:         string;
  notes:          string;
  attachment_url: string;
}

const EMPTY_FORM: POForm = {
  po_number: '', client_id: '', project_name: '', po_date: '',
  po_amount: '', currency: 'IQD', status: 'Open', notes: '', attachment_url: '',
};

const STATUS_COLOR: Record<string, string> = {
  Open: '#dbeafe', Closed: '#dcfce7', Cancelled: '#fee2e2',
};
const STATUS_TEXT: Record<string, string> = {
  Open: '#1d4ed8', Closed: '#16a34a', Cancelled: '#dc2626',
};

export default function FinPOs() {
  const { hasPerm } = useAuth();

  // ── Core data ─────────────────────────────────────────────
  const [pos,          setPos]          = useState<PurchaseOrder[]>([]);
  const [clients,      setClients]      = useState<Client[]>([]);
  const [revenue,      setRevenue]      = useState<RevRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [FIN_PROJECTS, setFinProjects]  = useState<string[]>([]);

  // ── Create / Edit modal ───────────────────────────────────
  const [modal,   setModal]   = useState(false);
  const [editId,  setEditId]  = useState<string | null>(null);
  const [form,    setForm]    = useState<POForm>(EMPTY_FORM);
  const [formErr, setFormErr] = useState('');

  // ── Detail modal ──────────────────────────────────────────
  const [detailId,       setDetailId]       = useState<string | null>(null);
  const [detailShowAll,  setDetailShowAll]  = useState(false);
  // Pending assignment awaiting user confirmation because it would push
  // mappedSiteValue beyond po_amount. `null` when no guard is active.
  const [overallocConfirm, setOverallocConfirm] = useState<
    { revId: string; projected: number; poAmount: number } | null
  >(null);

  // ── Delete-block modal ────────────────────────────────────
  const [deleteBlock, setDeleteBlock] = useState<
    { po: PurchaseOrder; revCount: number; invCount: number } | null
  >(null);

  // ── Toast ─────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ensureProjectsLoaded().then(() => setFinProjects(getProjectNames()));
  }, []);

  if (!hasPerm('view_fin_purchase_orders')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // ── Load ──────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [po, cl, rv] = await Promise.all([
      supabase.from('purchase_orders').select('*').order('created_at', { ascending: false }),
      supabase.from('clients').select('id, company_name').order('company_name'),
      // Only the columns this page needs — keeps the payload lean but still
      // enough to compute mapped/unallocated per PO client-side.
      supabase.from('revenue').select('id, project_name, section_name, site_id, amount, po_id')
        .order('project_name').order('section_name').order('site_id'),
    ]);
    if (po.error) { setError(po.error.message); setLoading(false); return; }
    setPos((po.data || []) as PurchaseOrder[]);
    setClients((cl.data || []) as Client[]);
    setRevenue((rv.data || []) as RevRow[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Derived ───────────────────────────────────────────────
  const filteredPOs = pos.filter(p => {
    if (statusFilter && p.status !== statusFilter) return false;
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const clientName = clients.find(c => c.id === p.client_id)?.company_name || '';
    return (
      (p.po_number || '').toLowerCase().includes(q) ||
      clientName.toLowerCase().includes(q) ||
      (p.project_name || '').toLowerCase().includes(q)
    );
  });

  function mappedValueFor(poId: string): number {
    return revenue
      .filter(r => r.po_id === poId)
      .reduce((s, r) => s + (+(r.amount || 0)), 0);
  }

  // ── Create / Edit ─────────────────────────────────────────
  function openAdd() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setFormErr('');
    setModal(true);
  }

  function openEdit(p: PurchaseOrder) {
    setEditId(p.id);
    setForm({
      po_number:      p.po_number || '',
      client_id:      p.client_id || '',
      project_name:   p.project_name || '',
      po_date:        p.po_date || '',
      po_amount:      String(p.po_amount ?? ''),
      currency:       p.currency || 'IQD',
      status:         p.status || 'Open',
      notes:          p.notes || '',
      attachment_url: p.attachment_url || '',
    });
    setFormErr('');
    setModal(true);
  }

  async function save() {
    setFormErr('');
    if (!form.po_number.trim())              { setFormErr('PO number is required.'); return; }
    if (!form.client_id)                     { setFormErr('Client is required.'); return; }
    const amt = parseFloat(form.po_amount);
    if (isNaN(amt) || amt < 0)               { setFormErr('PO amount must be a non-negative number.'); return; }
    const payload = {
      po_number:      form.po_number.trim(),
      client_id:      form.client_id,
      project_name:   form.project_name.trim() || null,
      po_date:        form.po_date || null,
      po_amount:      amt,
      currency:       form.currency.trim() || 'IQD',
      status:         form.status || 'Open',
      notes:          form.notes.trim() || null,
      attachment_url: form.attachment_url.trim() || null,
    };
    if (editId) {
      const { error: e } = await supabase.from('purchase_orders').update(payload).eq('id', editId);
      if (e) { setFormErr(e.message); return; }
      setPos(list => list.map(p => p.id === editId ? { ...p, ...payload } as PurchaseOrder : p));
      showToast('Purchase Order updated.', true);
    } else {
      const { data, error: e } = await supabase.from('purchase_orders').insert(payload).select('*').single();
      if (e) { setFormErr(e.message); return; }
      setPos(list => [data as PurchaseOrder, ...list]);
      showToast('Purchase Order created!', true);
    }
    setModal(false);
  }

  // ── Delete (with safety check) ────────────────────────────
  async function tryDelete(p: PurchaseOrder) {
    // Query live counts — do not rely on the in-memory revenue list alone
    // for the invoice count, since invoices are not loaded on this page.
    const [rev, inv] = await Promise.all([
      supabase.from('revenue').select('id', { count: 'exact', head: true }).eq('po_id', p.id),
      supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('po_id', p.id),
    ]);
    const revCount = rev.count || 0;
    const invCount = inv.count || 0;
    if (revCount > 0 || invCount > 0) {
      setDeleteBlock({ po: p, revCount, invCount });
      return;
    }
    if (!window.confirm(`Delete PO ${p.po_number}? This cannot be undone.`)) return;
    const { error: e } = await supabase.from('purchase_orders').delete().eq('id', p.id);
    if (e) { showToast(e.message, false); return; }
    setPos(list => list.filter(x => x.id !== p.id));
    showToast('Purchase Order deleted.', true);
  }

  // ── Detail modal ──────────────────────────────────────────
  function openDetail(id: string) {
    setDetailId(id);
    setDetailShowAll(false);
    setOverallocConfirm(null);
  }
  function closeDetail() {
    setDetailId(null);
    setOverallocConfirm(null);
  }

  async function assignRevenue(revId: string, poId: string) {
    const { error: e } = await supabase.from('revenue').update({ po_id: poId }).eq('id', revId);
    if (e) { showToast(e.message, false); return; }
    setRevenue(list => list.map(r => r.id === revId ? { ...r, po_id: poId } : r));
    showToast('Site assigned to PO.', true);
  }

  async function unassignRevenue(revId: string) {
    const { error: e } = await supabase.from('revenue').update({ po_id: null }).eq('id', revId);
    if (e) { showToast(e.message, false); return; }
    setRevenue(list => list.map(r => r.id === revId ? { ...r, po_id: null } : r));
    showToast('Site unassigned.', true);
  }

  /**
   * Front-line assignment guard. If the *new* assignment would push the
   * mapped total past the PO amount, we surface a strong warning instead
   * of writing silently. The unassign path is deliberately unguarded so
   * admins can always dig out of a pre-existing over-allocation.
   */
  function tryAssign(revId: string, po: PurchaseOrder) {
    const currentMapped = mappedValueFor(po.id);
    const rev = revenue.find(r => r.id === revId);
    const projected = currentMapped + (+(rev?.amount || 0));
    if (projected > (+po.po_amount || 0)) {
      setOverallocConfirm({ revId, projected, poAmount: +po.po_amount || 0 });
      return;
    }
    assignRevenue(revId, po.id);
  }

  function confirmOverallocAssign() {
    if (!overallocConfirm || !detailId) return;
    assignRevenue(overallocConfirm.revId, detailId);
    setOverallocConfirm(null);
  }

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  const detailPO = detailId ? pos.find(p => p.id === detailId) : null;
  const detailClient = detailPO ? clients.find(c => c.id === detailPO.client_id) : undefined;
  const detailMapped = detailPO ? mappedValueFor(detailPO.id) : 0;
  const detailUnalloc = detailPO ? Math.max(0, (+detailPO.po_amount || 0) - detailMapped) : 0;
  const detailOver = detailPO ? Math.max(0, detailMapped - (+detailPO.po_amount || 0)) : 0;
  const assignedRevs = detailPO ? revenue.filter(r => r.po_id === detailPO.id) : [];
  const availableRevs = detailPO
    ? revenue.filter(r =>
        r.po_id == null &&
        (detailShowAll || !detailPO.project_name || r.project_name === detailPO.project_name)
      )
    : [];

  // ── Render ────────────────────────────────────────────────
  return (
    <div className={css.page}>
      {/* Header */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Purchase Orders</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
          {hasPerm('create_fin_purchase_orders') && (
            <button className={css.btnAccent} onClick={openAdd}>+ New PO</button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className={css.statusPills} style={{ alignItems: 'center' }}>
        <input
          className={css.formInput}
          placeholder="Search PO # / client / project…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ maxWidth: 280, height: 30, fontSize: 12 }}
        />
        {(['', 'Open', 'Closed', 'Cancelled'] as const).map(s => {
          const count  = s ? pos.filter(p => p.status === s).length : pos.length;
          const active = statusFilter === s;
          const color  = STATUS_TEXT[s] || '#1d4ed8';
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

      {/* Table */}
      <div className={css.tableWrap}>
        <table className={css.table} style={{ fontSize: 12 }}>
          <thead><tr>
            <th style={{ whiteSpace: 'nowrap' }}>PO Number</th>
            <th>Client</th>
            <th>Project</th>
            <th>PO Date</th>
            <th className={css.num}>PO Amount</th>
            <th>Status</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>
            {filteredPOs.length === 0
              ? <tr><td colSpan={7} className={css.empty}>{pos.length === 0 ? 'No Purchase Orders yet. Click "+ New PO" to add one.' : 'No POs match this filter.'}</td></tr>
              : filteredPOs.map(p => {
                  const client = clients.find(c => c.id === p.client_id);
                  return (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => openDetail(p.id)}>
                      <td style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{p.po_number}</td>
                      <td>{client?.company_name || '—'}</td>
                      <td style={{ color: '#64748b' }}>{p.project_name || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap', color: '#64748b' }}>{p.po_date || '—'}</td>
                      <td className={css.num} style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{iqd(p.po_amount)}</td>
                      <td>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: STATUS_COLOR[p.status] || '#f1f5f9', color: STATUS_TEXT[p.status] || '#475569' }}>
                          {p.status || 'Open'}
                        </span>
                      </td>
                      <td onClick={e => e.stopPropagation()}>
                        <div className={css.actWrap}>
                          <button className={css.actBtn} title="View Detail" onClick={() => openDetail(p.id)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2563eb" strokeWidth="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                          </button>
                          {hasPerm('edit_fin_purchase_orders') && (
                            <button className={css.actBtn} title="Edit" onClick={() => openEdit(p)}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                          )}
                          {hasPerm('delete_fin_purchase_orders') && (
                            <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => tryDelete(p)}>
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

      {/* Create / Edit Modal */}
      {modal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{editId ? 'Edit Purchase Order' : 'New Purchase Order'}</div>
            <div className={css.formGrid}>
              <div className={css.formField}>
                <label>PO Number *</label>
                <input className={css.formInput} maxLength={80} placeholder="e.g. PO-2026-001"
                  value={form.po_number} onChange={e => setForm(f => ({ ...f, po_number: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Client *</label>
                <select className={css.formSel} value={form.client_id}
                  onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))}>
                  <option value="">— Select Client —</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                </select>
              </div>
              <div className={css.formField}>
                <label>Project</label>
                <input list="po-projects-list" className={css.formInput} maxLength={120}
                  placeholder="Type or select…"
                  value={form.project_name}
                  onChange={e => setForm(f => ({ ...f, project_name: e.target.value }))} />
                <datalist id="po-projects-list">
                  {FIN_PROJECTS.map(p => <option key={p} value={p} />)}
                </datalist>
              </div>
              <div className={css.formField}>
                <label>PO Date</label>
                <input type="date" className={css.formInput}
                  value={form.po_date} onChange={e => setForm(f => ({ ...f, po_date: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>PO Amount *</label>
                <input type="number" min={0} className={css.formInput} placeholder="0"
                  value={form.po_amount} onChange={e => setForm(f => ({ ...f, po_amount: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Currency</label>
                <input className={css.formInput} maxLength={8}
                  value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Status</label>
                <select className={css.formSel} value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="Open">Open</option>
                  <option value="Closed">Closed</option>
                  <option value="Cancelled">Cancelled</option>
                </select>
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Attachment URL</label>
                <input className={css.formInput} maxLength={500} placeholder="https://…"
                  value={form.attachment_url} onChange={e => setForm(f => ({ ...f, attachment_url: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Notes</label>
                <textarea className={css.formTextarea} rows={2} placeholder="Optional…"
                  value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
            </div>
            {formErr && <div className={css.modalErr}>{formErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={save}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Detail Modal */}
      {detailId && detailPO && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) closeDetail(); }}>
          <div className={`${css.modal} ${css.modalLg}`}>
            <div className={css.detailHdr}>
              <div className={css.detailNumber}>{detailPO.po_number}</div>
              <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 20, background: STATUS_COLOR[detailPO.status] || '#f1f5f9', color: STATUS_TEXT[detailPO.status] || '#475569' }}>
                {detailPO.status || 'Open'}
              </span>
            </div>
            <div className={css.detailMeta}>
              <strong>{detailClient?.company_name || '—'}</strong> &nbsp;·&nbsp; {detailPO.project_name || '—'} &nbsp;·&nbsp; Date: {detailPO.po_date || '—'} &nbsp;·&nbsp; Currency: {detailPO.currency || 'IQD'}
              {detailPO.notes && <div style={{ marginTop: 4, fontStyle: 'italic' }}>{detailPO.notes}</div>}
              {detailPO.attachment_url && (
                <div style={{ marginTop: 4 }}>
                  Attachment: <a href={detailPO.attachment_url} target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>{detailPO.attachment_url}</a>
                </div>
              )}
            </div>

            {/* Summary card */}
            <div className={css.totalBar}>
              <div className={css.totalBarItem} style={{ color: '#64748b' }}>
                PO Value <strong style={{ color: '#1e293b' }}>{iqd(detailPO.po_amount)}</strong>
              </div>
              <div className={css.totalBarItem} style={{ color: '#16a34a' }}>
                Mapped <strong>{iqd(detailMapped)}</strong>
              </div>
              <div className={css.totalBarItem} style={{ color: detailOver > 0 ? '#dc2626' : '#b45309' }}>
                {detailOver > 0
                  ? <>Over-allocated <strong>{iqd(detailOver)}</strong></>
                  : <>Unallocated <strong>{iqd(detailUnalloc)}</strong></>
                }
              </div>
            </div>

            {/* Assigned sites */}
            <div className={css.detailSectionLbl} style={{ marginTop: 20 }}>Assigned Sites</div>
            <div className={css.detailBox}>
              {assignedRevs.length === 0
                ? <div className={css.detailEmpty}>No sites assigned to this PO yet.</div>
                : <table className={css.table} style={{ fontSize: 12 }}>
                    <thead><tr>
                      <th>Site ID</th>
                      <th>Section</th>
                      <th>Project</th>
                      <th className={css.num}>Commercial Value</th>
                      {hasPerm('edit_fin_purchase_orders') && <th></th>}
                    </tr></thead>
                    <tbody>
                      {assignedRevs.map(r => (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600 }}>{String(r.site_id || '—')}</td>
                          <td style={{ color: '#64748b' }}>{r.section_name || '—'}</td>
                          <td style={{ color: '#64748b' }}>{r.project_name || '—'}</td>
                          <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(r.amount || 0)}</td>
                          {hasPerm('edit_fin_purchase_orders') && (
                            <td>
                              <button className={`${css.actBtn} ${css.actBtnDel}`} title="Unassign from PO" onClick={() => unassignRevenue(r.id)}>
                                Unassign
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </div>

            {/* Available sites */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div className={css.detailSectionLbl} style={{ margin: 0 }}>
                Available Sites {detailPO.project_name && !detailShowAll ? `— ${detailPO.project_name}` : ''}
              </div>
              {detailPO.project_name && (
                <label style={{ fontSize: 12, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={detailShowAll} onChange={e => setDetailShowAll(e.target.checked)} />
                  Show all projects
                </label>
              )}
            </div>
            <div className={css.detailBox}>
              {availableRevs.length === 0
                ? <div className={css.detailEmpty}>No unassigned sites{detailPO.project_name && !detailShowAll ? ' for this project' : ''}.</div>
                : <table className={css.table} style={{ fontSize: 12 }}>
                    <thead><tr>
                      <th>Site ID</th>
                      <th>Section</th>
                      <th>Project</th>
                      <th className={css.num}>Commercial Value</th>
                      {hasPerm('edit_fin_purchase_orders') && <th></th>}
                    </tr></thead>
                    <tbody>
                      {availableRevs.map(r => (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600 }}>{String(r.site_id || '—')}</td>
                          <td style={{ color: '#64748b' }}>{r.section_name || '—'}</td>
                          <td style={{ color: '#64748b' }}>{r.project_name || '—'}</td>
                          <td className={css.num} style={{ fontWeight: 700, color: '#16a34a' }}>{iqd(r.amount || 0)}</td>
                          {hasPerm('edit_fin_purchase_orders') && (
                            <td>
                              <button className={css.actBtn} title="Assign to this PO" onClick={() => tryAssign(r.id, detailPO)}>
                                Assign
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
              }
            </div>

            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={closeDetail}>Close</button>
              {hasPerm('edit_fin_purchase_orders') && (
                <button className={css.btnSave} onClick={() => { closeDetail(); openEdit(detailPO); }}>Edit PO</button>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Overallocation warning */}
      {overallocConfirm && detailPO && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setOverallocConfirm(null); }}>
          <div className={css.modal}>
            <div className={css.modalTitle} style={{ color: '#dc2626' }}>Over-allocation Warning</div>
            <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
              Assigning this site would push mapped commercial value to{' '}
              <strong>{iqd(overallocConfirm.projected)}</strong>, exceeding the PO amount of{' '}
              <strong>{iqd(overallocConfirm.poAmount)}</strong> by{' '}
              <strong style={{ color: '#dc2626' }}>{iqd(overallocConfirm.projected - overallocConfirm.poAmount)}</strong>.
              <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
                Cancel and adjust the PO amount, or the revenue values, before continuing.
                "Assign anyway" will link the site but leave the PO in an over-allocated state.
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

      {/* Delete-blocked modal */}
      {deleteBlock && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setDeleteBlock(null); }}>
          <div className={css.modal}>
            <div className={css.modalTitle} style={{ color: '#dc2626' }}>Delete Blocked</div>
            <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
              This PO (<strong>{deleteBlock.po.po_number}</strong>) has{' '}
              <strong>{deleteBlock.revCount}</strong> linked revenue row{deleteBlock.revCount === 1 ? '' : 's'} and{' '}
              <strong>{deleteBlock.invCount}</strong> linked invoice{deleteBlock.invCount === 1 ? '' : 's'}.
              <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
                Change its status to Cancelled or Closed instead of deleting to preserve financial history.
              </div>
            </div>
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setDeleteBlock(null)}>Close</button>
              {hasPerm('edit_fin_purchase_orders') && (
                <button className={css.btnSave} onClick={() => {
                  const po = deleteBlock.po;
                  setDeleteBlock(null);
                  openEdit(po);
                }}>Edit PO Status</button>
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
