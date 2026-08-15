import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq === -1) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const dst = createClient(
  process.env.DEST_SUPABASE_URL!,
  process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

// QA section state
const { data: s } = await dst.from('sections').select('*')
  .eq('id', '3813b019-918e-48d6-8a88-ee5c58f6db9e').single();
console.log('\n=== QA section (mrc/ftk_msudnyc2) ===');
console.log('columns     :', JSON.stringify(s?.columns));
console.log('custom_cols :', JSON.stringify(s?.custom_columns));
console.log('is_deleted  :', s?.is_deleted);

const { data: r } = await dst.from('rows').select('id, data')
  .eq('section_id', '3813b019-918e-48d6-8a88-ee5c58f6db9e');
console.log('rows count  :', r?.length ?? 0);
for (const row of r ?? []) console.log('  row data:', JSON.stringify(row.data));

// Real MRC/FTK
const { data: mrcFtk } = await dst.from('sections').select('id, columns, custom_columns, is_deleted')
  .eq('project_name', 'mrc').eq('section_name', 'ftk').single();
console.log('\n=== Real MRC/FTK section ===');
console.log('id          :', mrcFtk?.id);
console.log('columns     :', JSON.stringify(mrcFtk?.columns));
console.log('custom_cols :', JSON.stringify(mrcFtk?.custom_columns));
console.log('is_deleted  :', mrcFtk?.is_deleted);

// IPT/TDD anomaly check — query by project_name + section_name
const { data: iptTdd } = await dst.from('sections').select('id, columns, custom_columns, is_deleted')
  .eq('project_name', 'ipt').eq('section_name', 'tdd');
const ipt = iptTdd?.[0];
console.log('\n=== IPT/TDD section (anomaly check) ===');
console.log('id          :', ipt?.id);
console.log('columns     :', JSON.stringify(ipt?.columns));
console.log('custom_cols :', JSON.stringify(ipt?.custom_columns));
console.log('custom_cols len:', Array.isArray(ipt?.custom_columns) ? ipt.custom_columns.length : 'N/A');
