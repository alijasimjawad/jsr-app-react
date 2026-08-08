-- ============================================================================
-- Phase 3 — 10: Patch public.expense_claims — add car-trip columns
-- ============================================================================
-- TARGET: the NEW JSR staging project ("JSR Network Tracker React") ONLY —
-- the same project 07, 08, and 09 were already run against. Do NOT run
-- against tltbkjvrhqsxdspdfeqk (old live JSR). Verify the project ref in
-- the Supabase Dashboard URL before running anything here.
--
-- WHY THIS FILE EXISTS: five car-trip columns are referenced throughout the
-- React app (DailyActivities.tsx, FinExpClaims.tsx) but were never in the
-- original live JSR `expense_claims` table (confirmed in Phase 3 schema
-- audit) and therefore were not added to the staging schema in files 01-09.
-- Without them, every car-trip claim INSERT/UPDATE/SELECT in DailyActivities
-- fails with a PostgREST 400 ("column does not exist"), and the car-trip
-- fields in FinExpClaims always display as null.
--
-- Columns added:
--   is_car_trip          — flags a claim as auto-generated from a car trip
--   daily_activity_id    — links back to the daily_activities row that
--                          triggered the claim (used by DailyActivities to
--                          find and update the matching claim on re-save)
--   car_id               — FK to public.cars(id); identifies which company
--                          car was used
--   car_trip_distance_km — distance driven, used to calculate the claim total
--   car_trip_rate_iqd    — per-km rate in IQD at time of submission
--
-- SAFETY GUARANTEES:
--   - Every ALTER uses ADD COLUMN IF NOT EXISTS — a no-op if a column
--     already exists (e.g. if this patch has already been run). Safe to
--     run more than once.
--   - No existing row is deleted, updated, or inserted. All new columns are
--     added as nullable (is_car_trip gets a DEFAULT false so new rows are
--     self-documenting; existing rows get NULL for it, which the frontend
--     already treats as false via the `?? false` fallback pattern).
--   - FKs use ON DELETE SET NULL so deleting a daily_activities row or a
--     cars row does not cascade-delete any expense_claims rows — same
--     defensive pattern used throughout the rest of the schema.
--   - No table other than public.expense_claims is touched.
--   - No RLS change (still 06's job, still deliberately not run).
--   - Nothing here is executed automatically — file only, per standing
--     instructions. Run this yourself in the new staging project's SQL
--     Editor after confirming the project ref.
-- ============================================================================

ALTER TABLE public.expense_claims
  ADD COLUMN IF NOT EXISTS is_car_trip          boolean  DEFAULT false,
  ADD COLUMN IF NOT EXISTS daily_activity_id    uuid     REFERENCES public.daily_activities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS car_id               uuid     REFERENCES public.cars(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS car_trip_distance_km numeric,
  ADD COLUMN IF NOT EXISTS car_trip_rate_iqd    numeric;

-- ============================================================================
-- Deliberately NOT included in this file:
--   - NOT NULL constraints — existing rows would need a backfill before any
--     NOT NULL could be applied, and the frontend already handles null values
--     for all five columns (is_car_trip ?? false, others rendered as '—').
--   - Any index — no query in the codebase filters expense_claims by car_id
--     or car_trip_distance_km alone; daily_activity_id IS filtered by
--     DailyActivities but the table is small enough that a seq-scan is fine.
--   - Any DEFAULT for the four numeric/uuid columns — null is the correct
--     sentinel for "this claim is not a car trip", matching the frontend.
--   - Any RLS change (06_enable_rls_no_policies.sql's job, still un-run).
--   - Any change to the old live JSR project.
-- ============================================================================
