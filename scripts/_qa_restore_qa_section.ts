/**
 * Restore QA section 3813b019 (mrc/ftk_msudnyc2) to correct column schema.
 * This section was corrupted during Phase C QA by the now-fixed import bug.
 * Only touches the QA section — never the real migrated MRC/FTK section.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env.phase4.local');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const t = line.trim(); if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('='); if (eq < 0) continue;
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

const QA_SECTION_ID = '3813b019-918e-48d6-8a88-ee5c58f6db9e';
const CORRECT_COLUMNS = ['Site ID', 'Governate', 'Imp. Date', 'ATP Status', 'Comment'];

// Pre-check: confirm this is the QA section and it's currently corrupted
const { data: before } = await dst.from('sections').select('*').eq('id', QA_SECTION_ID).single();
if (!before) { console.error('QA section not found'); process.exit(1); }
console.log('Before restore:');
console.log('  columns    :', JSON.stringify(before.columns));
console.log('  custom_cols:', JSON.stringify(before.custom_columns));
console.log('  is_deleted :', before.is_deleted);
console.log('  project    :', before.project_name, '/', before.section_name);

if (before.project_name !== 'mrc' || before.section_name !== 'ftk_msudnyc2') {
  console.error('Guard failed: unexpected project/section name — aborting');
  process.exit(1);
}

// Restore
const { error } = await dst.from('sections')
  .update({ columns: CORRECT_COLUMNS, custom_columns: [] })
  .eq('id', QA_SECTION_ID)
  .eq('project_name', 'mrc')
  .eq('section_name', 'ftk_msudnyc2');

if (error) { console.error('Restore failed:', error.message); process.exit(1); }

// Post-check
const { data: after } = await dst.from('sections').select('*').eq('id', QA_SECTION_ID).single();
console.log('\nAfter restore:');
console.log('  columns    :', JSON.stringify(after?.columns));
console.log('  custom_cols:', JSON.stringify(after?.custom_columns));

const restored = JSON.stringify(after?.columns) === JSON.stringify(CORRECT_COLUMNS) &&
  JSON.stringify(after?.custom_columns) === '[]';
if (restored) {
  console.log('\n✔ QA section restored successfully');
} else {
  console.error('\n✘ Restore verification failed');
  process.exit(1);
}
