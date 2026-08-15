import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
function loadEnv() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq === -1) continue;
    const k = t.slice(0,eq).trim(), v = t.slice(eq+1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();
const dst = createClient(process.env.DEST_SUPABASE_URL!, process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const src = createClient(process.env.SOURCE_SUPABASE_URL!, process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

// All sections in dest — show full schema
const { data: sections } = await dst.from('sections').select('*').order('project_name').order('section_name');
console.log('\n=== ALL DEST SECTIONS (full schema) ===');
for (const s of sections ?? []) {
  console.log(`\nid          : ${s.id}`);
  console.log(`project_name: ${s.project_name}`);
  console.log(`section_name: ${s.section_name}`);
  console.log(`section_label: ${s.section_label}`);
  console.log(`is_deleted  : ${s.is_deleted}`);
  console.log(`is_custom   : ${s.is_custom}`);
  console.log(`columns     : ${JSON.stringify(s.columns)}`);
  console.log(`custom_cols : ${JSON.stringify(s.custom_columns)}`);
  console.log(`created_at  : ${s.created_at}`);
}

// MRC sections specifically
console.log('\n\n=== MRC SECTIONS (dest) ===');
const mrc = (sections ?? []).filter((s: {project_name: string}) => s.project_name.toLowerCase() === 'mrc');
for (const s of mrc) {
  console.log(`\nid          : ${s.id}`);
  console.log(`project_name: ${s.project_name}`);
  console.log(`section_name: ${s.section_name}`);
  console.log(`section_label: ${s.section_label}`);
  console.log(`is_deleted  : ${s.is_deleted}`);
  console.log(`columns     : ${JSON.stringify(s.columns)}`);
  console.log(`custom_cols : ${JSON.stringify(s.custom_columns)}`);
}

// Source: MRC sections for comparison
console.log('\n\n=== MRC SECTIONS (source/old JSR production) ===');
const { data: srcSections } = await src.from('sections').select('*').ilike('project_name', 'mrc');
for (const s of srcSections ?? []) {
  console.log(`\nid          : ${s.id}`);
  console.log(`project_name: ${s.project_name}`);
  console.log(`section_name: ${s.section_name}`);
  console.log(`section_label: ${s.section_label}`);
  console.log(`is_deleted  : ${s.is_deleted}`);
  console.log(`columns     : ${JSON.stringify(s.columns)}`);
  console.log(`custom_cols : ${JSON.stringify(s.custom_columns)}`);
}

// Also check activity_log for any recent section updates
console.log('\n\n=== RECENT ACTIVITY LOG (last 20 entries) ===');
const { data: logs } = await dst.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20);
for (const l of logs ?? []) {
  console.log(`${l.created_at}  ${l.action}  ${l.project_name ?? ''}/${l.section_name ?? ''}  user=${l.user_full_name}  details=${JSON.stringify(l.details)}`);
}
