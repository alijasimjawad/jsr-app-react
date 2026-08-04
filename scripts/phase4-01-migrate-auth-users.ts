/**
 * Phase 4 — Step 1: migrate old JSR's `public.users` rows into the
 * destination project's Supabase Auth + `public.users`.
 *
 * RUN ONLY AFTER `scripts/phase4-00-preflight.ts` prints `PREFLIGHT: PASS`.
 * This script does NOT import or re-run that check itself (it's a separate
 * CLI script, not a library), but it repeats the same hardcoded
 * source/destination identity guard below as a second, independent line of
 * defense — it refuses to touch anything if the refs don't check out, even
 * if preflight was skipped or `.env.phase4.local` was edited since.
 *
 * WHAT THIS SCRIPT DOES:
 *   1. Reads `id, username, password, full_name, role, permissions,
 *      created_at` from the SOURCE (old JSR) `public.users` table.
 *      Read-only against source — nothing is ever written back to it.
 *   2. For each source user, builds the synthetic login email
 *      `username@jsr.internal` (same pattern as `buildAuthEmail()` in
 *      `src/config/brand.ts` — not imported directly here because that
 *      module pulls in Vite-only PNG asset imports that don't resolve
 *      under a standalone `tsx` run; the domain is duplicated as a
 *      constant below instead).
 *   3. Creates (or reuses) a Supabase Auth user in the DESTINATION project
 *      using that email and the source user's plaintext password. The
 *      password is used exactly once, as input to
 *      `supabase.auth.admin.createUser()` — Supabase Auth hashes it on
 *      write. This script never logs it, never writes it to a file, and
 *      never stores it in any destination column.
 *   4. Inserts (or updates) the destination `public.users` row with:
 *        - `id`          = the source row's ORIGINAL id, preserved as-is
 *                          (every other table's FK into `users` points at
 *                          this value, so it must never change).
 *        - `password`    = null, always — never the source value.
 *        - `auth_user_id`= the Auth UUID from step 3.
 *        - `username`, `role`, `full_name`, `permissions`, `created_at`
 *                        = copied as-is from source.
 *        - the 9 profile columns added by
 *          `docs/phase3-staging-schema/04_required_column_additions.sql`
 *          (`phone`, `national_id`, `date_of_birth`, `address`,
 *          `emergency_contact_name`, `emergency_contact_phone`,
 *          `start_date`, `notes`, `profile_photo_url`) = left null. Old
 *          JSR's live `users` table has no such columns to copy from; users
 *          fill these in later via "My Profile".
 *
 * IDEMPOTENCY (safe to re-run after a partial failure, in any order):
 *   Before ever calling a write API, every source user is classified into
 *   exactly one of five actions by reading (never writing) both projects:
 *     - SKIP         destination `users` row for this id already exists
 *                    AND already has `auth_user_id` set. Fully migrated
 *                    already — no Auth call, no insert, no update.
 *     - LINK-REUSE   destination row exists but `auth_user_id` is null, and
 *                    an Auth user for this email already exists in the
 *                    destination — update the row's `auth_user_id` only.
 *     - LINK-CREATE  destination row exists, `auth_user_id` is null, and no
 *                    Auth user exists yet for this email — create the Auth
 *                    user, then update the row's `auth_user_id`.
 *     - INSERT-REUSE destination row does not exist yet, but an Auth user
 *                    for this email already exists — insert the row using
 *                    that existing Auth UUID (no new Auth user created).
 *     - INSERT-CREATE destination row does not exist and no Auth user
 *                    exists for this email — create the Auth user, then
 *                    insert the row.
 *   This guarantees: never more than one Auth account per
 *   `username@jsr.internal` no matter how many times this script runs or
 *   where a previous run stopped, and a `users` row is inserted at most
 *   once per preserved source `id`.
 *
 * DRY RUN vs EXECUTE:
 *   By default this script performs a DRY RUN: it reads both projects
 *   (including the destination Auth user list, a read-only call) and
 *   prints exactly what it would do for every source user, but calls
 *   NEITHER `supabase.auth.admin.createUser()` NOR any `insert`/`update`
 *   against `public.users`. Pass `--execute` to actually perform the
 *   writes described above. There is no other way to make this script
 *   write anything.
 *
 * Usage:
 *   npx tsx scripts/phase4-01-migrate-auth-users.ts              # dry run
 *   npx tsx scripts/phase4-01-migrate-auth-users.ts --execute    # writes
 *
 * Credentials come from `.env.phase4.local` (same convention as
 * `phase4-00-preflight.ts` — see that file's header and
 * `docs/phase4-migration/PHASE4_MIGRATION_PLAN.md` section 5). Values
 * already present in the shell environment take precedence over the file.
 *
 * SCOPE — this script touches ONLY the destination `public.users` table
 * and the destination's Auth users. It does not touch any other table, and
 * it never enables or modifies Row-Level Security anywhere.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── 0. Load .env.phase4.local (best-effort, never overrides real env vars) ──
function loadDotEnvLocal(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(scriptDir, '..', '.env.phase4.local');
  if (!existsSync(envPath)) return;

  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnvLocal();

// ── 1. Hardcoded protected refs — same pinning as phase4-00-preflight.ts ───
const OLD_JSR_PROJECT_REF = 'tltbkjvrhqsxdspdfeqk';
const TAC_PROJECT_REF = 'gauejhgitzcqjvzalshf';

// The synthetic auth-email domain. Mirrors BRAND.authEmailDomain /
// buildAuthEmail() in src/config/brand.ts — duplicated here as a plain
// constant rather than imported, since that module is a frontend/Vite
// module (it imports PNG assets) and isn't meant to be loaded by a
// standalone Node script run via `tsx`.
const AUTH_EMAIL_DOMAIN = 'jsr.internal';

function buildAuthEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}

// ── 2. Env vars ──────────────────────────────────────────────────────────
const SOURCE_SUPABASE_URL = process.env.SOURCE_SUPABASE_URL;
const SOURCE_SUPABASE_SERVICE_ROLE_KEY = process.env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
const DEST_SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const DEST_SUPABASE_SERVICE_ROLE_KEY = process.env.DEST_SUPABASE_SERVICE_ROLE_KEY;
const EXPECTED_SOURCE_PROJECT_REF = process.env.EXPECTED_SOURCE_PROJECT_REF;
const EXPECTED_DEST_PROJECT_REF = process.env.EXPECTED_DEST_PROJECT_REF;

// ── 3. CLI flag — the ONLY thing that turns writes on ───────────────────────
const EXECUTE = process.argv.includes('--execute');

// ── 4. Types ─────────────────────────────────────────────────────────────
interface SourceUser {
  id: string;
  username: string;
  password: string | null;
  full_name: string | null;
  role: string;
  permissions: unknown;
  created_at: string | null;
}

interface DestUser {
  id: string;
  username: string;
  auth_user_id: string | null;
}

type Action = 'skip' | 'link-reuse' | 'link-create' | 'insert-reuse' | 'insert-create';

interface Plan {
  user: SourceUser;
  email: string;
  action: Action;
  existingAuthUserId: string | null; // set for *-reuse and skip
}

// ── 5. Helpers ───────────────────────────────────────────────────────────
function extractProjectRef(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co\/?$/i);
  return m ? m[1] : null;
}

/** Pages through a PostgREST table with .range(), returning every row. */
async function fetchAllRows<T>(
  client: SupabaseClient,
  table: string,
  columns: string,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`fetching ${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

/** Pages through supabase.auth.admin.listUsers(), returning email → id. */
async function fetchAllAuthUsersByEmail(dest: SupabaseClient): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>();
  const perPage = 1000;
  let page = 1;
  for (;;) {
    const { data, error } = await dest.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listing destination auth users: ${error.message}`);
    for (const u of data.users) {
      if (u.email) byEmail.set(u.email.toLowerCase(), u.id);
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  return byEmail;
}

