import { Fragment, useEffect, useRef, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import {
  fetchAdvancesWithDistributions,
  fetchMyDistributions,
  createAdvance,
  deleteAdvance,
  addDistribution,
  updateDistribution,
  deleteDistribution,
  remainingBalance,
  type AdvanceDistribution,
  type AdvanceWithDistributions,
} from '../lib/advances';
import { FIN_MONTHS, getYears, iqd } from '../lib/finHelpers';
import css from './Advances.module.css';

// Salary Advances (سلفة). See docs/go-live/20_add_salary_advances.sql for the
// full design write-up. Three things happen on this one page depending on
// who's looking:
//   - Admin: sees every batch, can open a new one for any team leader.
//   - The team leader a batch is assigned to: logs cash-handout entries
//     against their own open batches until the remaining balance hits 0.
//   - Everybody (including the leader and admin, for their own account):
//     sees a plain list of what they personally received.

interface TeamMemberLite {
  id: string;
  full_name: string;
  username: string | null;
  role: string;
  is_active: boolean;
}

export default function Advances() {
  const { currentUser, hasPerm } = useAuth();

  if (!hasPerm('view_advances')) {
    return <div className={css.errorMsg}>Access denied.</div>;
  }

  const isAdmin = currentUser?.role === 'admin';

  const [teamMembers, setTeamMembers] = useState<TeamMemberLite[]>([]);
  const [myMemberId, setMyMemberId] = useState<string | null>(null);
  const [batches, setBatches] = useState<AdvanceWithDistributions[]>([]);
  const [myReceived, setMyReceived] = useState<AdvanceDistribution[]>([]);
  const [loading, setLoading] = useState(true);

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  // Resolve "which team_members row is me" the same way MyAttendance.tsx does
  // (match by full_name, fall back to username) — team_members has no direct
  // FK to users, so this is the client-side equivalent of the DB's
  // jsr_current_team_member_id() helper.
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from('team_members')
        .select('id, full_name, username, role, is_active')
        .order('full_name');
      if (error) { console.error('team_members fetch failed:', error.message); return; }
      const list = (data as TeamMemberLite[]) ?? [];
      setTeamMembers(list);
      if (!currentUser) return;
      const name = (currentUser.full_name || '').trim().toLowerCase();
      const uname = (currentUser.username || '').trim().toLowerCase();
      const match = list.find(m =>
        (name && m.full_name?.trim().toLowerCase() === name) ||
        (uname && m.username?.trim().toLowerCase() === uname)
      );
      setMyMemberId(match?.id ?? null);
    })();
  }, [currentUser]);

  async function loadBatches() {
    setLoading(true);
    const b = await fetchAdvancesWithDistributions();
    setBatches(b);
    setLoading(false);
  }
  useEffect(() => { loadBatches(); }, []);

  useEffect(() => {
    if (!myMemberId) { setMyReceived([]); return; }
    fetchMyDistributions(myMemberId).then(setMyReceived);
  }, [myMemberId, batches]);

  const memberName = (id: string | null) => teamMembers.find(m => m.id === id)?.full_name ?? '—';
  const activeMembers = useMemo(() => teamMembers.filter(m => m.is_active), [teamMembers]);

  // Batches where the signed-in person is the assigned leader — these are
  // the ones they can log distribution entries against. (For a non-admin,
  // `batches` from RLS already only ever contains their own batches anyway;
  // this filter also covers the case where an admin is themselves a team
  // leader on some batch.)
  const leaderBatches = useMemo(
    () => batches.filter(b => b.team_leader_id === myMemberId),
    [batches, myMemberId]
  );

  // ── Admin: expand a batch row to see who it was distributed to ───────
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);

  // ── Admin: new advance batch ─────────────────────────────────────────
  const now = new Date();
  const [showNewAdv, setShowNewAdv] = useState(false);
  const [newLeaderId, setNewLeaderId] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newMonth, setNewMonth] = useState(now.getMonth() + 1);
  const [newYear, setNewYear] = useState(now.getFullYear());
  const [newReason, setNewReason] = useState('');
  const [savingAdv, setSavingAdv] = useState(false);

  function openNewAdvModal() {
    setNewLeaderId('');
    setNewAmount('');
    setNewMonth(now.getMonth() + 1);
    setNewYear(now.getFullYear());
    setNewReason('');
    setShowNewAdv(true);
  }

  async function submitNewAdvance() {
    const amount = Number(newAmount);
    if (!newLeaderId) { showToast('Pick a team leader.', false); return; }
    if (!amount || amount <= 0) { showToast('Enter a valid amount.', false); return; }
    setSavingAdv(true);
    const { error } = await createAdvance({
      team_leader_id: newLeaderId,
      total_amount: amount,
      month: newMonth,
      year: newYear,
      reason: newReason.trim() || null,
      created_by: currentUser?.id ?? null,
    });
    setSavingAdv(false);
    if (error) { showToast('Failed to create advance: ' + error, false); return; }
    showToast('Advance batch created.', true);
    setShowNewAdv(false);
    loadBatches();
  }

  async function removeAdvance(id: string) {
    if (!confirm('Delete this advance batch and all its logged entries? This cannot be undone.')) return;
    const { error } = await deleteAdvance(id);
    if (error) { showToast('Delete failed: ' + error, false); return; }
    showToast('Advance batch deleted.', true);
    loadBatches();
  }

  // ── Leader: add / edit / delete a distribution entry ─────────────────
  const [entryBatchId, setEntryBatchId] = useState<string | null>(null); // which batch's inline form is open
  const [entryEditId, setEntryEditId] = useState<string | null>(null);   // editing an existing entry, else null = adding
  const [entryMemberId, setEntryMemberId] = useState('');
  const [entryAmount, setEntryAmount] = useState('');
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [entryDetails, setEntryDetails] = useState('');
  const [savingEntry, setSavingEntry] = useState(false);

  function openAddEntry(batchId: string) {
    setEntryBatchId(batchId);
    setEntryEditId(null);
    setEntryMemberId('');
    setEntryAmount('');
    setEntryDate(new Date().toISOString().slice(0, 10));
    setEntryDetails('');
  }

  function openEditEntry(batch: AdvanceWithDistributions, d: AdvanceDistribution) {
    setEntryBatchId(batch.id);
    setEntryEditId(d.id);
    setEntryMemberId(d.member_id);
    setEntryAmount(String(d.amount));
    setEntryDate(d.entry_date);
    setEntryDetails(d.details ?? '');
  }

  function closeEntryForm() {
    setEntryBatchId(null);
    setEntryEditId(null);
  }

  async function submitEntry(batch: AdvanceWithDistributions) {
    const amount = Number(entryAmount);
    if (!entryMemberId) { showToast('Pick a recipient.', false); return; }
    if (!amount || amount <= 0) { showToast('Enter a valid amount.', false); return; }

    // Client-side guard only (RLS enforces WHO can write, not the running
    // total) — don't let a leader log more than what's left in the batch.
    const others = batch.distributions.filter(d => d.id !== entryEditId);
    const alreadyDistributed = others.reduce((s, d) => s + Number(d.amount), 0);
    if (alreadyDistributed + amount > Number(batch.total_amount) + 0.0001) {
      const left = Number(batch.total_amount) - alreadyDistributed;
      showToast(`Only ${iqd(left)} left in this batch.`, false);
      return;
    }

    if (!myMemberId) { showToast('Could not resolve your team member record.', false); return; }

    setSavingEntry(true);
    const { error } = entryEditId
      ? await updateDistribution(entryEditId, {
          member_id: entryMemberId,
          amount,
          entry_date: entryDate,
          details: entryDetails.trim() || null,
        })
      : await addDistribution({
          advance_id: batch.id,
          member_id: entryMemberId,
          amount,
          entry_date: entryDate,
          details: entryDetails.trim() || null,
          created_by: myMemberId,
        });
    setSavingEntry(false);
    if (error) { showToast('Save failed: ' + error, false); return; }
    showToast(entryEditId ? 'Entry updated.' : 'Distribution logged.', true);
    closeEntryForm();
    loadBatches();
  }

  async function removeEntry(id: string) {
    if (!confirm('Delete this distribution entry?')) return;
    const { error } = await deleteDistribution(id);
    if (error) { showToast('Delete failed: ' + error, false); return; }
    showToast('Entry deleted.', true);
    loadBatches();
  }

  if (loading) return <div className={css.empty}>Loading…</div>;

  return (
    <div className={css.page}>
      <h2 className={css.heading}>Salary Advances</h2>
      <p className={css.subheading}>
        Advance amounts handed to a team leader for distribution — deducted from the recipients'
        (and, for any undistributed remainder, the leader's own) next salary.
      </p>

      {/* ── Admin: all batches ─────────────────────────────────────── */}
      {isAdmin && (
        <>
          <div className={css.sectionTitle}>
            All advance batches
            <span className={css.spacer} />
            <button className={css.btnPrimary} onClick={openNewAdvModal}>+ New Advance</button>
          </div>
          {batches.length === 0 ? (
            <div className={css.empty}>No advance batches yet.</div>
          ) : (
            <div className={css.tableWrap}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>Team Leader</th>
                    <th>Target Month</th>
                    <th className={css.num}>Total</th>
                    <th className={css.num}>Distributed</th>
                    <th className={css.num}>Remaining</th>
                    <th>Reason</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map(b => {
                    const remaining = remainingBalance(b, b.distributions);
                    const distributed = Number(b.total_amount) - remaining;
                    const isExpanded = expandedBatchId === b.id;
                    return (
                      <Fragment key={b.id}>
                        <tr
                          className={`${css.tableRow} ${isExpanded ? css.tableRowExpanded : ''}`}
                          onClick={() => setExpandedBatchId(isExpanded ? null : b.id)}
                        >
                          <td>{memberName(b.team_leader_id)}</td>
                          <td>{FIN_MONTHS[b.month - 1]} {b.year}</td>
                          <td className={css.num}>{iqd(b.total_amount)}</td>
                          <td className={css.num}>{iqd(distributed)}</td>
                          <td className={css.num}>{iqd(remaining)}</td>
                          <td>{b.reason || '—'}</td>
                          <td>
                            <div className={css.rowActions}>
                              <button
                                className={`${css.iconBtn} ${css.iconBtnDelete}`}
                                onClick={e => { e.stopPropagation(); removeAdvance(b.id); }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr key={`${b.id}-detail`}>
                            <td colSpan={7} className={css.expandCell}>
                              <div className={css.detailPanel}>
                                {b.distributions.length === 0 ? (
                                  <div className={css.empty}>Nothing distributed from this batch yet.</div>
                                ) : (
                                  <table className={css.detailTable}>
                                    <thead className={css.detailTableHead}>
                                      <tr>
                                        <th>Recipient</th>
                                        <th>Date</th>
                                        <th>Details</th>
                                        <th style={{ textAlign: 'right' }}>Amount</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {b.distributions.map(d => (
                                        <tr key={d.id}>
                                          <td>{memberName(d.member_id)}</td>
                                          <td>{d.entry_date}</td>
                                          <td>{d.details || '—'}</td>
                                          <td style={{ textAlign: 'right' }}>{iqd(d.amount)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Team leader: distribute cash from my own batches ──────────── */}
      {leaderBatches.length > 0 && (
        <>
          <div className={css.sectionTitle}>My advances to distribute</div>
          {leaderBatches.map(b => {
            const remaining = remainingBalance(b, b.distributions);
            const distributed = Number(b.total_amount) - remaining;
            const pct = Number(b.total_amount) > 0 ? Math.min(100, (distributed / Number(b.total_amount)) * 100) : 0;
            const isDone = remaining <= 0.0001;
            return (
              <div className={css.batchCard} key={b.id}>
                <div className={css.batchHeader}>
                  <div>
                    <div className={css.batchLeader}>{FIN_MONTHS[b.month - 1]} {b.year} — {iqd(b.total_amount)}</div>
                    {b.reason && <div className={css.batchReason}>{b.reason}</div>}
                  </div>
                  <span className={isDone ? css.badgeDone : css.badgeOpen}>{isDone ? 'Fully distributed' : 'Open'}</span>
                  <div className={css.progressWrap}>
                    <div className={css.progressBar}>
                      <div className={`${css.progressFill} ${isDone ? css.progressFillFull : ''}`} style={{ width: `${pct}%` }} />
                    </div>
                    <span className={css.progressLabel}>{iqd(remaining)} left</span>
                  </div>
                </div>
                <div className={css.batchBody}>
                  {!isDone && entryBatchId !== b.id && (
                    <button className={css.btnGhost} onClick={() => openAddEntry(b.id)}>+ Log a distribution</button>
                  )}

                  {entryBatchId === b.id && (
                    <div className={css.entryForm}>
                      <div className={css.formField}>
                        <label className={css.formLabel}>Recipient</label>
                        <select className={css.formSel} value={entryMemberId} onChange={e => setEntryMemberId(e.target.value)}>
                          <option value="">Select…</option>
                          {activeMembers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                        </select>
                      </div>
                      <div className={css.formField}>
                        <label className={css.formLabel}>Amount</label>
                        <input className={css.formInput} type="number" min="0" step="0.01" value={entryAmount} onChange={e => setEntryAmount(e.target.value)} style={{ width: 110 }} />
                      </div>
                      <div className={css.formField}>
                        <label className={css.formLabel}>Date</label>
                        <input className={css.formInput} type="date" value={entryDate} onChange={e => setEntryDate(e.target.value)} />
                      </div>
                      <div className={css.formField} style={{ flex: 1 }}>
                        <label className={css.formLabel}>Details</label>
                        <input className={css.formInput} type="text" placeholder="Optional note" value={entryDetails} onChange={e => setEntryDetails(e.target.value)} />
                      </div>
                      <button className={css.btnApply} disabled={savingEntry} onClick={() => submitEntry(b)}>
                        {entryEditId ? 'Save' : 'Log it'}
                      </button>
                      <button className={css.btnCancel} onClick={closeEntryForm}>Cancel</button>
                    </div>
                  )}

                  {b.distributions.length === 0 ? (
                    <div className={css.empty}>No entries logged yet.</div>
                  ) : (
                    <div className={css.tableWrap}>
                      <table className={css.table}>
                        <thead>
                          <tr>
                            <th>Recipient</th>
                            <th>Date</th>
                            <th className={css.num}>Amount</th>
                            <th>Details</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {b.distributions.map(d => (
                            <tr key={d.id}>
                              <td>{memberName(d.member_id)}</td>
                              <td>{d.entry_date}</td>
                              <td className={css.num}>{iqd(d.amount)}</td>
                              <td>{d.details || '—'}</td>
                              <td>
                                <div className={css.rowActions}>
                                  <button className={`${css.iconBtn} ${css.iconBtnEdit}`} onClick={() => openEditEntry(b, d)}>Edit</button>
                                  <button className={`${css.iconBtn} ${css.iconBtnDelete}`} onClick={() => removeEntry(d.id)}>Delete</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}

      {/* ── Everyone: what I personally received ──────────────────────── */}
      <div className={css.sectionTitle}>My received advances</div>
      {myReceived.length === 0 ? (
        <div className={css.empty}>You haven't received any advance payments.</div>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th className={css.num}>Amount</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {myReceived.map(d => (
                <tr key={d.id}>
                  <td>{d.entry_date}</td>
                  <td className={css.num}>{iqd(d.amount)}</td>
                  <td>{d.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Admin: new advance modal ───────────────────────────────────── */}
      {showNewAdv && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setShowNewAdv(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>New Advance</div>
            <div className={css.modalSub}>Assign a lump-sum advance to a team leader to distribute.</div>

            <div className={css.modalField}>
              <label className={css.modalLabel}>Team Leader</label>
              <select className={css.modalSel} value={newLeaderId} onChange={e => setNewLeaderId(e.target.value)}>
                <option value="">Select…</option>
                {activeMembers.map(m => <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>)}
              </select>
            </div>

            <div className={css.modalField}>
              <label className={css.modalLabel}>Total Amount</label>
              <input className={css.modalInput} type="number" min="0" step="0.01" value={newAmount} onChange={e => setNewAmount(e.target.value)} />
            </div>

            <div className={css.modalRow}>
              <div className={css.modalField}>
                <label className={css.modalLabel}>Target Month</label>
                <select className={css.modalSel} value={newMonth} onChange={e => setNewMonth(+e.target.value)}>
                  {FIN_MONTHS.map((mn, i) => <option key={i} value={i + 1}>{mn}</option>)}
                </select>
              </div>
              <div className={css.modalField}>
                <label className={css.modalLabel}>Year</label>
                <select className={css.modalSel} value={newYear} onChange={e => setNewYear(+e.target.value)}>
                  {getYears().map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            <div className={css.modalField}>
              <label className={css.modalLabel}>Reason (optional)</label>
              <input className={css.modalInput} type="text" value={newReason} onChange={e => setNewReason(e.target.value)} placeholder="e.g. site cash advance for materials" />
            </div>

            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setShowNewAdv(false)}>Cancel</button>
              <button className={css.btnApply} disabled={savingAdv} onClick={submitNewAdvance}>
                {savingAdv ? 'Creating…' : 'Create Advance'}
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
