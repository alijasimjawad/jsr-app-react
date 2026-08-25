import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import type { CompanySettings, BankAccount } from '../lib/invoiceTypes';
import goldLogo from '../assets/jsr-communications-gold.png';
import css from './FinBilling.module.css';

// ── Types ─────────────────────────────────────────────────────
interface CompanyForm {
  company_name:  string;
  tagline:       string;
  address_line1: string;
  address_line2: string;
  city:          string;
  country:       string;
  phone:         string;
  email:         string;
  website:       string;
  tax_id:        string;
  logo_url:      string;
}

const EMPTY_COMPANY: CompanyForm = {
  company_name: '', tagline: '', address_line1: '', address_line2: '',
  city: '', country: '', phone: '', email: '', website: '', tax_id: '', logo_url: '',
};

interface BankForm {
  bank_name:      string;
  account_name:   string;
  account_number: string;
  iban:           string;
  swift:          string;
  currency:       string;
  is_default:     boolean;
  is_active:      boolean;
  sort_order:     string;
}

const EMPTY_BANK: BankForm = {
  bank_name: '', account_name: '', account_number: '', iban: '', swift: '',
  // NO real bank data hard-coded here or anywhere in this file. Placeholders
  // in the JSX inputs are deliberately generic. Currency defaults to 'IQD'
  // to match the DB default; user can change it per account.
  currency: 'IQD', is_default: false, is_active: true, sort_order: '0',
};

function isLikelyUrl(s: string): boolean {
  const v = s.trim();
  return /^(https?:)?\/\//i.test(v) || /^data:image\//i.test(v);
}