// ── 6. Main ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`\n── Phase 4 Step 1 — Auth user migration (${EXECUTE ? 'EXECUTE' : 'DRY RUN'}) ──\n`);

  // 6a. Env presence.
  const requiredEnv: Record<string, string | undefined> = {
    SOURCE_SUPABASE_URL,
    SOURCE_SUPABASE_SERVICE_ROLE_KEY,
    DEST_SUPABASE_URL,
    DEST_SUPABASE_SERVICE_ROLE_KEY,
    EXPECTED_SOURCE_PROJECT_REF,
    EXPECTED_DEST_PROJECT_REF,
  };
  const missing = Object.entries(requiredEnv).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('ERROR: missing required env vars:', missing.join(', '));
    console.error('Set them in .env.phase4.local — see docs/phase4-migration/PHASE4_MIGRATION_PLAN.md section 5.');
    process.exit(1);
  }

  // 6b. Identity guard — independent of phase4-00-preflight.ts, refuses to
  // proceed (even in dry-run, to fail the same way every time) unless every
  // check passes.
  const sourceRef = extractProjectRef(SOURCE_SUPABASE_URL);
  const destRef = extractProjectRef(DEST_SUPABASE_URL);

  const guardFailures: string[] = [];
  if (sourceRef !== OLD_JSR_PROJECT_REF) {
    guardFailures.push(`SOURCE_SUPABASE_URL ref "${sourceRef ?? '(unresolved)'}" is not the known old-JSR ref (${OLD_JSR_PROJECT_REF})`);
  }
  if (sourceRef !== EXPECTED_SOURCE_PROJECT_REF) {
    guardFailures.push(`SOURCE_SUPABASE_URL ref "${sourceRef ?? '(unresolved)'}" does not match EXPECTED_SOURCE_PROJECT_REF ("${EXPECTED_SOURCE_PROJECT_REF}")`);
  }
  if (destRef !== EXPECTED_DEST_PROJECT_REF) {
    guardFailures.push(`DEST_SUPABASE_URL ref "${destRef ?? '(unresolved)'}" does not match EXPECTED_DEST_PROJECT_REF ("${EXPECTED_DEST_PROJECT_REF}")`);
  }
  if (destRef === OLD_JSR_PROJECT_REF) {
    guardFailures.push('DEST_SUPABASE_URL resolves to the live old-JSR project — refusing to write to it.');
  }
  if (destRef === TAC_PROJECT_REF) {
    guardFailures.push('DEST_SUPABASE_URL resolves to TAC\'s project — refusing to write to it.');
  }
  if (sourceRef !== null && destRef !== null && sourceRef === destRef) {
    guardFailures.push('SOURCE and DEST resolve to the same project — refusing to proceed.');
  }

  if (guardFailures.length) {
    console.error('ERROR: identity guard failed — nothing was read or written:');
    guardFailures.forEach(f => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log(`Source (read-only): ${sourceRef}`);
  console.log(`Destination:        ${destRef}\n`);

  const source = createClient(SOURCE_SUPABASE_URL!, SOURCE_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const dest = createClient(DEST_SUPABASE_URL!, DEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 6c. Read everything needed to build the plan. All read-only calls —
  // this section runs identically in dry-run and execute mode.
  console.log('Reading source users…');
  const sourceUsers = await fetchAllRows<SourceUser>(
    source,
    'users',
    'id, username, password, full_name, role, permissions, created_at',
  );
  console.log(`  found ${sourceUsers.length} source user(s).`);

  console.log('Reading destination users…');
  const destUsers = await fetchAllRows<DestUser>(dest, 'users', 'id, username, auth_user_id');
  const destById = new Map<string, DestUser>(destUsers.map(u => [u.id, u]));
  console.log(`  found ${destUsers.length} destination user row(s).`);

  console.log('Reading destination Auth users…');
  const authByEmail = await fetchAllAuthUsersByEmail(dest);
  console.log(`  found ${authByEmail.size} destination Auth user(s).\n`);

  // 6d. Build the plan — pure classification, no writes.
  const plans: Plan[] = [];
  const invalid: { user: SourceUser; reason: string }[] = [];

  for (const u of sourceUsers) {
    if (!u.username || !u.username.trim()) {
      invalid.push({ user: u, reason: 'missing username — cannot build auth email' });
      continue;
    }
    const email = buildAuthEmail(u.username);
    const existingRow = destById.get(u.id);
    const existingAuthId = authByEmail.get(email.toLowerCase()) ?? null;

    let action: Action;
    if (existingRow && existingRow.auth_user_id) {
      action = 'skip';
    } else if (existingRow && !existingRow.auth_user_id) {
      action = existingAuthId ? 'link-reuse' : 'link-create';
    } else if (existingAuthId) {
      action = 'insert-reuse';
    } else {
      action = 'insert-create';
    }

    if ((action === 'link-create' || action === 'insert-create') && !u.password) {
      invalid.push({ user: u, reason: 'no password on source row — cannot create a new Auth user' });
      continue;
    }

    if (existingRow && existingRow.username !== u.username) {
      console.log(`  NOTE  id ${u.id}: destination username "${existingRow.username}" differs from source username "${u.username}" — proceeding by id, not touching username on an existing row.`);
    }

    plans.push({
      user: u,
      email,
      action,
      existingAuthUserId: action === 'skip' || action === 'link-reuse' || action === 'insert-reuse' ? existingAuthId : null,
    });
  }

  // 6e. Print the plan (this is the dry-run preview — always printed, in
  // both modes, so EXECUTE runs show exactly what they're about to do).
  const counts: Record<Action, number> = {
    skip: 0, 'link-reuse': 0, 'link-create': 0, 'insert-reuse': 0, 'insert-create': 0,
  };
  for (const p of plans) {
    counts[p.action]++;
    const label =
      p.action === 'skip' ? 'SKIP  ' :
      p.action === 'link-reuse' ? 'LINK  ' :
      p.action === 'link-create' ? 'LINK+CREATE' :
      p.action === 'insert-reuse' ? 'INSERT' : 'INSERT+CREATE';
    const detail =
      p.action === 'skip' ? 'already fully migrated' :
      p.action === 'link-reuse' ? `row exists, reuse existing auth user (${p.existingAuthUserId})` :
      p.action === 'link-create' ? 'row exists, will create new auth user and link it' :
      p.action === 'insert-reuse' ? `reuse existing auth user (${p.existingAuthUserId}), insert row` :
      'create new auth user, insert row';
    console.log(`  [${label}] ${p.user.username} (id=${p.user.id}) → ${p.email} — ${detail}`);
  }
  for (const inv of invalid) {
    console.log(`  [SKIP-INVALID] id=${inv.user.id} username=${inv.user.username ?? '(none)'} — ${inv.reason}`);
  }

  console.log('\n── Plan summary ─────────────────────────────');
  console.log(`  Already migrated (skip)        : ${counts.skip}`);
  console.log(`  Link existing auth (reuse)     : ${counts['link-reuse']}`);
  console.log(`  Link + create new auth         : ${counts['link-create']}`);
  console.log(`  Insert row, reuse existing auth: ${counts['insert-reuse']}`);
  console.log(`  Insert row + create new auth   : ${counts['insert-create']}`);
  console.log(`  Invalid / cannot process       : ${invalid.length}`);
  console.log('───────────────────────────────────────────────');
  console.log('Scope: only public.users (destination) and destination Auth users are read/written.');
  console.log('No other table is touched. RLS is not enabled or modified by this script.\n');

  if (!EXECUTE) {
    console.log('DRY RUN complete — no writes were made. Re-run with --execute to apply.');
    return;
  }

  // 6f. Execute — apply exactly the plan just printed above.
  let created = 0, reused = 0, inserted = 0, linked = 0, skipped = counts.skip, failed = 0;
  const failures: { username: string; reason: string }[] = [];

  for (const p of plans) {
    const u = p.user;
    try {
      if (p.action === 'skip') {
        continue;
      }

      let authUserId = p.existingAuthUserId;

      if (p.action === 'link-create' || p.action === 'insert-create') {
        const { data: authData, error: authErr } = await dest.auth.admin.createUser({
          email: p.email,
          password: u.password!,
          email_confirm: true,
          user_metadata: { full_name: u.full_name, role: u.role },
        });

        if (authErr) {
          // Race: another run/process created this email between our
          // listUsers() snapshot and now. Re-look-up instead of failing.
          if (authErr.message.includes('already been registered') || (authErr as { code?: string }).code === 'email_exists') {
            const { data: relist, error: relistErr } = await dest.auth.admin.listUsers({ page: 1, perPage: 1000 });
            const found = !relistErr && relist.users.find(au => au.email?.toLowerCase() === p.email.toLowerCase());
            if (found) {
              authUserId = found.id;
              reused++;
            } else {
              throw new Error(`createUser reported duplicate but re-lookup found nothing: ${authErr.message}`);
            }
          } else {
            throw new Error(authErr.message);
          }
        } else {
          authUserId = authData.user?.id ?? null;
          if (!authUserId) throw new Error('createUser succeeded but returned no user id');
          created++;
        }
      } else {
        reused++;
      }

      if (!authUserId) throw new Error('no auth_user_id resolved — internal logic error');

      if (p.action === 'link-reuse' || p.action === 'link-create') {
        const { error: updateErr } = await dest
          .from('users')
          .update({ auth_user_id: authUserId })
          .eq('id', u.id);
        if (updateErr) throw new Error(`auth user OK but updating users.auth_user_id failed: ${updateErr.message}`);
        linked++;
        console.log(`  LINK   ${u.username} (id=${u.id}) → auth_user_id=${authUserId}`);
      } else {
        const { error: insertErr } = await dest.from('users').insert({
          id: u.id,
          username: u.username,
          password: null,
          role: u.role,
          full_name: u.full_name,
          permissions: u.permissions,
          created_at: u.created_at,
          auth_user_id: authUserId,
          phone: null,
          national_id: null,
          date_of_birth: null,
          address: null,
          emergency_contact_name: null,
          emergency_contact_phone: null,
          start_date: null,
          notes: null,
          profile_photo_url: null,
        });
        if (insertErr) throw new Error(`auth user OK but inserting users row failed: ${insertErr.message}`);
        inserted++;
        console.log(`  OK     ${u.username} (id=${u.id}) → ${p.email} (auth_user_id=${authUserId})`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`  FAIL   ${u.username} (id=${u.id}): ${reason}`);
      failures.push({ username: u.username, reason });
      failed++;
    }
  }

  console.log('\n── Execute summary ──────────────────────────');
  console.log(`  Auth users created : ${created}`);
  console.log(`  Auth users reused  : ${reused}`);
  console.log(`  users rows inserted: ${inserted}`);
  console.log(`  users rows linked  : ${linked}`);
  console.log(`  Already migrated   : ${skipped}`);
  console.log(`  Invalid / skipped  : ${invalid.length}`);
  console.log(`  Failed             : ${failed}`);
  if (failures.length) {
    console.log('\n  Failures (safe to re-run this script — it will resume from here):');
    failures.forEach(f => console.log(`    ${f.username}: ${f.reason}`));
  }
  console.log('───────────────────────────────────────────────');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Migration script crashed unexpectedly:', e instanceof Error ? e.message : e);
  process.exit(1);
});
