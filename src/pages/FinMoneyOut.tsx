import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles } from '../lib/pushNotify';
import { fetchPartners, type PartnerLite } from '../lib/partnerCapital';
import {
  fetchMoneyDisbursements,
  createMoneyDisbursement,
  updateMoneyDisbursement,
  deleteMoneyDisbursement,
  totalOut,
  MONEY_OUT_CATS,
  type MoneyDisbursement,
} from '../lib/moneyDisbursements';
import styles from './FinPages.module.css';

// "Money Out" — a standalone, admin-only log of every disbursement out of
// the company (salaries, team advances, operational spend, anything else).
// Not a cost-categorization report like General/Project Expenses — this is
// a custody/accountability log: who gave the money out, who/what it went
// to, and who logged the entry. See
// docs/go-live/23_add_money_disbursements.sql for the full design write-up.
// Admin-only, same access model as Partner Capital — no permissionsCatalog
// entries, gated by a direct role check.

const FIN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function iqd(n: number | null | undefined): string {
  if (n == null) return '—';
  const v = Math.round(+n);
  return isNaN(v) ? '—' : v.toLocaleString('en-US') + ' IQD';
}

function getYears(): number[] {
  const y = new Date().getFullYear();
  return [y - 2, y - 1, y, y + 1];
}

interface FormState {
  givenBy: string; givenTo: string; cat: string; amount: string; date: string; notes: string;
}

function emptyForm(): FormState {
  return { givenBy: '', givenTo: '', cat: '', amount: '', date: new Date().toISOString().slice(0, 10), notes: '' };
}

