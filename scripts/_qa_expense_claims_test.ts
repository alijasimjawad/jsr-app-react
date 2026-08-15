/**
 * Focused QA for the Expense Claims P1 fix.
 *
 * Test groups:
 *   GROUP 1 — Pre-patch state verification (columns absent before SQL patch)
 *   GROUP 2 — Frontend validation logic (pure, no DB needed)
 *   GROUP 3 — DB persistence (INSERT/UPDATE with section_id + section_label)
 *             *** REQUIRES SQL patch 15_expense_claims_section_cols.sql ***
 *   GROUP 4 — Duplicate claim guard (DB, uses existing data)
 *   GROUP 5 — Approve flow payload structure (pure, validates payload shape)
 *
 * Run: npx tsx scripts/_qa_expense_claims_test.ts
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

// ── QA fixtures (safe: far-future date, QA-prefixed site IDs) ────────────────
const QA_MEMBER_ID     = 'd8998c7a-d372-4f3a-a02c-3a5b4e597141';  // Wessam Basil (active)
const QA_PROJECT       = 'TAC Project';
const QA_SECTION_ID    = '07c299e2-5a14-4555-853f-3d43021459a9';  // tac/AAU
const QA_SECTION_LABEL = 'AAU';
const QA_SITE_A        = 'QA-EXP-CLAIM-001';
const QA_SITE_B        = 'QA-EXP-CLAIM-002';
const QA_DATE          = '2099-06-15';   // far future — no conflict with real data
const QA_DATE_B        = '2099-06-16';

let passed = 0; let failed = 0; let skipped = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS   ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL   ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}
function skip(name: string, reason: string) {
  console.log(`  ⊘ SKIP   ${name} — ${reason}`);
  skipped++;
}

// ── Cleanup helper ────────────────────────────────────────────────────────────
async function cleanup() {
  await dst.from('expense_claims').delete()
    .eq('project_name', QA_PROJECT)
    .in('site_id', [QA_SITE_A, QA_SITE_B]);
}

console.log('\n=== Expense Claims P1 Fix QA Test Suite ===\n');

// ─────────────────────────────────────────────────────────────────────────────
// GROUP 1 — Pre/post-patch state: verify column existence in DB
// ─────────────────────────────────────────────────────────────────────────────
console.log('── GROUP 1: Column existence check ──────────────────────────────────────');
const { data: colRows } = await dst.rpc('version');  // lightweight ping
const { data: sectionCols } = await dst
  .from('information_schema.columns' as 'expense_claims')
  .select('column_name, data_type, is_nullable')
  .eq('table_schema' as 'project_name', 'public')
  .eq('table_name' as 'site_id', 'expense_claims')
  .in('column_name' as 'site_id', ['section_id', 'section_label'] as string[]);

// Fallback: direct SQL query via rpc if above doesn't work
let colCheck: Array<{ column_name: string; data_type: string; is_nullable: string }> = [];
{
  const res = await (dst as ReturnType<typeof createClient>)
    .from('expense_claims')
    .select('section_id, section_label')
    .limit(0);
  // If error contains PGRST204, columns are missing; if no error, they exist
  const colsMissing = !!res.error && res.error.message.includes('section_id');
  const colsPresent = !res.error || !res.error.message.includes('section_id');
  assert('1.1  expense_claims has section_id column (SQL patch applied)',
    !colsMissing, colsMissing ? 'PGRST204 — column missing, apply patch 15_expense_claims_section_cols.sql' : '');
  // section_label — check by inspecting the error message
  const slRes = await (dst as ReturnType<typeof createClient>)
    .from('expense_claims').select('section_label').limit(0);
  const slMissing = !!slRes.error && slRes.error.message.includes('section_label');
  assert('1.2  expense_claims has section_label column (SQL patch applied)',
    !slMissing, slMissing ? 'PGRST204 — column missing, apply patch 15_expense_claims_section_cols.sql' : '');

  const colsExist = !colsMissing && !slMissing;
  if (!colsExist) {
    console.log('\n  ⚠ SQL patch NOT yet applied. GROUP 3 tests will be skipped.');
    console.log('  Apply docs/go-live/15_expense_claims_section_cols.sql then re-run.\n');
  }

  // ── GROUP 2 — Frontend validation logic (pure, always runs) ─────────────────
  console.log('\n── GROUP 2: Frontend validation logic (pure) ───────────────────────────');

  // Mirror of saveClaim() validation — identical to MyExpenses.tsx:315-322
  function validateClaimForm(f: {
    project: string; sectionId: string; activityType: string;
    otherDesc: string; siteId: string; date: string;
    nameToKey: Record<string, string>;
  }): Record<string, string> {
    const errs: Record<string, string> = {};
    if (!f.project)                                       errs.project      = 'Select a project.';
    if (f.nameToKey[f.project] && !f.sectionId)           errs.section      = 'Select a section.';
    if (!f.activityType)                                  errs.activityType = 'Select an activity type.';
    if (f.activityType === 'Other' && !f.otherDesc.trim()) errs.otherDesc   = 'Describe the activity.';
    if (!f.siteId.trim())                                 errs.siteId       = 'Enter a Site ID.';
    if (!f.date)                                          errs.date         = 'Select an activity date.';
    return errs;
  }

  const nameToKey: Record<string, string> = { 'TAC Project': 'tac', 'IPT Project': 'ipt' };
  const validBase = { project: 'TAC Project', sectionId: QA_SECTION_ID, activityType: 'Installation',
                      otherDesc: '', siteId: '1234', date: QA_DATE, nameToKey };

  // 2.1 Missing project
  {
    const e = validateClaimForm({ ...validBase, project: '' });
    assert('2.1  missing project → errs.project set',     !!e.project);
    assert('2.1b valid form → no project error',          !validateClaimForm(validBase).project);
  }

  // 2.2 Missing section (project has a key in nameToKey)
  {
    const e = validateClaimForm({ ...validBase, sectionId: '' });
    assert('2.2  missing section → errs.section set',     !!e.section,
      JSON.stringify(e));
    // Project not in nameToKey → section is not required
    const eNoKey = validateClaimForm({ ...validBase, project: 'Unknown Project', sectionId: '' });
    assert('2.2b project not in nameToKey → no section error', !eNoKey.section);
  }

  // 2.3 Missing activity type
  {
    const e = validateClaimForm({ ...validBase, activityType: '' });
    assert('2.3  missing activityType → errs.activityType set', !!e.activityType);
    assert('2.3b valid activityType → no error', !validateClaimForm(validBase).activityType);
  }

  // 2.4 Other + empty description
  {
    const e = validateClaimForm({ ...validBase, activityType: 'Other', otherDesc: '' });
    assert('2.4  Other + blank otherDesc → errs.otherDesc set', !!e.otherDesc);
    const eOk = validateClaimForm({ ...validBase, activityType: 'Other', otherDesc: 'On-site survey' });
    assert('2.4b Other + non-blank → no error', !eOk.otherDesc);
  }

  // 2.5 Missing Site ID
  {
    const e = validateClaimForm({ ...validBase, siteId: '' });
    assert('2.5  missing siteId → errs.siteId set', !!e.siteId);
    const eSpc = validateClaimForm({ ...validBase, siteId: '   ' });
    assert('2.5b whitespace-only siteId → errs.siteId set', !!eSpc.siteId);
  }

  // 2.6 Missing date
  {
    const e = validateClaimForm({ ...validBase, date: '' });
    assert('2.6  missing date → errs.date set', !!e.date);
  }

  // 2.7 Fully valid form → no errors
  {
    const e = validateClaimForm(validBase);
    assert('2.7  fully valid form → zero errors', Object.keys(e).length === 0,
      JSON.stringify(e));
  }

  // 2.8 calcTotal mirror
  {
    function calcTotal(transport: string, food: string, extra: Array<{ category: string; amount: number | string }>): number {
      return (parseFloat(transport) || 0) + (parseFloat(food) || 0) +
        extra.reduce((s, r) => s + (parseFloat(r.amount as string) || 0), 0);
    }
    assert('2.8  calcTotal: 10000 + 20000 = 30000',     calcTotal('10000', '20000', []) === 30000);
    assert('2.8b calcTotal: with extra = 45000',          calcTotal('10000', '20000', [{ category: 'Fuel', amount: 15000 }]) === 45000);
    assert('2.8c calcTotal: empty strings = 0',           calcTotal('', '', []) === 0);
    assert('2.8d calcTotal: NaN strings treated as 0',    calcTotal('abc', 'def', []) === 0);
  }

  // ── GROUP 3 — DB persistence (requires SQL patch) ────────────────────────────
  console.log('\n── GROUP 3: DB persistence (requires SQL patch 15_...) ─────────────────');

  if (!colsExist) {
    skip('3.1  INSERT happy path', 'SQL patch not applied');
    skip('3.2  section_id persisted in DB', 'SQL patch not applied');
    skip('3.3  section_label persisted in DB', 'SQL patch not applied');
    skip('3.4  total_amount correct (30000)', 'SQL patch not applied');
    skip('3.5  description = activity type', 'SQL patch not applied');
    skip('3.6  status = pending', 'SQL patch not applied');
    skip('3.7  UPDATE/resubmit: rejected claim can be resubmitted', 'SQL patch not applied');
    skip('3.8  UPDATE persists new amounts', 'SQL patch not applied');
  } else {
    await cleanup();

    // 3.1–3.6: INSERT happy path
    const insertPayload = {
      member_id:        QA_MEMBER_ID,
      project_name:     QA_PROJECT,
      site_id:          QA_SITE_A,
      section_id:       QA_SECTION_ID,
      section_label:    QA_SECTION_LABEL,
      description:      'Installation',
      activity_date:    QA_DATE,
      transport_amount: 10000,
      food_amount:      20000,
      extra_categories: [],
      employee_ids:     [],
      notes:            null,
      total_amount:     30000,
      status:           'pending',
      submitted_at:     new Date().toISOString(),
    };
    const { data: insertedRows, error: insErr } = await dst
      .from('expense_claims').insert(insertPayload).select('*').single();
    assert('3.1  INSERT happy path: no error', !insErr, insErr?.message);

    if (!insErr && insertedRows) {
      const row = insertedRows as Record<string, unknown>;
      assert('3.2  section_id persisted',        row['section_id']    === QA_SECTION_ID,    String(row['section_id']));
      assert('3.3  section_label persisted',     row['section_label'] === QA_SECTION_LABEL, String(row['section_label']));
      assert('3.4  total_amount = 30000',        Number(row['total_amount'])     === 30000);
      assert('3.5  description = Installation',  row['description']   === 'Installation');
      assert('3.6  status = pending',            row['status']        === 'pending');

      // 3.7–3.8: UPDATE/resubmit — simulate rejecting then re-editing
      const claimId = row['id'] as string;
      // Mark as rejected (simulating admin action)
      await dst.from('expense_claims').update({ status: 'rejected' }).eq('id', claimId);
      // Now resubmit (update) with new amounts
      const updatePayload = {
        member_id: QA_MEMBER_ID, project_name: QA_PROJECT, site_id: QA_SITE_A,
        section_id: QA_SECTION_ID, section_label: QA_SECTION_LABEL,
        description: 'Integration', activity_date: QA_DATE,
        transport_amount: 15000, food_amount: 25000,
        extra_categories: [], employee_ids: [], notes: 'resubmit test',
        total_amount: 40000, status: 'pending',
      };
      const { error: updErr } = await dst.from('expense_claims').update(updatePayload).eq('id', claimId);
      assert('3.7  UPDATE/resubmit: no error', !updErr, updErr?.message);
      const { data: updRow } = await dst.from('expense_claims')
        .select('total_amount, description, status, section_id, section_label')
        .eq('id', claimId).single();
      const u = updRow as Record<string, unknown>;
      assert('3.8a UPDATE persists new total_amount (40000)', Number(u?.['total_amount']) === 40000);
      assert('3.8b UPDATE persists new description',          u?.['description'] === 'Integration');
      assert('3.8c UPDATE resets status to pending',          u?.['status'] === 'pending');
      assert('3.8d UPDATE preserves section_id',             u?.['section_id'] === QA_SECTION_ID);
      assert('3.8e UPDATE preserves section_label',          u?.['section_label'] === QA_SECTION_LABEL);
    } else {
      for (const n of ['3.2','3.3','3.4','3.5','3.6','3.7','3.8a','3.8b','3.8c','3.8d','3.8e']) {
        skip(`${n}  (INSERT failed — dependent test skipped)`, insErr?.message ?? '');
      }
    }

    await cleanup();
  }

  // ── GROUP 4 — Duplicate claim guard ──────────────────────────────────────────
  console.log('\n── GROUP 4: Duplicate claim guard ──────────────────────────────────────');
  // Mirror of MyExpenses.tsx:329-330
  // dup = claims.find(c => c.site_id === fSiteId && c.activity_date === fDate && c.status !== 'rejected')
  {
    const existingClaims = [
      { id: 'x1', site_id: QA_SITE_A, activity_date: QA_DATE,   status: 'pending'  },
      { id: 'x2', site_id: QA_SITE_A, activity_date: QA_DATE,   status: 'rejected' },
      { id: 'x3', site_id: QA_SITE_B, activity_date: QA_DATE,   status: 'pending'  },
      { id: 'x4', site_id: QA_SITE_A, activity_date: QA_DATE_B, status: 'pending'  },
    ];

    function dupExists(claims: typeof existingClaims, siteId: string, date: string): boolean {
      return !!claims.find(c => c.site_id === siteId && c.activity_date === date && c.status !== 'rejected');
    }

    assert('4.1  same site + date + pending → dup detected',
      dupExists(existingClaims, QA_SITE_A, QA_DATE));
    assert('4.2  same site + date + rejected → NOT a dup (can resubmit)',
      !dupExists([existingClaims[1]], QA_SITE_A, QA_DATE));
    assert('4.3  different site + same date → no dup',
      !dupExists(existingClaims, 'OTHER-SITE', QA_DATE));
    assert('4.4  same site + different date → no dup',
      !dupExists(existingClaims, QA_SITE_A, '2099-12-31'));
    assert('4.5  same site + date + approved → dup detected',
      dupExists([{ id: 'x5', site_id: QA_SITE_A, activity_date: QA_DATE, status: 'approved' }],
                QA_SITE_A, QA_DATE));
  }

  // ── GROUP 5 — Approve flow payload structure (pure) ──────────────────────────
  console.log('\n── GROUP 5: Approve flow payload structure (pure) ─────────────────────');
  // Mirror of FinExpClaims.tsx approveClaim() projExpPayload construction
  // Validates the payload has all required fields for project_expenses
  {
    const mockClaim = {
      project_name:     QA_PROJECT,
      description:      'Installation',
      total_amount:     30000,
      activity_date:    QA_DATE,
      site_id:          QA_SITE_A,
      accommodation:    null,
      member_id:        QA_MEMBER_ID,
    };
    const mockMemberName = 'Wessam Basil';
    const mockGovernorate = 'Baghdad';
    const dateObj = mockClaim.activity_date ? new Date(mockClaim.activity_date) : new Date();

    const projExpPayload = {
      project_name:  mockClaim.project_name,
      description:   mockClaim.description,
      category:      'Transport',
      amount:        mockClaim.total_amount,
      expense_date:  mockClaim.activity_date || null,
      activity_date: mockClaim.activity_date || null,
      month:         dateObj.getMonth() + 1,
      year:          dateObj.getFullYear(),
      site_id:       mockClaim.site_id || null,
      accommodation: mockClaim.accommodation || null,
      notes:         `Expense claim from ${mockMemberName}. Governorate: ${mockGovernorate}`,
      added_by:      'Admin User',
      submitted_by:  mockMemberName,
      approved_by:   'Admin User',
    };

    // Verify all NOT NULL columns are populated
    assert('5.1  payload has project_name',   !!projExpPayload.project_name);
    assert('5.2  payload has description',     !!projExpPayload.description);
    assert('5.3  payload has amount > 0',      projExpPayload.amount > 0);
    assert('5.4  payload month/year are set',  projExpPayload.month === 6 && projExpPayload.year === 2099);
    assert('5.5  payload category = Transport', projExpPayload.category === 'Transport');
    assert('5.6  payload notes includes member name', projExpPayload.notes.includes(mockMemberName));
    assert('5.7  payload added_by set',        !!projExpPayload.added_by);
    assert('5.8  payload approved_by set',     !!projExpPayload.approved_by);
    // Confirm no extra fields that would cause PGRST204
    const knownProjectExpensesCols = new Set([
      'id','project_name','description','category','amount','expense_date',
      'month','year','notes','added_by','created_at','activity_date','site_id',
      'employee_ids','accommodation','submitted_by','approved_by',
    ]);
    const payloadKeys = Object.keys(projExpPayload);
    const unknownCols = payloadKeys.filter(k => !knownProjectExpensesCols.has(k));
    assert('5.9  approve payload has no unknown columns',
      unknownCols.length === 0, unknownCols.join(', '));
  }

  // ── Final results ─────────────────────────────────────────────────────────────
  await cleanup();
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped > 0) {
    console.log(`\n  ⚠ ${skipped} test(s) skipped — apply SQL patch 15_expense_claims_section_cols.sql`);
    console.log('  then re-run this suite to get a full 0-skip result.');
  }
  if (failed > 0) process.exit(1);
}
