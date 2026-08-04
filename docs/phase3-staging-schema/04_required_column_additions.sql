-- ============================================================================
-- Phase 3 Step 2 — 04: Required column additions (your items 4 & 5)
-- ============================================================================
-- Run AFTER 01-03. Adds the columns confirmed missing from live JSR's
-- `users` and `team_members` tables that jsr-app-react's code requires.
-- ============================================================================

-- ── team_members: add username (item 4) ─────────────────────────────────
-- Confirmed missing live. src/components/NotificationBell.tsx does
-- `.from('team_members').select('id, full_name, username, is_active')` and
-- matches the logged-in user by it — that query fails against live JSR's
-- team_members table today. Nullable for now since there's no existing
-- data to backfill it from in staging yet (per your item 9, no production
-- data migration in this step) — decide before go-live whether it should
-- become NOT NULL / unique once populated.
alter table public.team_members
  add column if not exists username text;

-- ── users: add auth_user_id + 9 profile columns (item 5) ────────────────
-- The 9 profile columns (phone through profile_photo_url) exactly mirror
-- react_migration_phase14_sql.sql, which added these same columns to
-- public.users on TAC's Supabase project. That file's own header explains
-- why: some accounts (e.g. company owners) have no row in team_members
-- (which is payroll-staff-only), so these columns let any logged-in user
-- maintain their own profile via "My Profile" independent of HR Profiles.
--
-- auth_user_id is NOT in phase14 or any other committed migration file —
-- grepped for it across every .sql file in this repo and found no CREATE/
-- ALTER that defines it anywhere. It was evidently added directly via the
-- Supabase dashboard on TAC's project and never captured in committed SQL.
-- The definition below (nullable, unique, FK to auth.users) is a reasonable
-- standard default inferred from how react_migration_phase13_sql.sql and
-- scripts/migrate-users-to-auth.ts both use it (a 1:1 link to an
-- auth.users.id, resolved via `auth.uid()` in RLS policies) — but it has
-- NOT been confirmed against TAC's actual live column definition. Worth a
-- quick check of TAC's real `auth_user_id` column (type/nullable/FK/unique)
-- before this file is run, in case the live definition differs in some
-- small way (e.g. no FK, or ON DELETE CASCADE instead of SET NULL).
--
-- PROVISIONAL — approved to keep as nullable/unique/FK-to-auth.users/ON
-- DELETE SET NULL for now, but this definition is not final. It has not
-- been exercised against a real Auth migration yet (that's Phase 3 Step 3,
-- still ahead). Treat it as subject to change once Auth migration testing
-- against this staging project confirms the actual linkage behavior needed
-- (e.g. whether SET NULL vs. CASCADE is right, whether it should stay
-- nullable once every user has a linked auth.users row, etc.) — do not
-- treat this column definition as locked in until that testing is done.
alter table public.users
  add column if not exists auth_user_id             uuid unique references auth.users(id) on delete set null,
  add column if not exists phone                     text,
  add column if not exists national_id               text,
  add column if not exists date_of_birth              date,
  add column if not exists address                    text,
  add column if not exists emergency_contact_name     text,
  add column if not exists emergency_contact_phone    text,
  add column if not exists start_date                 date,
  add column if not exists notes                       text,
  add column if not exists profile_photo_url           text;
