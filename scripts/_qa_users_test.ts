/**
 * Users / User Management QA suite.
 *
 * Tests admin-user-ops Edge Function (all 4 ops) + public.users + auth.users
 * consistency. Uses the service-role key so no admin credentials needed.
 *
 * Groups:
 *   GROUP 1  — Schema: public.users columns and constraints
 *   GROUP 2  — create: happy path — public.users row + auth.users entry created
 *   GROUP 3  — create: duplicate username blocked
 *   GROUP 4  — create: missing required fields blocked
 *   GROUP 5  — update_username: auth email updated, public.users reflected separately
 *   GROUP 6  — reset_password: new password accepted by Supabase Auth
 *   GROUP 7  — delete: public.users + auth.users both removed
 *   GROUP 8  — create: orphan safety — no orphan left after DB conflict
 *   GROUP 9  — error: unknown op returns error
 *   GROUP 10 — error: non-admin caller blocked (user JWT)
 *   GROUP 11 — Production data: existing real users untouched
 *
 * Run: npx tsx scripts/_qa_users_test.ts
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

const SUPABASE_URL = process.env.DEST_SUPABASE_URL!;
const SERVICE_KEY  = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY!;
const FN_URL       = `${SUPABASE_URL}/functions/v1/admin-user-ops`;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_SERVICE_ROLE_KEY must be set (in .env.phase4.local)');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// QA fixtures
const QA_USERNAME   = 'qa.user.mgmt.test';
const QA_USERNAME_2 = 'qa.user.mgmt.renamed';
const QA_PASS_1     = 'QA_Pass_111!';
const QA_PASS_2     = 'QA_Pass_222!';
const QA_FULL_NAME  = 'QA User Management Test';
const QA_ROLE       = 'technician';

// Known real user: admin (must exist, must not be modified)
const REAL_ADMIN_USERNAME = 'admin';

let passed = 0; let failed = 0;

function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS   ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL   ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

async function callFn(body: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; status: number; raw: string }> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = { error: raw }; }
  return { ok: res.ok, data, status: res.status, raw };
}

// ── Pre-flight cleanup ────────────────────────────────────────────────────────
async function cleanup() {
  for (const uname of [QA_USERNAME, QA_USERNAME_2]) {
    const { data: rows } = await sb.from('users').select('id, auth_user_id').eq('username', uname);
    if (rows && rows.length > 0) {
      for (const r of rows as { id: string; auth_user_id: string | null }[]) {
        await sb.from('users').delete().eq('id', r.id);
        if (r.auth_user_id) await sb.auth.admin.deleteUser(r.auth_user_id);
      }
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
let createdUserId: string | null    = null;
let createdAuthId: string | null    = null;

async function run() {
  console.log('\n══════════════════════════════════════════════════');
  console.log(' Users / User Management QA Suite');
  console.log('══════════════════════════════════════════════════\n');

  await cleanup();

  // ── GROUP 1 — Schema ───────────────────────────────────────────────────────
  console.log('── GROUP 1: Schema ────────────────────────────────');

  // Verify expected columns exist by selecting them — PostgREST rejects unknown columns
  const { data: schemaRow, error: schemaErr } = await sb
    .from('users')
    .select('id, username, auth_user_id, full_name, role, permissions')
    .limit(1);

  assert('1.1 — public.users has id column',           !schemaErr, schemaErr?.message);
  assert('1.2 — public.users has username column',     !schemaErr, schemaErr?.message);
  assert('1.3 — public.users has auth_user_id column', !schemaErr, schemaErr?.message);
  assert('1.4 — public.users has full_name column',    !schemaErr, schemaErr?.message);
  assert('1.5 — public.users has role column',         !schemaErr, schemaErr?.message);
  assert('1.6 — public.users has permissions column',  !schemaErr, schemaErr?.message);

  // Verify unique constraint on username: duplicate insert should fail
  const { data: dupCheck } = await sb.from('users').select('username').limit(1);
  const sampleUsername = (dupCheck as { username: string }[] | null)?.[0]?.username;
  const { error: dupInsertErr } = await sb
    .from('users')
    .insert({ username: sampleUsername, full_name: 'Schema Test', role: 'user' });
  assert('1.7 — username unique constraint enforced (duplicate blocked)',
    !!dupInsertErr && dupInsertErr.code === '23505',
    dupInsertErr ? `code=${dupInsertErr.code}` : 'no error — duplicate was allowed!');

  // Verify unique constraint on auth_user_id: grab a real auth_user_id and try to re-insert
  const { data: authIdRow } = await sb.from('users').select('auth_user_id').not('auth_user_id', 'is', null).limit(1);
  const sampleAuthId = (authIdRow as { auth_user_id: string }[] | null)?.[0]?.auth_user_id;
  const { error: authDupErr } = await sb
    .from('users')
    .insert({ username: 'qa.unique.check.tmp', full_name: 'Dup Auth Test', role: 'user', auth_user_id: sampleAuthId });
  assert('1.8 — auth_user_id unique constraint enforced (duplicate blocked)',
    !!authDupErr && authDupErr.code === '23505',
    authDupErr ? `code=${authDupErr.code}` : 'no error — duplicate was allowed!');

  // ── GROUP 2 — create: happy path ───────────────────────────────────────────
  console.log('\n── GROUP 2: create — happy path ───────────────────');

  const r2 = await callFn({ op: 'create', fullName: QA_FULL_NAME, username: QA_USERNAME, password: QA_PASS_1, role: QA_ROLE });
  const newUser = (r2.data as { data?: { id: string; username: string; auth_user_id: string; role: string; permissions: Record<string, unknown> } })?.data;

  assert('2.1 — create returns HTTP 200',          r2.ok, `status=${r2.status} body=${r2.raw}`);
  assert('2.2 — response contains data.id',        !!newUser?.id, r2.raw);
  assert('2.3 — response username matches',        newUser?.username === QA_USERNAME);
  assert('2.4 — response role matches',            newUser?.role === QA_ROLE);
  assert('2.5 — response auth_user_id is set',     !!newUser?.auth_user_id);
  assert('2.6 — response permissions is empty obj', JSON.stringify(newUser?.permissions) === '{}');

  if (newUser?.id) {
    createdUserId = newUser.id;
    createdAuthId = newUser.auth_user_id;

    // Verify in DB
    const { data: dbUser } = await sb.from('users').select('*').eq('id', createdUserId).single();
    assert('2.7 — public.users row exists',         !!dbUser, `id=${createdUserId}`);
    assert('2.8 — public.users username correct',   (dbUser as { username?: string })?.username === QA_USERNAME);
    assert('2.9 — public.users full_name correct',  (dbUser as { full_name?: string })?.full_name === QA_FULL_NAME);

    // Verify auth.users
    const { data: authUser } = await sb.auth.admin.getUserById(createdAuthId!);
    assert('2.10 — auth.users entry exists',        !!authUser.user, `auth_id=${createdAuthId}`);
    assert('2.11 — auth.users email is username@jsr.internal',
      authUser.user?.email === `${QA_USERNAME}@jsr.internal`,
      `got ${authUser.user?.email}`);
    assert('2.12 — auth.users email_confirmed_at set (confirm=true)',
      !!authUser.user?.email_confirmed_at);
  } else {
    // Mark remaining tests in this group as skipped/failed
    for (let i = 7; i <= 12; i++) assert(`2.${i} — (skipped — create failed)`, false);
  }

  // ── GROUP 3 — create: duplicate username blocked ───────────────────────────
  console.log('\n── GROUP 3: create — duplicate username blocked ───');

  const r3 = await callFn({ op: 'create', fullName: 'Dupe Test', username: QA_USERNAME, password: QA_PASS_1 });
  assert('3.1 — duplicate username returns error',    !r3.ok || !!(r3.data as { error?: string })?.error, r3.raw);
  const r3msg = (r3.data as { error?: string })?.error ?? '';
  assert('3.2 — error mentions "already taken" or "exists"',
    r3msg.toLowerCase().includes('taken') || r3msg.toLowerCase().includes('exist') || r3msg.toLowerCase().includes('already'),
    r3msg);

  // No orphan left in auth.users
  const { data: dupAuthRows } = await sb.auth.admin.listUsers();
  const dupFound = (dupAuthRows?.users ?? []).filter(u => u.email === `${QA_USERNAME}@jsr.internal`);
  assert('3.3 — no extra orphan auth user from duplicate attempt', dupFound.length <= 1);

  // ── GROUP 4 — create: missing required fields ──────────────────────────────
  console.log('\n── GROUP 4: create — missing required fields ──────');

  const r4a = await callFn({ op: 'create', username: QA_USERNAME, password: QA_PASS_1 });
  assert('4.1 — missing fullName returns error', !r4a.ok || !!(r4a.data as { error?: string })?.error, r4a.raw);

  const r4b = await callFn({ op: 'create', fullName: 'X', password: QA_PASS_1 });
  assert('4.2 — missing username returns error', !r4b.ok || !!(r4b.data as { error?: string })?.error, r4b.raw);

  const r4c = await callFn({ op: 'create', fullName: 'X', username: 'qa.no.pass' });
  assert('4.3 — missing password returns error', !r4c.ok || !!(r4c.data as { error?: string })?.error, r4c.raw);

  // ── GROUP 5 — update_username ──────────────────────────────────────────────
  console.log('\n── GROUP 5: update_username ───────────────────────');

  if (createdUserId && createdAuthId) {
    const r5 = await callFn({ op: 'update_username', userId: createdUserId, newUsername: QA_USERNAME_2 });
    assert('5.1 — update_username returns 200', r5.ok, `status=${r5.status} body=${r5.raw}`);
    assert('5.2 — response is success:true', (r5.data as { success?: boolean })?.success === true, r5.raw);

    // Verify auth email updated
    const { data: authUser } = await sb.auth.admin.getUserById(createdAuthId);
    assert('5.3 — auth.users email updated to new username@jsr.internal',
      authUser.user?.email === `${QA_USERNAME_2}@jsr.internal`,
      `got ${authUser.user?.email}`);

    // Manually update public.users.username to match (mirrors frontend behaviour)
    await sb.from('users').update({ username: QA_USERNAME_2 }).eq('id', createdUserId);
    const { data: dbUser } = await sb.from('users').select('username').eq('id', createdUserId).single();
    assert('5.4 — public.users username updated', (dbUser as { username?: string })?.username === QA_USERNAME_2);
  } else {
    for (let i = 1; i <= 4; i++) assert(`5.${i} — (skipped — no created user)`, false);
  }

  // ── GROUP 6 — reset_password ───────────────────────────────────────────────
  console.log('\n── GROUP 6: reset_password ────────────────────────');

  if (createdUserId && createdAuthId) {
    const r6 = await callFn({ op: 'reset_password', userId: createdUserId, newPassword: QA_PASS_2 });
    assert('6.1 — reset_password returns 200', r6.ok, `status=${r6.status} body=${r6.raw}`);
    assert('6.2 — response is success:true', (r6.data as { success?: boolean })?.success === true, r6.raw);

    // Verify new password works by signing in
    const anonSb = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY ?? SERVICE_KEY, { auth: { persistSession: false } });
    const { data: signIn, error: signInErr } = await anonSb.auth.signInWithPassword({
      email: `${QA_USERNAME_2}@jsr.internal`,
      password: QA_PASS_2,
    });
    assert('6.3 — new password accepted by Supabase Auth', !!signIn?.session && !signInErr, signInErr?.message);
    if (signIn?.session) {
      await anonSb.auth.signOut();
    }

    // Verify old password rejected
    const { data: oldSign, error: oldErr } = await anonSb.auth.signInWithPassword({
      email: `${QA_USERNAME_2}@jsr.internal`,
      password: QA_PASS_1,
    });
    assert('6.4 — old password rejected', !oldSign?.session || !!oldErr);
  } else {
    for (let i = 1; i <= 4; i++) assert(`6.${i} — (skipped — no created user)`, false);
  }

  // ── GROUP 7 — delete ───────────────────────────────────────────────────────
  console.log('\n── GROUP 7: delete ────────────────────────────────');

  if (createdUserId && createdAuthId) {
    const r7 = await callFn({ op: 'delete', userId: createdUserId });
    assert('7.1 — delete returns 200', r7.ok, `status=${r7.status} body=${r7.raw}`);
    assert('7.2 — response is success:true', (r7.data as { success?: boolean })?.success === true, r7.raw);

    const { data: dbCheck } = await sb.from('users').select('id').eq('id', createdUserId);
    assert('7.3 — public.users row removed', !dbCheck || (dbCheck as unknown[]).length === 0);

    const { data: authCheck } = await sb.auth.admin.getUserById(createdAuthId);
    assert('7.4 — auth.users entry removed', !authCheck.user, `still present: ${authCheck.user?.id}`);

    createdUserId = null;
    createdAuthId = null;
  } else {
    for (let i = 1; i <= 4; i++) assert(`7.${i} — (skipped — no created user)`, false);
  }

  // ── GROUP 8 — orphan safety ────────────────────────────────────────────────
  console.log('\n── GROUP 8: orphan safety (DB conflict rolls back auth user) ──');

  // Create an auth user directly, then try to create a public.users row with a
  // username that already exists — this simulates the auth-succeeds/db-fails scenario.
  // The function should roll back the auth user it created.
  //
  // To force a DB conflict: create a real user first, then attempt a duplicate.
  const setupR = await callFn({ op: 'create', fullName: 'Orphan Setup', username: 'qa.orphan.setup', password: QA_PASS_1 });
  const setupUser = (setupR.data as { data?: { id: string; auth_user_id: string } })?.data;

  if (setupUser?.id) {
    // Attempt duplicate — auth user creation might succeed but DB insert must fail
    const dupeR = await callFn({ op: 'create', fullName: 'Orphan Dupe', username: 'qa.orphan.setup', password: QA_PASS_1 });
    assert('8.1 — duplicate attempt returns error', !dupeR.ok || !!(dupeR.data as { error?: string })?.error, dupeR.raw);

    // Count auth users with this email — should be exactly 1 (no orphan)
    const { data: allUsers } = await sb.auth.admin.listUsers({ perPage: 1000 });
    const orphanCount = (allUsers?.users ?? []).filter(u => u.email === 'qa.orphan.setup@jsr.internal').length;
    assert('8.2 — no orphan auth user left after duplicate attempt', orphanCount === 1,
      `found ${orphanCount} auth users with this email`);

    // Cleanup setup user
    await sb.from('users').delete().eq('id', setupUser.id);
    await sb.auth.admin.deleteUser(setupUser.auth_user_id);
  } else {
    assert('8.1 — (skipped — setup user creation failed)', false, setupR.raw);
    assert('8.2 — (skipped)', false);
  }

  // ── GROUP 9 — error: unknown op ────────────────────────────────────────────
  console.log('\n── GROUP 9: error — unknown op ────────────────────');

  const r9 = await callFn({ op: 'nonexistent_op' });
  assert('9.1 — unknown op returns error', !r9.ok || !!(r9.data as { error?: string })?.error, r9.raw);
  assert('9.2 — error message mentions op', ((r9.data as { error?: string })?.error ?? '').includes('nonexistent_op'), r9.raw);

  // ── GROUP 10 — error: non-admin caller blocked ─────────────────────────────
  console.log('\n── GROUP 10: error — non-admin caller blocked ──────');

  // Create a non-admin user, sign in as them, try calling the function
  const nonAdminSetup = await callFn({
    op: 'create', fullName: 'QA Non Admin', username: 'qa.nonadmin.block', password: QA_PASS_1, role: 'user',
  });
  const nonAdminUser = (nonAdminSetup.data as { data?: { id: string; auth_user_id: string } })?.data;

  if (nonAdminUser?.id) {
    const anonSb = createClient(SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY ?? SERVICE_KEY, { auth: { persistSession: false } });
    const { data: nonAdminSession } = await anonSb.auth.signInWithPassword({
      email: 'qa.nonadmin.block@jsr.internal',
      password: QA_PASS_1,
    });

    if (nonAdminSession?.session?.access_token) {
      const r10 = await fetch(FN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nonAdminSession.session.access_token}`,
        },
        body: JSON.stringify({ op: 'create', fullName: 'Should Fail', username: 'qa.blocked.user', password: QA_PASS_1 }),
      });
      const r10body = await r10.text();
      assert('10.1 — non-admin user gets 403', r10.status === 403, `status=${r10.status} body=${r10body}`);
      assert('10.2 — error says "Admin access required"',
        r10body.includes('Admin access required'),
        r10body);
      await anonSb.auth.signOut();
    } else {
      assert('10.1 — (skipped — could not sign in as non-admin)', false);
      assert('10.2 — (skipped)', false);
    }

    // Cleanup non-admin user
    await sb.from('users').delete().eq('id', nonAdminUser.id);
    await sb.auth.admin.deleteUser(nonAdminUser.auth_user_id);
  } else {
    assert('10.1 — (skipped — setup failed)', false, nonAdminSetup.raw);
    assert('10.2 — (skipped)', false);
  }

  // ── GROUP 11 — Production data: real users untouched ──────────────────────
  console.log('\n── GROUP 11: production data — real users untouched ');

  const { data: realAdmin } = await sb.from('users').select('id, username, role').eq('username', REAL_ADMIN_USERNAME).single();
  assert('11.1 — admin user still exists in public.users',       !!realAdmin);
  assert('11.2 — admin role is still "admin"',                   (realAdmin as { role?: string })?.role === 'admin');

  const { data: allUsers } = await sb.from('users').select('id');
  const totalUsers = (allUsers as unknown[] | null)?.length ?? 0;
  assert('11.3 — at least 5 real users still present',           totalUsers >= 5, `count=${totalUsers}`);

  // ── Final summary ──────────────────────────────────────────────────────────
  await cleanup();

  const total = passed + failed;
  console.log('\n══════════════════════════════════════════════════');
  console.log(` RESULT: ${passed}/${total} passed, ${failed} failed`);
  console.log('══════════════════════════════════════════════════\n');

  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
