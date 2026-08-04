-- ============================================================================
-- Phase 3 Step 2 — 01: Extensions + core, dependency-free tables
-- ============================================================================
-- TARGET: the NEW staging project ("JSR Network Tracker React") ONLY.
-- Do NOT run against tltbkjvrhqsxdspdfeqk (live JSR) or gauejhgitzcqjvzalshf
-- (TAC). Verify the project ref in the dashboard URL before running anything
-- in this folder — see STAGING_EXECUTION_CHECKLIST.md.
--
-- Nothing here has been executed. Files only, per your instructions.
--
-- Column definitions in this file for `users`, `team_members`, `clients`,
-- `sections`, `activity_log`, `revenue`, `general_expenses`,
-- `daily_activities` come from the live Phase 2C/2D production audit
-- (docs/schema-audit-results/*.csv) — confirmed against real columns,
-- EXCEPT `revenue`, `rows` (in file 02), and `sections`, which were never
-- captured in a live column export (see the note directly above the
-- `sections` table below and the checklist's "confidence" table). Those
-- three use Phase 2B's static-file/React-code inference instead, cross-
-- checked against the live-confirmed PK/FK/unique/index metadata that DOES
-- exist for them. Flagging this explicitly rather than presenting it as
-- equally certain as the other 14 tables.
-- ============================================================================

create extension if not exists pgcrypto;

-- uuid-ossp must be created BEFORE public.users below, since that table's
-- `id` column default calls uuid_generate_v4() — Postgres resolves a column
-- default's function reference at CREATE TABLE time, so the extension has
-- to exist first. (Corrected: this statement previously sat after the
-- `users` table, which would fail with "function uuid_generate_v4() does
-- not exist" on a brand-new project — caught in the pre-execution review.)
create extension if not exists "uuid-ossp";

-- ── users (base columns only — auth_user_id + profile columns added in 04) ─
-- Live-confirmed via docs/schema-audit-results/12_missing_core_tables_schema.csv
--
-- `password` is nullable here, NOT `not null` like live JSR's real column —
-- an intentional deviation approved as part of the Phase 4 schema patch.
-- Phase 4's Auth migration uses each source password exactly once, as input
-- to auth.admin.createUser(), and never writes it into this column at the
-- destination — migrated rows get password = null. Nullable is required for
-- that insert to succeed. Plan is to drop this column entirely once Auth
-- migration + rollback testing are both verified working against this
-- staging project; keeping it (nullable, unpopulated after migration) for
-- now rather than dropping it up front.
create table if not exists public.users (
  id           uuid        primary key default uuid_generate_v4(),
  username     text        not null unique,
  password     text,
  role         text        not null default 'user',
  created_at   timestamptz default now(),
  full_name    text,
  permissions  jsonb       default '{}'::jsonb
);
-- Note: live JSR uses uuid_generate_v4() as this column's default, not
-- gen_random_uuid() (unlike every other table's `id`). Preserved as-is for
-- parity.

-- ── team_members (base columns only — username added in 04) ────────────────
-- Live-confirmed via docs/schema-audit-results/12_missing_core_tables_schema.csv
create table if not exists public.team_members (
  id                       uuid        primary key default gen_random_uuid(),
  full_name                text        not null,
  monthly_salary           numeric,
  role                     text,
  is_active                boolean     default true,
  created_at               timestamptz default now(),
  phone                    text,
  notes                    text,
  national_id              text,
  date_of_birth            date,
  address                  text,
  emergency_contact_name   text,
  emergency_contact_phone  text,
  start_date               date,
  profile_photo_url        text,
  activated_at             date,
  deactivated_at           date
);

-- ── clients ──────────────────────────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.clients (
  id              uuid        primary key default gen_random_uuid(),
  created_at      timestamptz default now(),
  company_name    text        not null,
  contact_person  text,
  email           text,
  phone           text,
  address         text,
  notes           text
);

-- ── activity_log ─────────────────────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.activity_log (
  id              uuid        primary key default gen_random_uuid(),
  user_full_name  text,
  action          text,
  project_name    text,
  section_name    text,
  details         text,
  created_at      timestamptz default now()
);

-- ── general_expenses ─────────────────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.general_expenses (
  id           uuid        primary key default gen_random_uuid(),
  description  text        not null,
  category     text,
  amount       numeric(15,0) not null,
  expense_date date,
  month        integer,
  year         integer,
  notes        text,
  added_by     text,
  created_at   timestamptz default now()
);

-- ── daily_activities ─────────────────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv (13 columns;
-- ordinal 3 has a gap in the live export, presumably a previously-dropped
-- column — not recreated here, only the columns that actually exist today).
--
-- IMPORTANT — scope note, not something I've added: jsr-app-react's own
-- react_migration_phase17-21 SQL files add ~13 more columns to this table
-- on TAC's project (car_id, driver_id, start_lat/lng, trip_distance_km,
-- target_lat/lng, trip_stops, trip_legs, round_trip, etc.) for the car-trip
-- feature. None of those exist on live JSR today, and you didn't list them
-- in your Step 2 requirements, so this file does NOT add them. If the car-
-- trip feature needs to work in JSR, that's a separate, explicit follow-up
-- (mirroring phases 17-21) — flagging so it isn't silently missed later.
create table if not exists public.daily_activities (
  id                uuid        primary key default gen_random_uuid(),
  date              date        not null default current_date,
  site_id           text        not null,
  activity_type     text        not null,
  team_member_ids   text[]      default '{}'::text[],
  team_member_names text[]      default '{}'::text[],
  notes             text,
  status            text        default 'In Progress',
  created_by        text,
  created_at        timestamptz default now(),
  governate         text        default '',
  project           text
);

-- ── sections ─────────────────────────────────────────────────────────────
-- RESOLVED as part of the Phase 4 schema patch: the original
-- /Users/alijasim/Desktop/JSR/supabase_setup.sql (old JSR's own real
-- schema-creation script) was located and confirms every column below,
-- superseding the Phase 2B static-file/React-code inference this table
-- previously relied on. `section_label`, `columns`, `is_custom`, and
-- `is_deleted` are all NOT NULL live — this file previously left them
-- nullable before that primary source was found; corrected now.
-- `custom_columns` stays nullable, matching the original (added there via a
-- later separate ALTER, same as here).
create table if not exists public.sections (
  id              uuid        primary key default gen_random_uuid(),
  project_name    text        not null,
  section_name    text        not null,
  section_label   text        not null,
  columns         jsonb       not null default '[]'::jsonb,
  custom_columns  jsonb       default '[]'::jsonb,
  is_custom       boolean     not null default false,
  is_deleted      boolean     not null default false,
  created_at      timestamptz default now(),
  constraint sections_project_section_unique unique (project_name, section_name)
);

-- ── revenue ──────────────────────────────────────────────────────────────
-- NOT live-column-confirmed (see file header note). Only `id` as PK is
-- live-confirmed (primary_keys.csv); no FK, no unique constraint, no named
-- index beyond the PK is recorded for this table in the live audit. Columns
-- below are Phase 2B's inference from React's `.select('project_name,
-- site_id, amount, month, year')` call — likely a subset of the true live
-- columns, not necessarily the complete set. Recommend confirming with a
-- live column export before running this file — see checklist.
create table if not exists public.revenue (
  id            uuid        primary key default gen_random_uuid(),
  project_name  text,
  site_id       text,
  amount        numeric,
  month         integer,
  year          integer,
  created_at    timestamptz default now()
);

-- ── sites (React-only, new, empty — no live JSR equivalent) ────────────────
-- No committed CREATE TABLE exists anywhere in this repo for this table
-- (confirmed via grep) — it was created directly in a Supabase dashboard on
-- TAC's project. Columns below are reverse-engineered from every
-- `.from('sites')` call and the `CachedSite`/`Site` TypeScript interfaces in
-- src/lib/sitesCache.ts and src/pages/SitesDB.tsx (bulk-import field map
-- confirms this exact column set).
create table if not exists public.sites (
  id                 uuid        primary key default gen_random_uuid(),
  operator           text        not null,
  site_code          text        not null,
  site_name          text,
  governorate        text,
  city               text,
  latitude           double precision,
  longitude          double precision,
  site_type          text,
  cabina_type        text,
  installation_type  text,
  tower_height       numeric,
  topology           text,
  antenna            text,
  vendor             text,
  status             text,
  created_at         timestamptz default now()
);

-- ── app_settings (React-only, new — seeded with the one config row the app
--    needs to function, per react_migration_phase17_sql.sql) ───────────────
create table if not exists public.app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

-- STAGING CONFIGURATION SEED DATA — not a production data migration. This is
-- the one app-config row the app needs to function at all (approved, item 5
-- of the corrections list), distinct from any live/business data, none of
-- which is inserted anywhere in this package.
insert into public.app_settings (key, value) values
  ('car_km_rate_iqd', '275')
on conflict (key) do nothing;

-- ── projects (React-only, new — seeded with the project list, per
--    react_migration_phase16_sql.sql. This is app configuration, not
--    production business data — flagging the distinction since your
--    instructions said not to migrate production data yet; this seed list
--    is required for the app to function at all, same as app_settings
--    above. Remove this insert before running if you'd rather seed it
--    manually.) ────────────────────────────────────────────────────────────
create table if not exists public.projects (
  id           uuid        primary key default gen_random_uuid(),
  key          text        not null unique,
  display_name text        not null,
  has_sections boolean     not null default true,
  sort_order   int         not null default 0,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

-- STAGING CONFIGURATION SEED DATA — not a production data migration. This is
-- the fixed list of projects the app's UI is built around (approved, item 5
-- of the corrections list), not live/business records.
insert into public.projects (key, display_name, has_sections, sort_order) values
  ('zain',   'Zain Project',   true,  1),
  ('nokia',  'Nokia Project',  true,  2),
  ('huawei', 'Huawei Project', true,  3),
  ('ipt',    'IPT Project',    true,  4),
  ('moj',    'MOJ Project',    true,  5),
  ('general','General',        false, 6)
on conflict (key) do nothing;

-- ── saved_points (React-only, new, empty) ───────────────────────────────
-- Fully defined already in react_migration_phase17_sql.sql — reused as-is.
create table if not exists public.saved_points (
  id           uuid             primary key default gen_random_uuid(),
  name         text             not null,
  latitude     double precision not null,
  longitude    double precision not null,
  is_active    boolean          not null default true,
  created_at   timestamptz      not null default now()
);

-- ── project_expenses (old-JSR table, added by the Phase 4 schema patch —
--    was MISSING from every earlier pass of this package) ──────────────────
-- Live-confirmed via docs/schema-audit-results/11b_flagged_tables_schema_
-- complete.csv (17 columns, full types/nullability) and
-- a_approx_row_counts.csv (169 rows — real production data, not dead).
-- Actively read/written today by src/pages/FinProjExp.tsx
-- (`.from('project_expenses').select('*')/.insert()/.update()/.delete()`),
-- and referenced by FinDashboard.tsx, FinReport.tsx, FinExpClaims.tsx, and
-- BackupRestore.tsx. No FK to or from any other table
-- (docs/schema-audit-results/foreign_keys.csv has no row for it either
-- direction) — flat table, same shape family as general_expenses above.
-- This was never listed in STAGING_EXECUTION_CHECKLIST.md's "intentionally
-- excluded" section either (that section only names expenses,
-- expense_budgets, work_log as confirmed-dead) — it fell through every
-- earlier audit pass until Phase 4 planning cross-checked
-- a_approx_row_counts.csv against this package's table list.
create table if not exists public.project_expenses (
  id             uuid        primary key default gen_random_uuid(),
  project_name   text        not null,
  description    text        not null,
  category       text,
  amount         numeric     not null,
  expense_date   date,
  month          integer,
  year           integer,
  notes          text,
  added_by       text,
  created_at     timestamptz default now(),
  activity_date  date,
  site_id        text,
  employee_ids   jsonb       default '[]'::jsonb,
  accommodation  text        default 'Returned Home',
  submitted_by   text,
  approved_by    text
);
