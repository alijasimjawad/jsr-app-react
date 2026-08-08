/**
 * Read-only QA write-persistence verifier.
 *
 * Run this after completing a phase of FULL_CRUD_QA_CHECKLIST.md to confirm
 * that manual test writes actually landed in the Supabase staging project.
 * Makes ZERO writes — every check is a SELECT / count(*).
 *
 * Usage:
 *   source .env.phase4.local
 *   npx tsx scripts/verify-qa-writes.ts
 *
 * Optional filter — run only checks for a specific phase:
 *   npx tsx scripts/verify-qa-writes.ts --phase B
 *   npx tsx scripts/verify-qa-writes.ts --phase C
 */

import { createClient } from '@supabase/supabase-js';

const url  = process.env.DEST_SUPABASE_URL!;
const key  = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) {
  console.error('Missing DEST_SUPABASE_URL or DEST_SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const phaseArg = (() => {
  const i = process.argv.indexOf('--phase');
  return i !== -1 ? process.argv[i + 1]?.toUpperCase() ?? 'ALL' : 'ALL';
})();

const sb = createClient(url, key);

interface Check {
  phase: string;
  label: string;
  run: () => Promise<{ ok: boolean; detail: string }>;
}

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

async function recent(table: string, col = 'created_at', limit = 3): Promise<any[]> {
  const { data, error } = await (sb.from(table) as any)
    .select('*').order(col, { ascending: false }).limit(limit);
  if (error) throw new Error(`${table}: ${error.message}`);
  return data ?? [];
}

