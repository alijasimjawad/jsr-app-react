-- ============================================================================
-- Phase 3 Step 2 — 05: Additional indexes (item 7 — preserve confirmed
-- indexes, beyond what PRIMARY KEY / UNIQUE constraints already create
-- automatically in files 01-03)
-- ============================================================================
-- Run AFTER 01-04. Every PK and UNIQUE constraint above already has an
-- implicit index from Postgres — this file only adds the extra named,
-- non-PK/non-unique indexes.
-- ============================================================================

-- ── Confirmed live (docs/schema-audit-results/indexes.csv) ──────────────
-- These 3 are the only non-PK/non-unique indexes recorded for old JSR's
-- live database (out of 28 total index rows in the export — the rest are
-- the automatic PK/unique indexes already created above).
--
-- rows_section_order_idx corrected by the Phase 4 schema patch: previously
-- built as a single-column index on row_order alone; the original
-- supabase_setup.sql indexes it as a composite (section_id, row_order),
-- which is the shape that actually serves the app's real query pattern
-- (fetch a section's rows in order) — a single-column index on row_order
-- doesn't help that query at all.
create index if not exists rows_section_id_idx    on public.rows (section_id);
create index if not exists rows_section_order_idx on public.rows (section_id, row_order);
create index if not exists sections_project_idx   on public.sections (project_name);

-- ── Added for staging usability — NOT from the live production audit ────
-- These 4 tables don't exist live, so there's nothing to "preserve" from
-- production. Added because every one of these FK columns is queried
-- directly in the app code (`.eq('member_id', ...)`, `.eq('trip_id', ...)`,
-- etc.) and would otherwise force a full table scan. Flagging clearly as
-- an addition, not a confirmed carryover, per your item 7 wording.
create index if not exists field_trips_daily_activity_id_idx on public.field_trips (daily_activity_id);
create index if not exists trip_participants_trip_id_idx     on public.trip_participants (trip_id);
create index if not exists trip_participants_member_id_idx   on public.trip_participants (member_id);
create index if not exists cars_owner_id_idx                  on public.cars (owner_id);
create index if not exists sites_site_code_idx                 on public.sites (site_code);

-- attendance and salary_adjustments already get an index for free from
-- their UNIQUE constraints on (member_id, date) / (member_id, month, year)
-- defined in files 02-03 — no separate index needed here.
