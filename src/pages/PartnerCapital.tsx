import { useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import {
  fetchPartners,
  fetchPartnerCapitalEntries,
  createPartnerCapitalEntry,
  updatePartnerCapitalEntry,
  deletePartnerCapitalEntry,
  totalForPartner,
  grandTotal,
  type PartnerLite,
  type PartnerCapitalEntry,
} from '../lib/partnerCapital';
import { iqd } from '../lib/finHelpers';
import css from './PartnerCapital.module.css';

// Partner Capital — a standalone, admin-only ledger of how much money each
// company partner has put into the company. See
// docs/go-live/22_add_partner_capital.sql for the full design write-up.
// Partners ARE the existing admin accounts; there's no ratio/percentage,
// no self-view — any admin who opens this page sees every partner's full
// contribution history, and every row shows who added/last edited it.

export default function PartnerCapital() {
  const { currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';

  if (!isAdmin) {
    return <div className={css.errorMsg}>Access denied.</div>;
  }

  const [partners, setPartners] = useState<PartnerLite[]>([]);
  const [entries, setEntries] = useState<PartnerCapitalEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadAll() {
    setLoading(true);
    const [p, e] = await Promise.all([fetchPartners(), fetchPartnerCapitalEntries()]);
    setPartners(p);
    setEntries(e);
    setLoading(false);
  }
  useEffect(() => { loadAll(); }, []);

  const partnerName = (id: string) => partners.find(p => p.id === id)?.full_name ?? '—';
  const total = useMemo(() => grandTotal(entries), [entries]);

  // ── New / edit entry modal ──────────────────────────────────────────
  const [showModal, setShowModal] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formPartnerId, setFormPartnerId] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [formNote, setFormNote] = useState('');
  const [saving, setSaving] = useState(false);

  function openNew() {
    setEditId(null);
    setFormPartnerId('');
    setFormAmount('');
    setFormDate(new Date().toISOString().slice(0, 10));
    setFormNote('');
    setShowModal(true);
  }

  function openEdit(e: PartnerCapitalEntry) {
    setEditId(e.id);
    setFormPartnerId(e.partner_id);
    setFormAmount(String(e.amount));
    setFormDate(e.entry_date);
    setFormNote(e.note ?? '');
    setShowModal(true);
  }

  async function submit() {
    const amount = Number(formAmount);
    if (!formPartnerId) { showToast('Pick a partner.', false); return; }
    if (!amount || amount <= 0) { showToast('Enter a valid amount.', false); return; }
    if (!currentUser) { showToast('Not signed in.', false); return; }

    setSaving(true);
    const { error } = editId
      ? await updatePartnerCapitalEntry(editId, {
          partner_id: formPartnerId,
          amount,
          entry_date: formDate,
          note: formNote.trim() || null,
        }, currentUser.id)
      : await createPartnerCapitalEntry({
          partner_id: formPartnerId,
          amount,
          entry_date: formDate,
          note: formNote.trim() || null,
          created_by: currentUser.id,
        });
    setSaving(false);
    if (error) { showToast('Save failed: ' + error, false); return; }
    showToast(editId ? 'Entry updated.' : 'Contribution logged.', true);
    setShowModal(false);
    loadAll();
  }

  async function remove(id: string) {
    if (!confirm('Delete this contribution entry? This cannot be undone.')) return;
    const { error } = await deletePartnerCapitalEntry(id);
    if (error) { showToast('Delete failed: ' + error, false); return; }
    showToast('Entry deleted.', true);
    loadAll();
  }

  if (loading) return <div className={css.empty}>Loading…</div>;

  return (
    <div className={css.page}>
      <h2 className={css.heading}>Partner Capital</h2>
      <p className={css.subheading}>
        Tracks how much money each partner has put into the company. Not linked to invoices or payroll.
      </p>

      <div className={css.sectionTitle}>Totals by partner</div>
      <div className={css.summaryGrid}>
        <div className={`${css.summaryCard} ${css.total}`}>
          <div className={css.summaryName}>Total Company Capital</div>
          <div className={css.summaryAmount}>{iqd(total)}</div>
        </div>
        {partners.map(p => {
          const t = totalForPartner(entries, p.id);
          if (t === 0) return null;
          return (
            <div className={css.summaryCard} key={p.id}>
              <div className={css.summaryName}>{p.full_name}</div>
              <div className={css.summaryAmount}>{iqd(t)}</div>
            </div>
          );
        })}
      </div>

      <div className={css.sectionTitle}>
        All contributions
        <span className={css.spacer} />
        <button className={css.btnPrimary} onClick={openNew}>+ New Contribution</button>
      </div>

      {entries.length === 0 ? (
        <div className={css.empty}>No contributions logged yet.</div>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Date</th>
                <th className={css.num}>Amount</th>
                <th>Note</th>
                <th>Added by</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{partnerName(e.partner_id)}</td>
                  <td>{e.entry_date}</td>
                  <td className={css.num}>{iqd(e.amount)}</td>
                  <td>{e.note || '—'}</td>
                  <td>
                    <div>{e.created_by ? partnerName(e.created_by) : '—'}</div>
                    {e.updated_by && (
                      <div className={css.metaText}>edited by {partnerName(e.updated_by)}</div>
                    )}
                  </td>
                  <td>
                    <div className={css.rowActions}>
                      <button className={`${css.iconBtn} ${css.iconBtnEdit}`} onClick={() => openEdit(e)}>Edit</button>
                      <button className={`${css.iconBtn} ${css.iconBtnDelete}`} onClick={() => remove(e.id)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{editId ? 'Edit Contribution' : 'New Contribution'}</div>
            <div className={css.modalSub}>Log an amount a partner has put into the company.</div>

            <div className={css.modalField}>
              <label className={css.modalLabel}>Partner</label>
              <select className={css.modalSel} value={formPartnerId} onChange={e => setFormPartnerId(e.target.value)}>
                <option value="">Select…</option>
                {partners.map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
            </div>

            <div className={css.modalRow}>
              <div className={css.modalField}>
                <label className={css.modalLabel}>Amount</label>
                <input className={css.modalInput} type="number" min="0" step="0.01" value={formAmount} onChange={e => setFormAmount(e.target.value)} />
              </div>
              <div className={css.modalField}>
                <label className={css.modalLabel}>Date</label>
                <input className={css.modalInput} type="date" value={formDate} onChange={e => setFormDate(e.target.value)} />
              </div>
            </div>

            <div className={css.modalField}>
              <label className={css.modalLabel}>Note (optional)</label>
              <input className={css.modalInput} type="text" value={formNote} onChange={e => setFormNote(e.target.value)} placeholder="e.g. capital top-up" />
            </div>

            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setShowModal(false)}>Cancel</button>
              <button className={css.btnApply} disabled={saving} onClick={submit}>
                {saving ? 'Saving…' : editId ? 'Save' : 'Add Contribution'}
              </button>
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