export default function FinMoneyOut() {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';

  if (!isAdmin) {
    return <div className={styles.placeholder}>You don't have permission to view Money Out.</div>;
  }

  const [rows, setRows] = useState<MoneyDisbursement[]>([]);
  const [people, setPeople] = useState<PartnerLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fCat, setFCat] = useState('');
  const [fMonth, setFMonth] = useState(new Date().getMonth() + 1);
  const [fYear, setFYear] = useState(new Date().getFullYear());
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [modalOpen, setModalOpen] = useState(false);
  const [modalSaving, setModalSaving] = useState(false);
  const [modalErr, setModalErr] = useState<string | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [delMsg, setDelMsg] = useState('');
  const [delSaving, setDelSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string) {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 3200);
  }

  useEffect(() => { loadData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadData() {
    setLoading(true); setLoadError(null);
    try {
      const [d, p] = await Promise.all([fetchMoneyDisbursements(), fetchPartners()]);
      setRows(d);
      setPeople(p);
    } catch (e: unknown) { setLoadError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }

  function personName(id: string | null): string {
    if (!id) return '—';
    return people.find(p => p.id === id)?.full_name ?? '—';
  }

  function filteredRows(): MoneyDisbursement[] {
    return rows.filter(r => {
      const d = r.disbursement_date ? new Date(r.disbursement_date) : null;
      return (!fCat || r.category === fCat) &&
        (!fMonth || (d && d.getMonth() + 1 === fMonth)) &&
        (!fYear || (d && d.getFullYear() === fYear));
    });
  }

  function openModal(id: string | null) {
    setEditId(id); setModalErr(null);
    if (id) {
      const r = rows.find(x => x.id === id);
      if (!r) return;
      setForm({
        givenBy: r.given_by || '', givenTo: r.given_to || '', cat: r.category || '',
        amount: String(r.amount ?? ''), date: r.disbursement_date || '', notes: r.notes || '',
      });
    } else {
      setForm(emptyForm());
    }
    setModalOpen(true);
  }

  async function saveModal() {
    setModalErr(null);
    const givenBy = form.givenBy.trim();
    const givenTo = form.givenTo.trim();
    const amt = +form.amount;
    if (!givenBy) { setModalErr('Given by is required.'); return; }
    if (!givenTo) { setModalErr('Given to is required.'); return; }
    if (!amt || amt <= 0) { setModalErr('Valid amount required.'); return; }
    if (!currentUser) { setModalErr('Not signed in.'); return; }

    setModalSaving(true);
    try {
      if (editId) {
        const { error } = await updateMoneyDisbursement(editId, {
          given_by: givenBy, given_to: givenTo, category: form.cat || null,
          amount: amt, disbursement_date: form.date || undefined, notes: form.notes.trim() || null,
        }, currentUser.id);
        if (error) throw new Error(error);
        setRows(prev => prev.map(r => r.id === editId
          ? { ...r, given_by: givenBy, given_to: givenTo, category: form.cat || null, amount: amt, disbursement_date: form.date || r.disbursement_date, notes: form.notes.trim() || null }
          : r));
        showToast('Updated');
        logActivity({
          userFullName: currentUser.full_name ?? currentUser.username,
          action: 'Edited Money Out entry',
          details: `Edited: ${givenTo} ${iqd(amt)}`,
        });
      } else {
        const { id, error } = await createMoneyDisbursement({
          disbursement_date: form.date, given_by: givenBy, given_to: givenTo,
          category: form.cat || null, amount: amt, notes: form.notes.trim() || null,
          created_by: currentUser.id,
        });
        if (error) throw new Error(error);
        setRows(prev => [{
          id: id ?? crypto.randomUUID(), disbursement_date: form.date, given_by: givenBy, given_to: givenTo,
          category: form.cat || null, amount: amt, notes: form.notes.trim() || null,
          created_by: currentUser.id, created_at: new Date().toISOString(), updated_by: null, updated_at: null,
        }, ...prev]);
        showToast('Added');
        void sendPushToRoles(['admin'], 'Money Out Logged', `${givenTo} — ${iqd(amt)}`);
        logActivity({
          userFullName: currentUser.full_name ?? currentUser.username,
          action: 'Added Money Out entry',
          details: `Added: ${givenTo} ${iqd(amt)}`,
        });
      }
      setModalOpen(false);
    } catch (e: unknown) { setModalErr(e instanceof Error ? e.message : String(e)); }
    finally { setModalSaving(false); }
  }

  function openDelModal(id: string) {
    const r = rows.find(x => x.id === id);
    setDelMsg(r ? `Delete "${r.given_to || '—'}" — ${iqd(r.amount)}?` : 'Delete this entry?');
    setDelId(id);
  }

  async function confirmDelete() {
    if (!delId) return;
    setDelSaving(true);
    const r = rows.find(x => x.id === delId);
    const { error } = await deleteMoneyDisbursement(delId);
    if (error) { showToast('Error: ' + error); setDelSaving(false); return; }
    setRows(prev => prev.filter(r => r.id !== delId));
    setDelId(null); setDelSaving(false);
    showToast('Deleted');
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Deleted Money Out entry',
      details: `Deleted: ${r?.given_to || ''} ${iqd(r?.amount)}`,
    });
  }

  async function handleExport() {
    const data = filteredRows();
    if (!data.length) { showToast('No data to export'); return; }
    try {
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('money_out');
      ws.addRow(['Date', 'Given By', 'Given To', 'Category', 'Amount (IQD)', 'Notes', 'Added By']);
      for (const r of data) ws.addRow([r.disbursement_date, r.given_by, r.given_to, r.category, r.amount, r.notes, personName(r.created_by)]);
      const buf = await wb.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      Object.assign(document.createElement('a'), { href: url, download: `Finance_moneyout_${new Date().toISOString().slice(0,10)}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) { showToast('Export failed: ' + (e instanceof Error ? e.message : String(e))); }
  }

  const filtered = filteredRows();
  const total = totalOut(filtered);
  const years = getYears();

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <select className={styles.sel} value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All Categories</option>
          {MONEY_OUT_CATS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className={styles.sel} value={fMonth} onChange={e => setFMonth(+e.target.value)}>
          <option value={0}>All Months</option>
          {FIN_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select className={styles.sel} value={fYear} onChange={e => setFYear(+e.target.value)}>
          <option value={0}>All Years</option>
          {years.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <div className={styles.spacer} />
        <button className={styles.btnGhost} onClick={() => loadData()}>↺ Refresh</button>
        <button className={styles.btnGhost} onClick={handleExport}>Export</button>
        <button className={styles.btnAccent} onClick={() => openModal(null)}>+ Log Money Out</button>
      </div>

      {loading && <div className={styles.loadingBar}>Loading…</div>}
      {loadError && <div className={styles.errorMsg}>{loadError}</div>}

      {!loading && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th><th>Given By</th><th>Given To</th><th>Category</th>
                <th className={styles.num}>Amount (IQD)</th><th>Notes</th><th>Added By</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0
                ? <tr><td colSpan={8} className={styles.empty}>No money-out entries.</td></tr>
                : filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.disbursement_date || ''}</td>
                    <td>{r.given_by || ''}</td>
                    <td>{r.given_to || ''}</td>
                    <td>{r.category || ''}</td>
                    <td className={styles.num} style={{ color: '#dc2626' }}>{iqd(r.amount)}</td>
                    <td className={styles.noteCell}>{r.notes || ''}</td>
                    <td style={{ color: 'var(--slate-500)', whiteSpace: 'nowrap' }}>
                      <div>{personName(r.created_by)}</div>
                      {r.updated_by && <div style={{ fontSize: 11, color: '#94a3b8' }}>edited by {personName(r.updated_by)}</div>}
                    </td>
                    <td>
                      <div className={styles.actions}>
                        <button className={styles.actBtn} onClick={() => openModal(r.id)} title="Edit"><PenIcon /></button>
                        <button className={`${styles.actBtn} ${styles.actBtnDel}`} onClick={() => openDelModal(r.id)} title="Delete"><TrashIcon /></button>
                      </div>
                    </td>
                  </tr>
                ))
              }
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}><strong>Total (filtered)</strong></td>
                <td className={styles.num} style={{ color: '#dc2626' }}><strong>{iqd(total)}</strong></td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && createPortal(
        <div className={styles.overlay} onClick={() => !modalSaving && setModalOpen(false)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>{editId ? 'Edit Money Out Entry' : 'Log Money Out'}</div>
            {modalErr && <div className={styles.modalErr}>{modalErr}</div>}
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Given By</label>
              <input className={styles.formInput} placeholder="e.g. Finance Manager" value={form.givenBy} autoFocus
                onChange={e => setForm(f => ({ ...f, givenBy: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Given To</label>
              <input className={styles.formInput} placeholder="e.g. Team salaries — September" value={form.givenTo}
                onChange={e => setForm(f => ({ ...f, givenTo: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Category</label>
              <select className={styles.formSel} value={form.cat} onChange={e => setForm(f => ({ ...f, cat: e.target.value }))}>
                <option value="">— Select category —</option>
                {MONEY_OUT_CATS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Amount (IQD)</label>
              <input type="number" min={0} className={styles.formInput} value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Date</label>
              <input type="date" className={styles.formInput} value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>
            <div className={styles.formRow}>
              <label className={styles.formLabel}>Notes</label>
              <textarea className={styles.formTextarea} rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
            <div className={styles.modalActions}>
              <button className={styles.btnPrimary} disabled={modalSaving} onClick={saveModal}>
                {modalSaving ? 'Saving…' : editId ? 'Save Changes' : 'Log Money Out'}
              </button>
              <button className={styles.btnGhost2} disabled={modalSaving} onClick={() => setModalOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete confirm */}
      {delId && createPortal(
        <div className={styles.overlay} onClick={() => !delSaving && setDelId(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalTitle}>Confirm Delete</div>
            <p className={styles.delMsg}>{delMsg}</p>
            <div className={styles.modalActions}>
              <button className={styles.btnDanger} disabled={delSaving} onClick={confirmDelete}>
                {delSaving ? 'Deleting…' : 'Delete'}
              </button>
              <button className={styles.btnGhost2} disabled={delSaving} onClick={() => setDelId(null)}>Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {toastMsg && createPortal(<div className={styles.toast}>{toastMsg}</div>, document.body)}
    </div>
  );
}

function PenIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
}
function TrashIcon() {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>;
}
