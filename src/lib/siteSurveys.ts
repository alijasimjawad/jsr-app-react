// src/lib/siteSurveys.ts
//
// Data layer for "Site Surveys" — per-court surveys (e.g. Keystone
// installation) filled in from the app by engineers/technicians, with
// required photos, reviewed by an admin. See
// docs/go-live/26_add_site_surveys.sql for the table/RLS/storage design.

import { supabase } from './supabase';

export type SurveyStatus = 'draft' | 'submitted' | 'approved' | 'returned';

export interface SiteSurvey {
  id: string;
  project_name: string | null;
  court_name: string;
  court_id: string | null;
  governorate: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  survey_date: string;
  court_type: string | null;
  dimensions: string | null;
  existing_cabling: string | null;
  existing_cabling_notes: string | null;
  power_available: string | null;
  power_distance: string | null;
  mounting_surface: string | null;
  mounting_height: string | null;
  access_constraints: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  required_materials: string | null;
  notes: string | null;
  feasibility: string | null;
  status: SurveyStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string | null;
  submitted_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
}

export type SurveyInput = Omit<SiteSurvey,
  'id' | 'created_at' | 'updated_at' | 'submitted_at' | 'reviewed_by' | 'reviewed_at' | 'review_comment' | 'status' | 'created_by'>;

export interface SurveyPhoto {
  id: string;
  survey_id: string;
  slot: string;
  storage_path: string;
  caption: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Template (fixed, agreed with user) ───────────────────────────────────

export interface PhotoSlot {
  key: string;
  label: string;
  required: boolean;
  multiple: boolean;
}

export const PHOTO_SLOTS: PhotoSlot[] = [
  { key: 'overview',         label: 'Court overview (wide shot)',     required: true,  multiple: false },
  { key: 'keystone_location', label: 'Proposed Keystone location',     required: true,  multiple: false },
  { key: 'power_point',      label: 'Power point / electrical panel', required: true,  multiple: false },
  { key: 'cable_route',      label: 'Cable route (start to end)',     required: true,  multiple: false },
  { key: 'mounting_surface', label: 'Mounting surface close-up',      required: true,  multiple: false },
  { key: 'access',           label: 'Entrance / access',              required: true,  multiple: false },
  { key: 'obstacles',        label: 'Obstacles / problem areas',      required: false, multiple: true  },
];

export const STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved', returned: 'Returned',
};

export const FEASIBILITY_LABELS: Record<string, string> = {
  feasible: 'Feasible',
  conditional: 'Feasible with conditions',
  not_feasible: 'Not feasible',
};

export const MOUNTING_OPTIONS = ['wall', 'pole', 'ceiling', 'other'];

export const BUCKET = 'site-survey-photos';

export function missingRequiredSlots(photos: SurveyPhoto[]): PhotoSlot[] {
  return PHOTO_SLOTS.filter(s => s.required && !photos.some(p => p.slot === s.key));
}

// ── Surveys ──────────────────────────────────────────────────────────────

export async function fetchSurveys(): Promise<SiteSurvey[]> {
  const { data, error } = await supabase
    .from('site_surveys')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchSurveys failed:', error.message, error);
    return [];
  }
  return (data as SiteSurvey[]) ?? [];
}

export async function createSurvey(
  input: SurveyInput,
  createdBy: string,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from('site_surveys')
    .insert({ ...input, created_by: createdBy, status: 'draft' })
    .select('id')
    .single();
  return { id: data ? (data as { id: string }).id : null, error: error ? error.message : null };
}

// .select('id') so a policy-blocked (zero-row) update is detected instead of
// looking like a success.
export async function updateSurvey(
  id: string,
  patch: Partial<SiteSurvey>,
): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from('site_surveys')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  if (error) return { error: error.message };
  if (!data || data.length === 0) return { error: 'The database did not accept the change (survey is locked or not yours).' };
  return { error: null };
}

export async function submitSurvey(id: string): Promise<{ error: string | null }> {
  return updateSurvey(id, { status: 'submitted', submitted_at: new Date().toISOString() });
}

export async function reviewSurvey(
  id: string,
  decision: 'approved' | 'returned',
  reviewerId: string,
  comment: string | null,
): Promise<{ error: string | null }> {
  return updateSurvey(id, {
    status: decision,
    reviewed_by: reviewerId,
    reviewed_at: new Date().toISOString(),
    review_comment: comment,
  });
}

export async function deleteSurvey(id: string, photos: SurveyPhoto[]): Promise<{ error: string | null }> {
  if (photos.length) await supabase.storage.from(BUCKET).remove(photos.map(p => p.storage_path));
  const { error } = await supabase.from('site_surveys').delete().eq('id', id);
  return { error: error ? error.message : null };
}

// ── Photos ───────────────────────────────────────────────────────────────

export async function fetchPhotos(surveyIds?: string[]): Promise<SurveyPhoto[]> {
  let q = supabase.from('survey_photos').select('*').order('created_at');
  if (surveyIds) {
    if (surveyIds.length === 0) return [];
    q = q.in('survey_id', surveyIds);
  }
  const { data, error } = await q;
  if (error) {
    console.error('fetchPhotos failed:', error.message, error);
    return [];
  }
  return (data as SurveyPhoto[]) ?? [];
}

// Resize + re-encode as JPEG in the browser before upload: phone photos are
// often 4–10 MB; 1600px / q0.8 keeps them clear and ~200–400 KB.
export async function compressImage(file: File, maxDim = 1600, quality = 0.8): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  if (!bitmap) return file; // fall back to the original if the browser can't decode it
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return await new Promise<Blob>(resolve =>
    canvas.toBlob(b => resolve(b ?? file), 'image/jpeg', quality));
}

export async function uploadPhoto(
  surveyId: string,
  slot: string,
  file: File,
  createdBy: string,
): Promise<{ photo: SurveyPhoto | null; error: string | null }> {
  const blob = await compressImage(file);
  const path = `${surveyId}/${slot}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: 'image/jpeg', upsert: false,
  });
  if (upErr) return { photo: null, error: upErr.message };
  const { data, error } = await supabase
    .from('survey_photos')
    .insert({ survey_id: surveyId, slot, storage_path: path, created_by: createdBy })
    .select('*')
    .single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]);
    return { photo: null, error: error.message };
  }
  return { photo: data as SurveyPhoto, error: null };
}

export async function deletePhoto(photo: SurveyPhoto): Promise<{ error: string | null }> {
  const { error: delErr } = await supabase.from('survey_photos').delete().eq('id', photo.id);
  if (delErr) return { error: delErr.message };
  await supabase.storage.from(BUCKET).remove([photo.storage_path]);
  return { error: null };
}

// Signed URLs for display (private bucket). Returns path -> url.
export async function signedUrls(paths: string[], expiresIn = 3600): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, expiresIn);
  if (error || !data) {
    console.error('signedUrls failed:', error?.message);
    return {};
  }
  const out: Record<string, string> = {};
  for (const d of data) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}
