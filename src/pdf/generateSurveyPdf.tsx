// src/pdf/generateSurveyPdf.tsx
//
// Client-side PDF report for one site survey (fields + photos + review).
// Lazy-imports @react-pdf/renderer on first click, same approach as
// generateInvoicePdf.tsx, so the pdfkit bundle stays out of the main chunk.

import { BRAND } from '../config/brand';
import {
  PHOTO_SLOTS, STATUS_LABELS, FEASIBILITY_LABELS,
  type SiteSurvey, type SurveyPhoto,
} from '../lib/siteSurveys';

export interface SurveyPdfInput {
  survey: SiteSurvey;
  photos: SurveyPhoto[];
  urls: Record<string, string>;      // storage_path -> signed url
  surveyorName: string;
  reviewerName: string;
}

function safeName(s: string): string {
  return (s || 'survey').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'survey';
}

// Fetch each photo and inline it as a data URL: react-pdf needs the bytes
// and this avoids cross-origin surprises with signed URLs.
async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function generateSurveyPdf(input: SurveyPdfInput): Promise<void> {
  const [{ pdf, Document, Page, Text, View, Image, StyleSheet }] = await Promise.all([
    import('@react-pdf/renderer'),
  ]);

  const { survey: s, photos, urls } = input;

  const dataUrls: Record<string, string | null> = {};
  await Promise.all(photos.map(async p => {
    const u = urls[p.storage_path];
    dataUrls[p.id] = u ? await toDataUrl(u) : null;
  }));

  const st = StyleSheet.create({
    page:    { padding: 28, fontSize: 9, color: '#1e293b', fontFamily: 'Helvetica' },
    title:   { fontSize: 15, fontWeight: 700, marginBottom: 2 },
    sub:     { fontSize: 9, color: '#64748b', marginBottom: 12 },
    h2:      { fontSize: 10, fontWeight: 700, marginTop: 12, marginBottom: 4, color: '#334155', textTransform: 'uppercase' },
    row:     { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#e2e8f0', paddingVertical: 3 },
    k:       { width: '34%', color: '#64748b' },
    v:       { width: '66%' },
    grid:    { flexDirection: 'row', flexWrap: 'wrap' },
    photoBox:{ width: '48%', marginRight: '2%', marginBottom: 8 },
    photo:   { width: '100%', height: 150, objectFit: 'cover', borderRadius: 3, backgroundColor: '#f1f5f9' },
    cap:     { fontSize: 8, color: '#475569', marginTop: 2 },
    missing: { fontSize: 8, color: '#dc2626' },
    review:  { marginTop: 10, padding: 8, backgroundColor: '#f8fafc', borderRadius: 3 },
  });

  const yn = (v: string | null) => (v === 'yes' ? 'Yes' : v === 'no' ? 'No' : '—');
  const fields: [string, string][] = [
    ['Project', s.project_name || '—'],
    ['Court name', s.court_name],
    ['Court ID', s.court_id || '—'],
    ['Governorate', s.governorate || '—'],
    ['Address', s.address || '—'],
    ['GPS', s.latitude != null && s.longitude != null ? `${s.latitude}, ${s.longitude}` : '—'],
    ['Survey date', s.survey_date],
    ['Surveyor', input.surveyorName || '—'],
    ['Court type', s.court_type || '—'],
    ['Dimensions', s.dimensions || '—'],
    ['Existing cabling', yn(s.existing_cabling) + (s.existing_cabling_notes ? ` — ${s.existing_cabling_notes}` : '')],
    ['Power available', yn(s.power_available) + (s.power_distance ? ` (distance: ${s.power_distance})` : '')],
    ['Mounting surface', s.mounting_surface || '—'],
    ['Mounting height', s.mounting_height || '—'],
    ['Access constraints', s.access_constraints || '—'],
    ['Contact', [s.contact_person, s.contact_phone].filter(Boolean).join(' — ') || '—'],
    ['Required materials', s.required_materials || '—'],
    ['Notes', s.notes || '—'],
    ['Result', FEASIBILITY_LABELS[s.feasibility || ''] || '—'],
    ['Status', STATUS_LABELS[s.status]],
  ];

  const doc = (
    <Document title={`Site Survey - ${s.court_name}`}>
      <Page size="A4" style={st.page}>
        <Text style={st.title}>Site Survey Report — {s.court_name}</Text>
        <Text style={st.sub}>{BRAND.appName} · {s.project_name || 'No project'} · {s.survey_date}</Text>

        <Text style={st.h2}>Survey details</Text>
        {fields.map(([k, v]) => (
          <View style={st.row} key={k} wrap={false}>
            <Text style={st.k}>{k}</Text>
            <Text style={st.v}>{v}</Text>
          </View>
        ))}

        {(s.review_comment || s.reviewed_at) && (
          <View style={st.review} wrap={false}>
            <Text style={{ fontWeight: 700, marginBottom: 2 }}>
              Review{input.reviewerName ? ` — ${input.reviewerName}` : ''}
            </Text>
            <Text>{s.review_comment || '—'}</Text>
          </View>
        )}

        <Text style={st.h2} break>Photos</Text>
        <View style={st.grid}>
          {PHOTO_SLOTS.flatMap(slot => {
            const list = photos.filter(p => p.slot === slot.key);
            if (list.length === 0) {
              return slot.required ? [
                <View style={st.photoBox} key={slot.key} wrap={false}>
                  <Text style={st.missing}>{slot.label}: MISSING</Text>
                </View>,
              ] : [];
            }
            return list.map((p, i) => (
              <View style={st.photoBox} key={p.id} wrap={false}>
                {dataUrls[p.id]
                  ? <Image style={st.photo} src={dataUrls[p.id] as string} />
                  : <View style={st.photo} />}
                <Text style={st.cap}>{slot.label}{list.length > 1 ? ` (${i + 1})` : ''}{p.caption ? ` — ${p.caption}` : ''}</Text>
              </View>
            ));
          })}
        </View>
      </Page>
    </Document>
  );

  const blob = await pdf(doc).toBlob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = `Site_Survey_${safeName(s.court_name)}_${s.survey_date}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
