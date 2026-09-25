#!/usr/bin/env -S npx tsx
/**
 * JSR Database Backup Script (React app version)
 *
 * Replaces the old JSR/backup.js, which pointed at the OLD Supabase project
 * (tltbkjvrhqsxdspdfeqk) and is now retired. This version points at the
 * CURRENT jsr-app-react Supabase project and covers every table the app
 * actually uses today, including ones added after the React migration
 * (advances, advance_distributions, partner_capital_entries,
 * money_disbursements) that the old script never knew about.
 *
 * Uses the service-role key (via .env.phase4.local) so it bypasses RLS —
 * needed because several tables (advances, partner_capital_entries,
 * money_disbursements, etc.) are admin-only under RLS and a plain anon key
 * can't read them.
 *
 * Run manually:   npx tsx scripts/backup.ts
 * Run on schedule: see docs/go-live/com.jsr.backup.plist (launchd, hourly)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── Env ──────────────────────────────────────────────────────────────────
// Reuses .env.phase4.local (already gitignored) for the DEST_* service-role
// credentials rather than introducing a new secrets file.

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

const SUPABASE_URL = process.env.DEST_SUPABASE_URL!;
const SERVICE_KEY  = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_SERVICE_ROLE_KEY must be set (in .env.phase4.local).');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── Config ───────────────────────────────────────────────────────────────

const TABLES = [
  'users', 'sections', 'rows', 'activity_log', 'general_expenses',
  'team_members', 'revenue', 'project_expenses', 'expense_claims', 'employee_documents',
  'money_disbursements', 'advances', 'advance_distributions', 'partner_capital_entries',
];

// Same folder name the old script used, so an existing Google Drive Desktop
// sync of ~/Downloads/JSR_Backups keeps working without reconfiguration.
// Override with BACKUP_DIR in .env.phase4.local if that folder moved.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(os.homedir(), 'Downloads', 'JSR_Backups');
const MAX_FILES = 48; // hourly cadence → 48 = 2 days of history, matches old script

function pad(n: number) { return String(n).padStart(2, '0'); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

async function fetchTable(table: string): Promise<unknown[]> {
  let all: unknown[] = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select('*').range(from, from + pageSize - 1);
    if (error) { console.error(`  ✗ Error fetching ${table}:`, error.message); return []; }
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function run() {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`Created backup directory: ${BACKUP_DIR}`);
  }

  const backup: { exported_at: string; tables: Record<string, unknown[]> } = {
    exported_at: new Date().toISOString(),
    tables: {},
  };
  let total = 0;

  for (const table of TABLES) {
    process.stdout.write(`  Fetching ${table}… `);
    const rows = await fetchTable(table);
    backup.tables[table] = rows;
    total += rows.length;
    console.log(`${rows.length} rows`);
  }

  const fname = `jsr_backup_${timestamp()}.json`;
  const fpath = path.join(BACKUP_DIR, fname);
  writeFileSync(fpath, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\n✅ Backup saved: ${fname} — ${total.toLocaleString()} total records`);

  // Keep only the last MAX_FILES backups
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('jsr_backup_') && f.endsWith('.json'))
    .map(f => ({ name: f, time: statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  const toDelete = files.slice(MAX_FILES);
  if (toDelete.length > 0) {
    toDelete.forEach(f => {
      unlinkSync(path.join(BACKUP_DIR, f.name));
      console.log(`  🗑  Deleted old backup: ${f.name}`);
    });
  }
}

run().catch(err => { console.error('Backup failed:', err); process.exit(1); });
