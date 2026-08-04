-- ============================================================================
-- Phase 3 Step 2 — 03: React-only tables, created empty (cars, field_trips,
-- trip_participants, attendance)
-- ============================================================================
-- Run AFTER 01 and 02 (depends on team_members and daily_activities).
-- None of these 4 tables exist in old JSR's live database. None have any
-- committed CREATE TABLE SQL anywhere in this repo (confirmed via grep) —
-- `cars` was defined in react_migration_phase17_sql.sql (reused as-is
-- below); `field_trips`, `trip_participants`, and `attendance` were
-- reverse-engineered from every `.from(...)` call and TypeScript interface
-- in src/lib/tripTypes.ts, src/pages/AttendanceAdmin.tsx, and every
-- consuming page — see STAGING_EXECUTION_CHECKLIST.md for the confidence
-- notes and the specific inconsistencies flagged during that pass (e.g.
-- `field_trips.site_id` is a TEXT site_code, not a uuid FK to sites.id —
-- do not "fix" that during review, the app relies on it being text and
-- sometimes comma-joined).
-- ============================================================================

-- ── cars (→ team_members) ────────────────────────────────────────────────
-- Fully defined already in react_migration_phase17_sql.sql — reused as-is.
create table if not exists public.cars (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  plate_number text,
  owner_id     uuid        references public.team_members(id) on delete set null,
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now()
);

-- ── field_trips (→ daily_activities) ─────────────────────────────────────
-- Reverse-engineered from src/lib/tripTypes.ts and every consuming page
-- (HrProfiles.tsx, FinPerformance.tsx, MyTrips.tsx, TripDetailModal.tsx,
-- LiveTrips.tsx, MyWork.tsx, DailyActivities.tsx). `site_id` is
-- intentionally TEXT (see note above), NOT a FK to sites.id — it stores a
-- site_code string, sometimes a comma-joined list of several site codes.
create table if not exists public.field_trips (
  id                  uuid        primary key default gen_random_uuid(),
  daily_activity_id   uuid        references public.daily_activities(id),
  date                date        not null,
  project             text,
  site_id             text,
  governate           text,
  notes               text,
  team_member_ids     text[]      default '{}'::text[],
  team_member_names   text[]      default '{}'::text[],
  status              text        not null default 'pending',
  created_by          uuid        references public.team_members(id),
  started_at          timestamptz,
  started_by          uuid        references public.team_members(id),
  started_by_name     text,
  departed_at         timestamptz,
  completed_at        timestamptz
);

-- ── trip_participants (→ field_trips, → team_members) ────────────────────
-- Reverse-engineered from the same pass as field_trips above. LiveTrips.tsx
-- does `.from('field_trips').select('*,trip_participants(*)')` — a
-- PostgREST embedded-resource query, which only works if a real FK exists
-- from trip_participants.trip_id → field_trips.id. That FK is required, not
-- optional, for the app's existing embed query to keep working.
create table if not exists public.trip_participants (
  id                uuid        primary key default gen_random_uuid(),
  trip_id           uuid        not null references public.field_trips(id) on delete cascade,
  member_id         uuid        not null references public.team_members(id),
  member_name       text,
  status            text        not null default 'pending',
  joined_at         timestamptz,
  delay_minutes     integer,
  last_lat          double precision,
  last_lng          double precision,
  last_location_at  timestamptz
);

-- ── attendance (→ team_members) ──────────────────────────────────────────
-- Reverse-engineered from src/pages/AttendanceAdmin.tsx (most complete
-- shape) and src/pages/MyAttendance.tsx. The `.upsert(payload, { onConflict:
-- 'member_id,date' })` call in the app confirms a required unique
-- constraint on (member_id, date) — included below, not optional.
create table if not exists public.attendance (
  id               uuid        primary key default gen_random_uuid(),
  member_id        uuid        not null references public.team_members(id),
  date             date        not null,
  clock_in         timestamptz,
  clock_out        timestamptz,
  hours_worked     numeric(5,2),
  status           text,
  notes            text,
  clock_in_lat     double precision,
  clock_in_lng     double precision,
  clock_out_lat    double precision,
  clock_out_lng    double precision,
  updated_by       text,
  updated_at       timestamptz,
  constraint attendance_member_date_unique unique (member_id, date)
);
