import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { logActivity } from '../lib/activityLog';
import { sendPushToRoles, sendPushToUser } from '../lib/pushNotify';
import { ensureProjectsLoaded, getProjectNames } from '../lib/projectsCache';
import {
  PHOTO_SLOTS, STATUS_LABELS, FEASIBILITY_LABELS, MOUNTING_OPTIONS,
  fetchSurveys, fetchPhotos, createSurvey, updateSurvey, submitSurvey, reviewSurvey,
  deleteSurvey, uploadPhoto, deletePhoto, signedUrls, missingRequiredSlots,
  type SiteSurvey, type SurveyPhoto, type SurveyInput, type SurveyStatus,
} from '../lib/siteSurveys';
import css from './SiteSurveys.module.css';

// Site Surveys — per-court surveys (e.g. Keystone installation) filled in by
// engineers/technicians from their phones, with required photos, then
// reviewed (approved / returned with a comment) by an admin. See
// docs/go-live/26_add_site_surveys.sql for the table/RLS/storage design.

const GOVERNORATES = [
  'Baghdad', 'Basra', 'Nineveh', 'Erbil', 'Sulaymaniyah', 'Duhok', 'Kirkuk', 'Anbar', 'Diyala',
  'Salah al-Din', 'Babil', 'Karbala', 'Najaf', 'Qadisiyyah', 'Muthanna', 'Dhi Qar', 'Maysan', 'Wasit', 'Halabja',
];

type FormState = Omit<SurveyInput, 'latitude' | 'longitude'> & { latitude: string; longitude: string };

function emptyForm(): FormState {
  return {
    project_name: '', court_name: '', court_id: '', governorate: '', address: '',
    latitude: '', longitude: '', survey_date: new Date().toISOString().slice(0, 10),
    court_type: '', dimensions: '', existing_cabling: '', existing_cabling_notes: '',
    power_available: '', power_distance: '', mounting_surface: '', mounting_height: '',
    access_constraints: '', contact_person: '', contact_phone: '', required_materials: '',
    notes: '', feasibility: '',
  };
}

function formFromSurvey(s: SiteSurvey): FormState {
  return {
    project_name: s.project_name ?? '', court_name: s.court_name ?? '', court_id: s.court_id ?? '',
    governorate: s.governorate ?? '', address: s.address ?? '',
    latitude: s.latitude != null ? String(s.latitude) : '', longitude: s.longitude != null ? String(s.longitude) : '',
    survey_date: s.survey_date, court_type: s.court_type ?? '', dimensions: s.dimensions ?? '',
    existing_cabling: s.existing_cabling ?? '', existing_cabling_notes: s.existing_cabling_notes ?? '',
    power_available: s.power_available ?? '', power_distance: s.power_distance ?? '',
    mounting_surface: s.mounting_surface ?? '', mounting_height: s.mounting_height ?? '',
    access_constraints: s.access_constraints ?? '', contact_person: s.contact_person ?? '',
    contact_phone: s.contact_phone ?? '', required_materials: s.required_materials ?? '',
    notes: s.notes ?? '', feasibility: s.feasibility ?? '',
  };
}

// '' -> null, numeric strings -> numbers, everything else trimmed.
function toInput(f: FormState): SurveyInput {
  const n = (v: string) => (v.trim() === '' || isNaN(+v) ? null : +v);
  const t = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return {
    project_name: t(f.project_name), court_name: f.court_name.trim(), court_id: t(f.court_id),
    governorate: t(f.governorate), address: t(f.address),
    latitude: n(f.latitude), longitude: n(f.longitude), survey_date: f.survey_date,
    court_type: t(f.court_type), dimensions: t(f.dimensions),
    existing_cabling: t(f.existing_cabling), existing_cabling_notes: t(f.existing_cabling_notes),
    power_available: t(f.power_available), power_distance: t(f.power_distance),
    mounting_surface: t(f.mounting_surface), mounting_height: t(f.mounting_height),
    access_constraints: t(f.access_constraints), contact_person: t(f.contact_person),
    contact_phone: t(f.contact_phone), required_materials: t(f.required_materials),
    notes: t(f.notes), feasibility: t(f.feasibility),
  };
}

