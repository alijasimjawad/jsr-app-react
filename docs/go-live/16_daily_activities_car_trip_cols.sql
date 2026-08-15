-- docs/go-live/16_daily_activities_car_trip_cols.sql
--
-- Purpose: Add 18 missing columns to public.daily_activities.
--
-- WHY: DailyActivities.tsx save() always spreads a full FormVals object
--      (including 14 car/trip fields) into the INSERT/UPDATE payload.
--      The UPDATE path additionally sends is_edited, edit_reason, updated_at,
--      updated_by. None of these 18 columns existed in the destination DB,
--      causing every save to fail with PGRST204 ("Could not find the car_id
--      column of daily_activities").
--
-- Design decisions:
--   car_id   uuid FK → cars(id) ON DELETE SET NULL
--     Nullable — no car trip when carTripEnabled=false. ON DELETE SET NULL
--     preserves the activity record if a car is later removed from the fleet.
--
--   driver_id   uuid FK → users(id) ON DELETE SET NULL
--     Nullable — same rationale. References users.id (custom users table),
--     consistent with how member_id is used across expense_claims/field_trips.
--
--   Coordinate and distance columns: double precision (float8).
--     trip_rate_iqd, trip_cost_iqd: numeric (exact arithmetic for IQD amounts).
--
--   trip_stops, trip_legs: jsonb (complex nested structs — TripStopSaved[],
--     TripLegSaved[]). Nullable because car trip may not be used.
--
--   is_edited, round_trip: boolean nullable (null = not yet set / pre-feature).
--   updated_at: timestamptz nullable.
--   updated_by, edit_reason, trip_distance_source,
--   start_point_name: text nullable.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Idempotent — safe to re-run (IF NOT EXISTS guards on all statements).

-- ── Car trip identity fields ──────────────────────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS car_id uuid
    REFERENCES public.cars(id) ON DELETE SET NULL;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS driver_id uuid
    REFERENCES public.users(id) ON DELETE SET NULL;

-- ── Start point ───────────────────────────────────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS start_point_name text;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS start_lat double precision;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS start_lng double precision;

-- ── Target / final destination coordinates ───────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS target_lat double precision;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS target_lng double precision;

-- ── Route detail (jsonb arrays) ───────────────────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_stops jsonb;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_legs jsonb;

-- ── Trip metrics ──────────────────────────────────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_distance_km double precision;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_rate_iqd numeric;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_cost_iqd numeric;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS trip_distance_source text;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS round_trip boolean;

-- ── Edit audit trail ──────────────────────────────────────────────────────────
ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS is_edited boolean;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS edit_reason text;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

ALTER TABLE public.daily_activities
  ADD COLUMN IF NOT EXISTS updated_by text;

-- ── Post-apply verification ───────────────────────────────────────────────────
-- Run after applying the ALTER statements above.
-- Expected: 18 rows (one per new column).

-- V1. Column existence and types
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'daily_activities'
  AND column_name  IN (
    'car_id', 'driver_id',
    'start_point_name', 'start_lat', 'start_lng',
    'target_lat', 'target_lng',
    'trip_stops', 'trip_legs',
    'trip_distance_km', 'trip_rate_iqd', 'trip_cost_iqd',
    'trip_distance_source', 'round_trip',
    'is_edited', 'edit_reason', 'updated_at', 'updated_by'
  )
ORDER BY column_name;
-- Expected 18 rows. Key types:
--   car_id          | uuid
--   driver_id       | uuid
--   is_edited       | boolean
--   round_trip      | boolean
--   start_lat/lng   | double precision
--   target_lat/lng  | double precision
--   trip_cost_iqd   | numeric
--   trip_distance_km| double precision
--   trip_distance_source | text
--   trip_legs       | jsonb
--   trip_rate_iqd   | numeric
--   trip_stops      | jsonb
--   updated_at      | timestamp with time zone
--   All others      | text

-- V2. FK constraints (expect 2 rows: car_id → cars, driver_id → users)
SELECT
  kcu.column_name,
  ccu.table_name  AS referenced_table,
  ccu.column_name AS referenced_column,
  rc.delete_rule
FROM information_schema.table_constraints      tc
JOIN information_schema.key_column_usage        kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
JOIN information_schema.referential_constraints rc  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name      = 'daily_activities'
  AND kcu.column_name    IN ('car_id', 'driver_id');
-- Expected:
--   car_id    | cars  | id | SET NULL
--   driver_id | users | id | SET NULL

-- V3. Existing row count (should be 0 on fresh staging; just confirms table is accessible)
SELECT COUNT(*) AS existing_rows FROM public.daily_activities;