const checks: Check[] = [
  // ── Phase A ──────────────────────────────────────────────────────────────
  {
    phase: 'A',
    label: 'Auth: public.users — all 26+ rows linked (auth_user_id not null)',
    run: async () => {
      const total   = await count('users');
      const linked  = await count('users', q => q.not('auth_user_id', 'is', null));
      const ok = total > 0 && linked === total;
      return { ok, detail: `${linked}/${total} linked` };
    },
  },
  {
    phase: 'A',
    label: 'Cars: at least 1 car added (needed for car-trip tests)',
    run: async () => {
      const n = await count('cars');
      return { ok: n >= 1, detail: `${n} car(s)` };
    },
  },

  // ── Phase B ──────────────────────────────────────────────────────────────
  {
    phase: 'B',
    label: 'Revenue: migrated rows present',
    run: async () => {
      const n = await count('revenue');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'General Expenses: migrated rows present',
    run: async () => {
      const n = await count('general_expenses');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Project Expenses: migrated rows present (expected ~169)',
    run: async () => {
      const n = await count('project_expenses');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Expense Claims: migrated rows present',
    run: async () => {
      const n = await count('expense_claims');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Team Members: migrated rows present (expected 25)',
    run: async () => {
      const n = await count('team_members');
      return { ok: n >= 25, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Clients: migrated rows present',
    run: async () => {
      const n = await count('clients');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Invoices: migrated rows present',
    run: async () => {
      const n = await count('invoices');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Sections: migrated rows present (expected 18+ in destination)',
    run: async () => {
      const n = await count('sections');
      return { ok: n >= 18, detail: `${n} rows` };
    },
  },
  {
    phase: 'B',
    label: 'Rows: migrated rows present (expected 487)',
    run: async () => {
      const n = await count('rows');
      return { ok: n >= 487, detail: `${n} rows` };
    },
  },

  // ── Phase C ──────────────────────────────────────────────────────────────
  {
    phase: 'C',
    label: 'Revenue: recent write — at least 1 row with added_by set (test 4.5)',
    run: async () => {
      const rows = await recent('revenue', 'created_at', 3);
      const withAddedBy = rows.filter((r: any) => r.added_by);
      return { ok: withAddedBy.length > 0, detail: withAddedBy.length > 0 ? `latest: ${rows[0]?.project_name} / ${rows[0]?.section_name}` : 'no rows with added_by found' };
    },
  },
  {
    phase: 'C',
    label: 'General Expenses: at least 1 row exists',
    run: async () => {
      const n = await count('general_expenses');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Project Expenses: at least 1 row exists',
    run: async () => {
      const n = await count('project_expenses');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Expense Claims: at least 1 row with status=approved or status=rejected',
    run: async () => {
      const approved = await count('expense_claims', q => q.eq('status', 'approved'));
      const rejected = await count('expense_claims', q => q.eq('status', 'rejected'));
      return { ok: approved + rejected > 0, detail: `${approved} approved, ${rejected} rejected` };
    },
  },
  {
    phase: 'C',
    label: 'Expense Claims (car-trip): at least 1 row with is_car_trip=true (test 7.7)',
    run: async () => {
      const n = await count('expense_claims', q => q.eq('is_car_trip', true));
      return { ok: n > 0, detail: `${n} car-trip claim(s)` };
    },
  },
  {
    phase: 'C',
    label: 'Daily Activities: at least 1 row created (test 15.2)',
    run: async () => {
      const n = await count('daily_activities');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Field Trips: at least 1 trip created (test 15.3)',
    run: async () => {
      const n = await count('field_trips');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Attendance: at least 1 row set (test 14.2)',
    run: async () => {
      const n = await count('attendance');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Clients: at least 1 row (migrated or new) exists',
    run: async () => {
      const n = await count('clients');
      return { ok: n > 0, detail: `${n} rows` };
    },
  },
  {
    phase: 'C',
    label: 'Invoices: at least 1 invoice with invoice_items (test 10.3)',
    run: async () => {
      const inv = await count('invoices');
      const items = await count('invoice_items');
      return { ok: inv > 0 && items > 0, detail: `${inv} invoices, ${items} line items` };
    },
  },
  {
    phase: 'C',
    label: 'Invoice Payments: at least 1 payment recorded (test 10.5)',
    run: async () => {
      const n = await count('invoice_payments');
      return { ok: n > 0, detail: `${n} payment(s)` };
    },
  },

  // ── Phase D ──────────────────────────────────────────────────────────────
  {
    phase: 'D',
    label: 'Employee Documents: at least 1 document uploaded (test 11.6)',
    run: async () => {
      const n = await count('employee_documents');
      return { ok: n > 0, detail: `${n} document(s)` };
    },
  },
  {
    phase: 'D',
    label: 'Users: at least 1 row with profile_photo_url set (test 13.4)',
    run: async () => {
      const n = await count('users', q => q.not('profile_photo_url', 'is', null));
      return { ok: n > 0, detail: `${n} user(s) with photo` };
    },
  },

  // ── Phase E ──────────────────────────────────────────────────────────────
  {
    phase: 'E',
    label: 'Sites: at least 1 site added or imported (test 3.2 / 3.5)',
    run: async () => {
      const n = await count('sites');
      return { ok: n > 0, detail: `${n} site(s)` };
    },
  },
  {
    phase: 'E',
    label: 'Salary Adjustments: at least 1 adjustment set (test 8.4)',
    run: async () => {
      const n = await count('salary_adjustments');
      return { ok: n > 0, detail: `${n} adjustment(s)` };
    },
  },
  {
    phase: 'E',
    label: 'Activity Log: rows written by logActivity() calls',
    run: async () => {
      const n = await count('activity_log');
      return { ok: n > 0, detail: `${n} log entries` };
    },
  },
];

(async () => {
  const proj = url.match(/https:\/\/(.+?)\.supabase/)?.[1] ?? url;
  console.log(`\nQA Write Verifier — destination: ${proj}`);
  console.log(`Phase filter: ${phaseArg}\n`);

  const toRun = phaseArg === 'ALL' ? checks : checks.filter(c => c.phase === phaseArg);
  if (!toRun.length) { console.log(`No checks for phase "${phaseArg}".`); process.exit(0); }

  let passed = 0, failed = 0;

  for (const c of toRun) {
    try {
      const { ok, detail } = await c.run();
      const tag = ok ? '[PASS]' : '[FAIL]';
      console.log(`  ${tag}  [${c.phase}] ${c.label}`);
      console.log(`         ${detail}`);
      if (ok) passed++; else failed++;
    } catch (e: unknown) {
      console.log(`  [ERR]  [${c.phase}] ${c.label}`);
      console.log(`         ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed} passed  |  ${failed} failed  |  ${toRun.length} total`);
  console.log('─'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
})();