export default function SiteSurveys() {
  const { currentUser, hasPerm } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const myId = currentUser?.id ?? '';

  const [surveys, setSurveys] = useState<SiteSurvey[]>([]);
  const [allPhotos, setAllPhotos] = useState<SurveyPhoto[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [projects, setProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');

  const [fStatus, setFStatus] = useState<'' | SurveyStatus>('');
  const [fProject, setFProject] = useState('');
  const [q, setQ] = useState('');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploadingSlot, setUploadingSlot] = useState<string | null>(null);
  const [formErr, setFormErr] = useState('');
  const [reviewComment, setReviewComment] = useState('');
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(msg: string, ok = true) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, ok });
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }

  async function loadAll() {
    setLoading(true); setLoadErr('');
    try {
      const [s, p, u] = await Promise.all([
        fetchSurveys(),
        fetchPhotos(),
        supabase.from('users').select('id, full_name'),
      ]);
      setSurveys(s);
      setAllPhotos(p);
      const m: Record<string, string> = {};
      for (const r of (u.data || []) as { id: string; full_name: string }[]) m[r.id] = r.full_name;
      setNames(m);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    ensureProjectsLoaded().then(() => setProjects(getProjectNames()));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const editing = editId ? surveys.find(s => s.id === editId) ?? null : null;
  const editPhotos = editId ? allPhotos.filter(p => p.survey_id === editId) : [];
  const status: SurveyStatus = editing?.status ?? 'draft';
  const isOwner = !editing || editing.created_by === myId;
  const canEdit = isAdmin || (isOwner && (status === 'draft' || status === 'returned'));
  const nameOf = (id: string | null) => (id ? names[id] ?? '—' : '—');

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return surveys.filter(s =>
      (!fStatus || s.status === fStatus) &&
      (!fProject || s.project_name === fProject) &&
      (!needle || [s.court_name, s.court_id, s.governorate, s.address].some(v => (v ?? '').toLowerCase().includes(needle))));
  }, [surveys, fStatus, fProject, q]);

  async function refreshUrls(photos: SurveyPhoto[]) {
    const m = await signedUrls(photos.map(p => p.storage_path));
    setUrls(prev => ({ ...prev, ...m }));
  }

  function openNew() {
    setEditId(null);
    setForm({ ...emptyForm(), project_name: fProject });
    setFormErr(''); setReviewComment(''); setUrls({});
    setEditorOpen(true);
  }

  function openEdit(s: SiteSurvey) {
    setEditId(s.id);
    setForm(formFromSurvey(s));
    setFormErr(''); setReviewComment(s.review_comment ?? '');
    setEditorOpen(true);
    refreshUrls(allPhotos.filter(p => p.survey_id === s.id));
  }

  function closeEditor() { setEditorOpen(false); setEditId(null); }

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }));

  function useMyLocation() {
    if (!navigator.geolocation) { showToast('Location is not available on this device.', false); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        set('latitude', pos.coords.latitude.toFixed(6));
        set('longitude', pos.coords.longitude.toFixed(6));
      },
      err => showToast('Could not get location: ' + err.message, false),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  // Creates the draft if new, otherwise updates it. Returns the survey id.
  // A non-admin saving a 'returned' survey moves it back to 'draft' (the
  // database only lets field users leave it as draft/submitted).
  async function persist(): Promise<string | null> {
    if (!form.court_name.trim()) { setFormErr('Court name is required.'); return null; }
    if (!currentUser) { setFormErr('Not signed in.'); return null; }
    const input = toInput(form);
    if (!editId) {
      const { id, error } = await createSurvey(input, currentUser.id);
      if (error || !id) { setFormErr('Save failed: ' + (error ?? 'unknown error')); return null; }
      setEditId(id);
      await reloadSurveys();
      return id;
    }
    const patch: Partial<SiteSurvey> = { ...input };
    if (!isAdmin && status === 'returned') patch.status = 'draft';
    const { error } = await updateSurvey(editId, patch);
    if (error) { setFormErr('Save failed: ' + error); return null; }
    await reloadSurveys();
    return editId;
  }

  async function reloadSurveys() {
    const [s, p] = await Promise.all([fetchSurveys(), fetchPhotos()]);
    setSurveys(s); setAllPhotos(p);
  }

  async function saveDraft() {
    setFormErr(''); setBusy(true);
    const id = await persist();
    setBusy(false);
    if (id) showToast('Draft saved.');
  }

  function validateForSubmit(photos: SurveyPhoto[]): string | null {
    const miss: string[] = [];
    if (!form.court_name.trim()) miss.push('Court name');
    if (!(form.governorate ?? '').trim()) miss.push('Governorate');
    if (!form.court_type) miss.push('Court type');
    if (!form.power_available) miss.push('Power available');
    if (!form.mounting_surface) miss.push('Mounting surface');
    if (!form.feasibility) miss.push('Result (feasibility)');
    if (miss.length) return 'Fill in: ' + miss.join(', ') + '.';
    const slots = missingRequiredSlots(photos);
    if (slots.length) return 'Missing required photos: ' + slots.map(s => s.label).join('; ') + '.';
    return null;
  }

  async function submit() {
    setFormErr('');
    const err = validateForSubmit(editPhotos);
    if (err) { setFormErr(err); return; }
    setBusy(true);
    const id = await persist();
    if (!id) { setBusy(false); return; }
    // persist() may have turned 'returned' into 'draft'; submit from there.
    const { error } = await submitSurvey(id);
    setBusy(false);
    if (error) { setFormErr('Submit failed: ' + error); return; }
    showToast('Survey submitted for review.');
    void sendPushToRoles(['admin'], 'Site Survey Submitted', `${form.court_name.trim()} — ${currentUser?.full_name ?? ''}`);
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Submitted Site Survey',
      projectName: form.project_name || null,
      details: `Court: ${form.court_name.trim()}`,
    });
    await reloadSurveys();
    closeEditor();
  }

  async function review(decision: 'approved' | 'returned') {
    if (!editing || !currentUser) return;
    if (decision === 'returned' && !reviewComment.trim()) { setFormErr('Add a comment explaining what to fix.'); return; }
    setFormErr(''); setBusy(true);
    const { error } = await reviewSurvey(editing.id, decision, currentUser.id, reviewComment.trim() || null);
    setBusy(false);
    if (error) { setFormErr('Review failed: ' + error); return; }
    showToast(decision === 'approved' ? 'Survey approved.' : 'Survey returned to surveyor.');
    if (editing.created_by) {
      void sendPushToUser(editing.created_by,
        decision === 'approved' ? 'Site Survey Approved' : 'Site Survey Returned',
        `${editing.court_name}${decision === 'returned' ? ' — ' + reviewComment.trim() : ''}`);
    }
    logActivity({
      userFullName: currentUser.full_name ?? currentUser.username,
      action: decision === 'approved' ? 'Approved Site Survey' : 'Returned Site Survey',
      projectName: editing.project_name,
      details: `Court: ${editing.court_name}`,
    });
    await reloadSurveys();
    closeEditor();
  }

  async function remove() {
    if (!editing) return;
    if (!window.confirm(`Delete the survey for "${editing.court_name}" and its photos? This cannot be undone.`)) return;
    setBusy(true);
    const { error } = await deleteSurvey(editing.id, editPhotos);
    setBusy(false);
    if (error) { setFormErr('Delete failed: ' + error); return; }
    showToast('Survey deleted.');
    logActivity({
      userFullName: currentUser?.full_name ?? currentUser?.username,
      action: 'Deleted Site Survey', projectName: editing.project_name, details: `Court: ${editing.court_name}`,
    });
    await reloadSurveys();
    closeEditor();
  }

  async function onPickFiles(slotKey: string, multiple: boolean, files: File[]) {
    if (files.length === 0 || !currentUser) return;
    setFormErr('');
    setUploadingSlot(slotKey);
    try {
      // First photo on a brand-new survey: save the draft so it has an id.
      let id = editId;
      if (!id) { id = await persist(); if (!id) return; }
      const list = multiple ? files : [files[0]];
      // Single-photo slots replace the existing photo.
      if (!multiple) {
        for (const old of allPhotos.filter(p => p.survey_id === id && p.slot === slotKey)) await deletePhoto(old);
      }
      for (const f of list) {
        const { error } = await uploadPhoto(id, slotKey, f, currentUser.id);
        if (error) { setFormErr('Photo upload failed: ' + error); break; }
      }
      const p = await fetchPhotos();
      setAllPhotos(p);
      await refreshUrls(p.filter(x => x.survey_id === id));
    } finally {
      setUploadingSlot(null);
    }
  }

  async function removePhoto(p: SurveyPhoto) {
    const { error } = await deletePhoto(p);
    if (error) { setFormErr('Delete photo failed: ' + error); return; }
    setAllPhotos(prev => prev.filter(x => x.id !== p.id));
  }

  async function exportPdf() {
    if (!editing) return;
    setBusy(true);
    try {
      const photos = allPhotos.filter(p => p.survey_id === editing.id);
      const u = await signedUrls(photos.map(p => p.storage_path));
      const { generateSurveyPdf } = await import('../pdf/generateSurveyPdf');
      await generateSurveyPdf({
        survey: editing, photos, urls: u,
        surveyorName: nameOf(editing.created_by), reviewerName: nameOf(editing.reviewed_by),
      });
    } catch (e) {
      console.error('PDF export failed:', e);
      showToast('PDF export failed: ' + (e instanceof Error ? e.message : String(e)), false);
    } finally {
      setBusy(false);
    }
  }

  async function exportExcel() {
    if (!filtered.length) { showToast('No surveys to export.', false); return; }
    try {
      const XLSX = await import('xlsx');
      const yn = (v: string | null) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '');
      const rows: (string | number)[][] = [[
        'Project', 'Court name', 'Court ID', 'Governorate', 'Address', 'Latitude', 'Longitude', 'Survey date',
        'Court type', 'Dimensions', 'Existing cabling', 'Cabling notes', 'Power available', 'Power distance',
        'Mounting surface', 'Mounting height', 'Access constraints', 'Contact person', 'Contact phone',
        'Required materials', 'Notes', 'Result', 'Status', 'Photos (required done)', 'Surveyor',
        'Submitted at', 'Reviewed by', 'Reviewed at', 'Review comment',
      ]];
      for (const s of filtered) {
        const ph = allPhotos.filter(p => p.survey_id === s.id);
        const reqDone = PHOTO_SLOTS.filter(x => x.required && ph.some(p => p.slot === x.key)).length;
        rows.push([
          s.project_name ?? '', s.court_name, s.court_id ?? '', s.governorate ?? '', s.address ?? '',
          s.latitude ?? '', s.longitude ?? '', s.survey_date, s.court_type ?? '', s.dimensions ?? '',
          yn(s.existing_cabling), s.existing_cabling_notes ?? '', yn(s.power_available), s.power_distance ?? '',
          s.mounting_surface ?? '', s.mounting_height ?? '', s.access_constraints ?? '', s.contact_person ?? '',
          s.contact_phone ?? '', s.required_materials ?? '', s.notes ?? '',
          FEASIBILITY_LABELS[s.feasibility ?? ''] ?? '', STATUS_LABELS[s.status],
          `${ph.length} (${reqDone}/${PHOTO_SLOTS.filter(x => x.required).length})`,
          nameOf(s.created_by), s.submitted_at ?? '', nameOf(s.reviewed_by), s.reviewed_at ?? '', s.review_comment ?? '',
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = rows[0].map(() => ({ wch: 20 }));
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Site Surveys');
      XLSX.writeFile(wb, `Site_Surveys_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      showToast('Export failed: ' + (e instanceof Error ? e.message : String(e)), false);
    }
  }

  // Permission gate sits after every hook above (Rules of Hooks).
  if (!hasPerm('view_site_surveys')) {
    return <div className={css.empty}>You don't have permission to view Site Surveys.</div>;
  }

  const reqTotal = PHOTO_SLOTS.filter(s => s.required).length;
  const photoProgress = (id: string) => {
    const ph = allPhotos.filter(p => p.survey_id === id);
    return PHOTO_SLOTS.filter(s => s.required && ph.some(p => p.slot === s.key)).length;
  };

  const fld = (label: string, node: React.ReactNode, opts?: { req?: boolean; full?: boolean }) => (
    <div className={`${css.field} ${opts?.full ? css.full : ''}`}>
      <label className={css.label}>{label}{opts?.req && <span className={css.req}> *</span>}</label>
      {node}
    </div>
  );

  const ro = !canEdit;

  return (
    <div className={css.page}>
      <div className={css.toolbar}>
        <input className={css.search} placeholder="Search court, ID, governorate…" value={q} onChange={e => setQ(e.target.value)} />
        <select className={css.sel} value={fStatus} onChange={e => setFStatus(e.target.value as '' | SurveyStatus)}>
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABELS) as SurveyStatus[]).map(k => <option key={k} value={k}>{STATUS_LABELS[k]}</option>)}
        </select>
        <select className={css.sel} value={fProject} onChange={e => setFProject(e.target.value)}>
          <option value="">All projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className={css.spacer} />
        <button className={css.btnGhost} onClick={loadAll}>↺ Refresh</button>
        <button className={css.btnGhost} onClick={exportExcel}>Export Excel</button>
        <button className={css.btnPrimary} onClick={openNew}>+ New Survey</button>
      </div>

      {loadErr && <div className={css.errorMsg}>{loadErr}</div>}
      {loading ? <div className={css.loading}>Loading…</div> : filtered.length === 0 ? (
        <div className={css.empty}>{surveys.length === 0 ? 'No surveys yet. Tap “+ New Survey” to start one.' : 'No surveys match the filters.'}</div>
      ) : (
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th>Court</th><th className={css.hideSm}>Project</th><th className={css.hideSm}>Governorate</th>
                <th className={css.hideSm}>Date</th><th className={css.hideSm}>Surveyor</th><th>Photos</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const done = photoProgress(s.id);
                return (
                  <tr key={s.id} className={css.rowClick} onClick={() => openEdit(s)}>
                    <td><strong>{s.court_name}</strong>{s.court_id && <div className={css.sub}>{s.court_id}</div>}</td>
                    <td className={css.hideSm}>{s.project_name || '—'}</td>
                    <td className={css.hideSm}>{s.governorate || '—'}</td>
                    <td className={css.hideSm}>{s.survey_date}</td>
                    <td className={css.hideSm}>{nameOf(s.created_by)}</td>
                    <td><span className={`${css.photoCount} ${done === reqTotal ? css.photoOk : css.photoMissing}`}>{done}/{reqTotal}</span></td>
                    <td><span className={`${css.badge} ${css['b_' + s.status]}`}>{STATUS_LABELS[s.status]}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editorOpen && createPortal(
        <div className={css.overlay} onClick={e => { if (e.target === e.currentTarget && !busy) closeEditor(); }}>
          <div className={css.modal}>
            <div className={css.modalHdr}>
              <div className={css.modalTitle}>{editing ? editing.court_name : 'New Site Survey'}</div>
              {editing && <span className={`${css.badge} ${css['b_' + status]}`}>{STATUS_LABELS[status]}</span>}
              <button className={css.closeBtn} onClick={closeEditor} aria-label="Close">×</button>
            </div>

            <div className={css.modalBody}>
              {editing?.status === 'returned' && editing.review_comment && (
                <div className={`${css.reviewBox} ${css.returned}`}>
                  <strong>Returned by {nameOf(editing.reviewed_by)}:</strong> {editing.review_comment}
                </div>
              )}
              {ro && !isAdmin && (
                <div className={css.warn}>
                  {isOwner ? 'This survey is locked while it is under review or approved.' : 'You can only view this survey.'}
                </div>
              )}

              <div className={css.secTitle}>Court</div>
              <div className={css.grid2}>
                {fld('Project', (
                  <select className={css.select} disabled={ro} value={form.project_name ?? ''} onChange={e => set('project_name', e.target.value)}>
                    <option value="">— Select project —</option>
                    {projects.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                ))}
                {fld('Survey date', <input className={css.input} type="date" disabled={ro} value={form.survey_date} onChange={e => set('survey_date', e.target.value)} />)}
                {fld('Court name', <input className={css.input} disabled={ro} value={form.court_name} onChange={e => set('court_name', e.target.value)} />, { req: true })}
                {fld('Court ID', <input className={css.input} disabled={ro} value={form.court_id ?? ''} onChange={e => set('court_id', e.target.value)} />)}
                {fld('Governorate', (
                  <>
                    <input className={css.input} list="sv-gov" disabled={ro} value={form.governorate ?? ''} onChange={e => set('governorate', e.target.value)} />
                    <datalist id="sv-gov">{GOVERNORATES.map(g => <option key={g} value={g} />)}</datalist>
                  </>
                ), { req: true })}
                {fld('Address / landmark', <input className={css.input} disabled={ro} value={form.address ?? ''} onChange={e => set('address', e.target.value)} />)}
                {fld('GPS location', (
                  <div className={css.gpsRow}>
                    <input className={css.input} placeholder="Latitude" inputMode="decimal" disabled={ro} value={form.latitude} onChange={e => set('latitude', e.target.value)} />
                    <input className={css.input} placeholder="Longitude" inputMode="decimal" disabled={ro} value={form.longitude} onChange={e => set('longitude', e.target.value)} />
                    {!ro && <button type="button" className={css.btnGhost} onClick={useMyLocation}>📍</button>}
                  </div>
                ), { full: true })}
              </div>

              <div className={css.secTitle}>Technical</div>
              <div className={css.grid2}>
                {fld('Court type', (
                  <select className={css.select} disabled={ro} value={form.court_type ?? ''} onChange={e => set('court_type', e.target.value)}>
                    <option value="">— Select —</option><option value="indoor">Indoor</option><option value="outdoor">Outdoor</option>
                  </select>
                ), { req: true })}
                {fld('Approx. dimensions', <input className={css.input} placeholder="e.g. 28 × 15 m" disabled={ro} value={form.dimensions ?? ''} onChange={e => set('dimensions', e.target.value)} />)}
                {fld('Existing network / cabling', (
                  <select className={css.select} disabled={ro} value={form.existing_cabling ?? ''} onChange={e => set('existing_cabling', e.target.value)}>
                    <option value="">— Select —</option><option value="yes">Yes</option><option value="no">No</option>
                  </select>
                ))}
                {fld('Cabling notes', <input className={css.input} disabled={ro} value={form.existing_cabling_notes ?? ''} onChange={e => set('existing_cabling_notes', e.target.value)} />)}
                {fld('Power available near install location', (
                  <select className={css.select} disabled={ro} value={form.power_available ?? ''} onChange={e => set('power_available', e.target.value)}>
                    <option value="">— Select —</option><option value="yes">Yes</option><option value="no">No</option>
                  </select>
                ), { req: true })}
                {fld('Distance to power', <input className={css.input} placeholder="e.g. 5 m" disabled={ro} value={form.power_distance ?? ''} onChange={e => set('power_distance', e.target.value)} />)}
                {fld('Mounting surface', (
                  <select className={css.select} disabled={ro} value={form.mounting_surface ?? ''} onChange={e => set('mounting_surface', e.target.value)}>
                    <option value="">— Select —</option>
                    {MOUNTING_OPTIONS.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                  </select>
                ), { req: true })}
                {fld('Mounting height', <input className={css.input} placeholder="e.g. 3 m" disabled={ro} value={form.mounting_height ?? ''} onChange={e => set('mounting_height', e.target.value)} />)}
              </div>

              <div className={css.secTitle}>Access & materials</div>
              <div className={css.grid2}>
                {fld('Access constraints', <textarea className={css.textarea} disabled={ro} value={form.access_constraints ?? ''} onChange={e => set('access_constraints', e.target.value)} />, { full: true })}
                {fld('Contact person', <input className={css.input} disabled={ro} value={form.contact_person ?? ''} onChange={e => set('contact_person', e.target.value)} />)}
                {fld('Contact phone', <input className={css.input} type="tel" disabled={ro} value={form.contact_phone ?? ''} onChange={e => set('contact_phone', e.target.value)} />)}
                {fld('Required materials / special work', <textarea className={css.textarea} disabled={ro} value={form.required_materials ?? ''} onChange={e => set('required_materials', e.target.value)} />, { full: true })}
                {fld('General notes', <textarea className={css.textarea} disabled={ro} value={form.notes ?? ''} onChange={e => set('notes', e.target.value)} />, { full: true })}
              </div>

              <div className={css.secTitle}>Photos ({photoProgress(editId ?? '')}/{reqTotal} required)</div>
              {!editId && <div className={css.hint} style={{ marginBottom: 8 }}>Adding the first photo saves the survey as a draft automatically (court name needed).</div>}
              <div className={css.slots}>
                {PHOTO_SLOTS.map(slot => {
                  const list = editPhotos.filter(p => p.slot === slot.key);
                  const ok = list.length > 0;
                  const busySlot = uploadingSlot === slot.key;
                  return (
                    <div key={slot.key} className={`${css.slot} ${ok ? css.ok : slot.required && formErr.includes('photos') ? css.bad : ''}`}>
                      <div className={css.slotLabel}>
                        <span>{slot.label}</span>
                        {!slot.required && <span className={css.optTag}>optional</span>}
                      </div>
                      {list.length > 0 && (
                        <div className={css.thumbs}>
                          {list.map(p => (
                            <div className={css.thumb} key={p.id}>
                              {urls[p.storage_path]
                                ? <img src={urls[p.storage_path]} alt={slot.label} onClick={() => setLightbox(urls[p.storage_path])} />
                                : <img alt="" />}
                              {canEdit && <button className={css.thumbDel} onClick={() => removePhoto(p)} aria-label="Delete photo">×</button>}
                            </div>
                          ))}
                        </div>
                      )}
                      {canEdit && (
                        <label className={`${css.addPhoto} ${busySlot ? css.busy : ''}`}>
                          {busySlot ? 'Uploading…' : ok && !slot.multiple ? 'Retake / replace' : slot.multiple ? '+ Add photo(s)' : '📷 Take / choose photo'}
                          <input
                            className={css.hiddenInput} type="file" accept="image/*" multiple={slot.multiple} disabled={busySlot || busy}
                            onChange={e => {
                              // Copy to an array before resetting the input (resetting clears the live FileList).
                              const f = e.target.files ? Array.from(e.target.files) : [];
                              e.target.value = '';
                              onPickFiles(slot.key, slot.multiple, f);
                            }}
                          />
                        </label>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className={css.secTitle}>Result</div>
              <div className={css.grid2}>
                {fld('Feasibility', (
                  <select className={css.select} disabled={ro} value={form.feasibility ?? ''} onChange={e => set('feasibility', e.target.value)}>
                    <option value="">— Select —</option>
                    {Object.entries(FEASIBILITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                ), { req: true })}
              </div>

              {isAdmin && editing && editing.status === 'submitted' && (
                <div className={css.reviewBox}>
                  <div className={css.label} style={{ marginBottom: 6 }}>Review comment (required when returning)</div>
                  <textarea className={css.textarea} value={reviewComment} onChange={e => setReviewComment(e.target.value)} placeholder="What needs to be fixed or added?" />
                </div>
              )}
              {editing && editing.status === 'approved' && (
                <div className={css.reviewBox}>
                  Approved by <strong>{nameOf(editing.reviewed_by)}</strong>{editing.review_comment ? ` — ${editing.review_comment}` : ''}
                </div>
              )}
              {formErr && <div className={css.errorMsg} style={{ marginTop: 12 }}>{formErr}</div>}
            </div>

            <div className={css.modalFooter}>
              {canEdit && <button className={css.btnGhost} disabled={busy} onClick={saveDraft}>{busy ? 'Saving…' : 'Save draft'}</button>}
              {canEdit && status !== 'approved' && <button className={css.btnPrimary} disabled={busy} onClick={submit}>Submit for review</button>}
              {isAdmin && editing?.status === 'submitted' && (
                <>
                  <button className={css.btnGreen} disabled={busy} onClick={() => review('approved')}>Approve</button>
                  <button className={css.btnWarn} disabled={busy} onClick={() => review('returned')}>Return</button>
                </>
              )}
              {editing && <button className={css.btnGhost} disabled={busy} onClick={exportPdf}>Download PDF</button>}
              <div className={css.spacer} />
              {editing && (isAdmin || (isOwner && (status === 'draft' || status === 'returned'))) && (
                <button className={css.btnDanger} disabled={busy} onClick={remove}>Delete</button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {lightbox && createPortal(
        <div className={css.lightbox} onClick={() => setLightbox(null)}><img src={lightbox} alt="" /></div>,
        document.body,
      )}
      {toast && createPortal(
        <div className={`${css.toast} ${toast.ok ? css.toastOk : css.toastErr}`}>{toast.msg}</div>,
        document.body,
      )}
    </div>
  );
}