export default function FinSettings() {
  const { hasPerm, currentUser } = useAuth();

  // ── Company section state ─────────────────────────────────
  const [companyRow,   setCompanyRow]   = useState<CompanySettings | null>(null);
  const [companyForm,  setCompanyForm]  = useState<CompanyForm>(EMPTY_COMPANY);
  const [companySaving, setCompanySaving] = useState(false);
  const [companyErr,   setCompanyErr]   = useState('');

  // ── Bank accounts state ───────────────────────────────────
  const [banks,     setBanks]     = useState<BankAccount[]>([]);
  const [bankModal, setBankModal] = useState(false);
  const [bankEditId, setBankEditId] = useState<string | null>(null);
  const [bankForm,  setBankForm]  = useState<BankForm>(EMPTY_BANK);
  const [bankErr,   setBankErr]   = useState('');

  // Delete-block modal for banks referenced by invoice_payments.
  const [bankDelBlock, setBankDelBlock] = useState<
    { bank: BankAccount; refCount: number } | null
  >(null);

  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // ── Toast ─────────────────────────────────────────────────
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (!hasPerm('view_fin_company_settings')) return <div className={css.errorMsg}>Access denied.</div>;

  function showToast(msg: string, ok: boolean) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const [cs, ba] = await Promise.all([
      supabase.from('company_settings').select('*').limit(1).maybeSingle(),
      supabase.from('bank_accounts').select('*').order('sort_order').order('bank_name'),
    ]);
    if (cs.error) { setError(cs.error.message); setLoading(false); return; }
    const row = (cs.data as CompanySettings | null) || null;
    setCompanyRow(row);
    if (row) {
      setCompanyForm({
        company_name:  row.company_name  || '',
        tagline:       row.tagline       || '',
        address_line1: row.address_line1 || '',
        address_line2: row.address_line2 || '',
        city:          row.city          || '',
        country:       row.country       || '',
        phone:         row.phone         || '',
        email:         row.email         || '',
        website:       row.website       || '',
        tax_id:        row.tax_id        || '',
        logo_url:      row.logo_url      || '',
      });
    } else {
      setCompanyForm(EMPTY_COMPANY);
    }
    setBanks((ba.data || []) as BankAccount[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Company save ──────────────────────────────────────────
  async function saveCompany() {
    setCompanyErr('');
    if (!companyForm.company_name.trim()) {
      setCompanyErr('Company name is required.');
      return;
    }
    setCompanySaving(true);
    const payload = {
      company_name:  companyForm.company_name.trim(),
      tagline:       companyForm.tagline.trim()       || null,
      address_line1: companyForm.address_line1.trim() || null,
      address_line2: companyForm.address_line2.trim() || null,
      city:          companyForm.city.trim()          || null,
      country:       companyForm.country.trim()       || null,
      phone:         companyForm.phone.trim()         || null,
      email:         companyForm.email.trim()         || null,
      website:       companyForm.website.trim()       || null,
      tax_id:        companyForm.tax_id.trim()        || null,
      logo_url:      companyForm.logo_url.trim()      || null,
      updated_at:    new Date().toISOString(),
      updated_by:    currentUser?.full_name || null,
    };
    if (companyRow) {
      const { data, error: e } = await supabase.from('company_settings').update(payload).eq('id', companyRow.id).select('*').single();
      setCompanySaving(false);
      if (e) { setCompanyErr(e.message); return; }
      setCompanyRow(data as CompanySettings);
      showToast('Company settings saved.', true);
    } else {
      // Phase 2 seeds one row, so this branch is defensive-only. If a fresh
      // environment somehow has no company_settings row we insert one
      // instead of silently failing on the update path.
      const { data, error: e } = await supabase.from('company_settings').insert(payload).select('*').single();
      setCompanySaving(false);
      if (e) { setCompanyErr(e.message); return; }
      setCompanyRow(data as CompanySettings);
      showToast('Company settings created.', true);
    }
  }

  // ── Bank modal ────────────────────────────────────────────
  function openBankAdd() {
    setBankEditId(null);
    setBankForm(EMPTY_BANK);
    setBankErr('');
    setBankModal(true);
  }

  function openBankEdit(b: BankAccount) {
    setBankEditId(b.id);
    setBankForm({
      bank_name:      b.bank_name      || '',
      account_name:   b.account_name   || '',
      account_number: b.account_number || '',
      iban:           b.iban           || '',
      swift:          b.swift          || '',
      currency:       b.currency       || 'IQD',
      is_default:     !!b.is_default,
      is_active:      !!b.is_active,
      sort_order:     String(b.sort_order ?? 0),
    });
    setBankErr('');
    setBankModal(true);
  }

  async function saveBank() {
    setBankErr('');
    if (!bankForm.bank_name.trim()) { setBankErr('Bank name is required.'); return; }
    const currency = bankForm.currency.trim().toUpperCase() || 'IQD';
    const sortOrd = parseInt(bankForm.sort_order, 10);
    const payload = {
      bank_name:      bankForm.bank_name.trim(),
      account_name:   bankForm.account_name.trim()   || null,
      account_number: bankForm.account_number.trim() || null,
      iban:           bankForm.iban.trim()           || null,
      swift:          bankForm.swift.trim()          || null,
      currency,
      is_default:     bankForm.is_default,
      is_active:      bankForm.is_active,
      sort_order:     isNaN(sortOrd) ? 0 : sortOrd,
    };

    // Default-per-currency invariant. The DB does not enforce a partial
    // unique index on (currency, is_default) — so if the user toggles this
    // account as the new default we first clear any other default row for
    // the same currency. Two separate statements (clear → save) instead of
    // one because Supabase doesn't expose a multi-statement transaction
    // from the browser client; the small race window is acceptable here
    // (admin-only mutation, no concurrent writers in practice).
    if (payload.is_default) {
      const clear = supabase.from('bank_accounts').update({ is_default: false })
        .eq('currency', currency)
        .eq('is_default', true);
      if (bankEditId) clear.neq('id', bankEditId);
      const { error: e } = await clear;
      if (e) { setBankErr(e.message); return; }
    }

    if (bankEditId) {
      const { data, error: e } = await supabase.from('bank_accounts').update(payload).eq('id', bankEditId).select('*').single();
      if (e) { setBankErr(e.message); return; }
      setBanks(list => {
        const next = list.map(b => b.id === bankEditId ? (data as BankAccount) : b);
        // If a new default was set, mirror the DB clear locally so the UI
        // shows exactly one default per currency without a full reload.
        if (payload.is_default) {
          return next.map(b => b.currency === currency && b.id !== bankEditId ? { ...b, is_default: false } : b);
        }
        return next;
      });
      showToast('Bank account updated.', true);
    } else {
      const { data, error: e } = await supabase.from('bank_accounts').insert(payload).select('*').single();
      if (e) { setBankErr(e.message); return; }
      setBanks(list => {
        const withNew = [...list, data as BankAccount];
        if (payload.is_default) {
          return withNew.map(b => b.currency === currency && b.id !== (data as BankAccount).id ? { ...b, is_default: false } : b);
        }
        return withNew;
      });
      showToast('Bank account added!', true);
    }
    setBankModal(false);
  }

  async function tryDeleteBank(b: BankAccount) {
    const { count, error: e } = await supabase.from('invoice_payments')
      .select('id', { count: 'exact', head: true }).eq('bank_account_id', b.id);
    if (e) { showToast(e.message, false); return; }
    const refCount = count || 0;
    if (refCount > 0) {
      setBankDelBlock({ bank: b, refCount });
      return;
    }
    if (!window.confirm(`Delete bank account "${b.bank_name}"?`)) return;
    const { error: de } = await supabase.from('bank_accounts').delete().eq('id', b.id);
    if (de) { showToast(de.message, false); return; }
    setBanks(list => list.filter(x => x.id !== b.id));
    showToast('Bank account deleted.', true);
  }

  async function deactivateBank(b: BankAccount) {
    const { data, error: e } = await supabase.from('bank_accounts')
      .update({ is_active: false }).eq('id', b.id).select('*').single();
    if (e) { showToast(e.message, false); return; }
    setBanks(list => list.map(x => x.id === b.id ? (data as BankAccount) : x));
    setBankDelBlock(null);
    showToast('Bank account deactivated.', true);
  }

  if (loading) return <div className={css.placeholder}>Loading…</div>;
  if (error)   return <div className={css.errorMsg}>{error}</div>;

  const canEdit = hasPerm('edit_fin_company_settings');
  const previewLogoSrc = isLikelyUrl(companyForm.logo_url) ? companyForm.logo_url.trim() : goldLogo;
  const usingFallback = !isLikelyUrl(companyForm.logo_url);

  return (
    <div className={css.page}>
      {/* Header */}
      <div className={css.pageHdr}>
        <div className={css.pageTitle}>Company Settings</div>
        <div className={css.hdrActions}>
          <button className={css.btnGhost} onClick={load}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            Refresh
          </button>
        </div>
      </div>

      {/* Company Invoice Settings */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 18, marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: '#1e293b', marginBottom: 14 }}>Company Invoice Settings</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 200px', gap: 24 }}>
          <div className={css.formGrid}>
            <div className={`${css.formField} ${css.span2}`}>
              <label>Company Name *</label>
              <input className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.company_name} onChange={e => setCompanyForm(f => ({ ...f, company_name: e.target.value }))} />
            </div>
            <div className={`${css.formField} ${css.span2}`}>
              <label>Tagline</label>
              <input className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.tagline} onChange={e => setCompanyForm(f => ({ ...f, tagline: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Address Line 1</label>
              <input className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.address_line1} onChange={e => setCompanyForm(f => ({ ...f, address_line1: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Address Line 2</label>
              <input className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.address_line2} onChange={e => setCompanyForm(f => ({ ...f, address_line2: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>City</label>
              <input className={css.formInput} maxLength={100} disabled={!canEdit}
                value={companyForm.city} onChange={e => setCompanyForm(f => ({ ...f, city: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Country</label>
              <input className={css.formInput} maxLength={100} disabled={!canEdit}
                value={companyForm.country} onChange={e => setCompanyForm(f => ({ ...f, country: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Phone</label>
              <input className={css.formInput} maxLength={40} disabled={!canEdit}
                value={companyForm.phone} onChange={e => setCompanyForm(f => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Email</label>
              <input type="email" className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.email} onChange={e => setCompanyForm(f => ({ ...f, email: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Website</label>
              <input className={css.formInput} maxLength={200} disabled={!canEdit}
                value={companyForm.website} onChange={e => setCompanyForm(f => ({ ...f, website: e.target.value }))} />
            </div>
            <div className={css.formField}>
              <label>Tax ID</label>
              <input className={css.formInput} maxLength={80} disabled={!canEdit}
                value={companyForm.tax_id} onChange={e => setCompanyForm(f => ({ ...f, tax_id: e.target.value }))} />
            </div>
            <div className={`${css.formField} ${css.span2}`}>
              <label>Logo URL</label>
              <input className={css.formInput} maxLength={500} placeholder="https://… (leave blank to use default)" disabled={!canEdit}
                value={companyForm.logo_url} onChange={e => setCompanyForm(f => ({ ...f, logo_url: e.target.value }))} />
            </div>
          </div>

          {/* Logo preview */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 8 }}>
              Logo Preview
            </div>
            <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 14, background: '#f8fafc', textAlign: 'center' }}>
              <img
                src={previewLogoSrc}
                alt="Company logo preview"
                style={{ maxWidth: '100%', maxHeight: 120, objectFit: 'contain' }}
                onError={e => { (e.currentTarget as HTMLImageElement).src = goldLogo; }}
              />
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8 }}>
                {usingFallback ? 'Default (JSR Communications gold)' : 'From logo_url'}
              </div>
            </div>
          </div>
        </div>

        {companyErr && <div className={css.modalErr}>{companyErr}</div>}
        {canEdit && (
          <div className={css.modalActions} style={{ marginTop: 16 }}>
            <button className={css.btnSave} disabled={companySaving} onClick={saveCompany}>
              {companySaving ? 'Saving…' : 'Save Company Settings'}
            </button>
          </div>
        )}
      </div>

      {/* Bank Accounts */}
      <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: '#1e293b' }}>Bank Accounts</div>
          {canEdit && (
            <button className={css.btnAccent} onClick={openBankAdd}>+ Add Bank Account</button>
          )}
        </div>

        <div className={css.tableWrap}>
          <table className={css.table} style={{ fontSize: 12 }}>
            <thead><tr>
              <th>Bank Name</th>
              <th>Account Name</th>
              <th>Currency</th>
              <th>Default</th>
              <th>Active</th>
              <th className={css.num}>Sort</th>
              {canEdit && <th>Actions</th>}
            </tr></thead>
            <tbody>
              {banks.length === 0
                ? <tr><td colSpan={canEdit ? 7 : 6} className={css.empty}>No bank accounts yet.{canEdit ? ' Click "+ Add Bank Account" to add one.' : ''}</td></tr>
                : banks.map(b => (
                    <tr key={b.id}>
                      <td style={{ fontWeight: 700 }}>{b.bank_name}</td>
                      <td style={{ color: '#64748b' }}>{b.account_name || '—'}</td>
                      <td>{b.currency}</td>
                      <td>{b.is_default
                        ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: '#dbeafe', color: '#1d4ed8' }}>Default</span>
                        : <span style={{ color: '#94a3b8' }}>—</span>}
                      </td>
                      <td>{b.is_active
                        ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: '#dcfce7', color: '#16a34a' }}>Active</span>
                        : <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: '#f1f5f9', color: '#64748b' }}>Inactive</span>}
                      </td>
                      <td className={css.num}>{b.sort_order}</td>
                      {canEdit && (
                        <td>
                          <div className={css.actWrap}>
                            <button className={css.actBtn} title="Edit" onClick={() => openBankEdit(b)}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            </button>
                            <button className={`${css.actBtn} ${css.actBtnDel}`} title="Delete" onClick={() => tryDeleteBank(b)}>
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))
              }
            </tbody>
          </table>
        </div>
      </div>

      {/* Bank Add/Edit Modal */}
      {bankModal && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setBankModal(false); }}>
          <div className={css.modal}>
            <div className={css.modalTitle}>{bankEditId ? 'Edit Bank Account' : 'Add Bank Account'}</div>
            <div className={css.formGrid}>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Bank Name *</label>
                <input className={css.formInput} maxLength={200} placeholder="e.g. Rafidain Bank"
                  value={bankForm.bank_name} onChange={e => setBankForm(f => ({ ...f, bank_name: e.target.value }))} />
              </div>
              <div className={`${css.formField} ${css.span2}`}>
                <label>Account Name</label>
                <input className={css.formInput} maxLength={200} placeholder="Account holder name"
                  value={bankForm.account_name} onChange={e => setBankForm(f => ({ ...f, account_name: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Account Number</label>
                <input className={css.formInput} maxLength={100}
                  value={bankForm.account_number} onChange={e => setBankForm(f => ({ ...f, account_number: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Currency</label>
                <input className={css.formInput} maxLength={8}
                  value={bankForm.currency} onChange={e => setBankForm(f => ({ ...f, currency: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>IBAN</label>
                <input className={css.formInput} maxLength={80}
                  value={bankForm.iban} onChange={e => setBankForm(f => ({ ...f, iban: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>SWIFT / BIC</label>
                <input className={css.formInput} maxLength={40}
                  value={bankForm.swift} onChange={e => setBankForm(f => ({ ...f, swift: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>Sort Order</label>
                <input type="number" className={css.formInput}
                  value={bankForm.sort_order} onChange={e => setBankForm(f => ({ ...f, sort_order: e.target.value }))} />
              </div>
              <div className={css.formField}>
                <label>&nbsp;</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', fontWeight: 500 }}>
                    <input type="checkbox" checked={bankForm.is_default}
                      onChange={e => setBankForm(f => ({ ...f, is_default: e.target.checked }))} />
                    Default for this currency
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#334155', fontWeight: 500 }}>
                    <input type="checkbox" checked={bankForm.is_active}
                      onChange={e => setBankForm(f => ({ ...f, is_active: e.target.checked }))} />
                    Active
                  </label>
                </div>
              </div>
            </div>
            {bankErr && <div className={css.modalErr}>{bankErr}</div>}
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setBankModal(false)}>Cancel</button>
              <button className={css.btnSave} onClick={saveBank}>Save</button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Delete-blocked modal */}
      {bankDelBlock && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget) setBankDelBlock(null); }}>
          <div className={css.modal}>
            <div className={css.modalTitle} style={{ color: '#dc2626' }}>Delete Blocked</div>
            <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>
              This bank account (<strong>{bankDelBlock.bank.bank_name}</strong>) is referenced by{' '}
              <strong>{bankDelBlock.refCount}</strong> payment record{bankDelBlock.refCount === 1 ? '' : 's'}.
              <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>
                Deactivating the account keeps historical payment records intact while hiding it from new payment entry.
              </div>
            </div>
            <div className={css.modalActions}>
              <button className={css.btnCancel} onClick={() => setBankDelBlock(null)}>Close</button>
              {canEdit && bankDelBlock.bank.is_active && (
                <button className={css.btnSave} onClick={() => deactivateBank(bankDelBlock.bank)}>Deactivate</button>
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
