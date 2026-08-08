-- ============================================================================
-- Phase 3 — 09: Patch public.revenue — add missing columns
-- ============================================================================
-- TARGET: the NEW JSR staging project ("JSR Network Tracker React") ONLY —
-- the same project 07 and 08 were already run against. Do NOT run against
-- tltbkjvrhqsxdspdfeqk (old live JSR) or gauejhgitzcqjvzalshf (TAC's live
-- project). Verify the project ref in the dashboard URL before running
-- anything here.
--
-- WHY THIS FILE EXISTS: the Finance > Revenue page was showing "No revenue
-- records" plus a raw "[object Object]" error banner. Root cause:
-- `public.revenue` was created here from an unconfirmed Phase 2B guess at
-- its columns (id, project_name, site_id, amount, month, year, created_at)
-- — flagged at the time as "not fully live-column-confirmed" (see
-- STAGING_EXECUTION_CHECKLIST.md). The frontend (FinRevenue.tsx,
-- FinInvoices.tsx, FinReport.tsx, FinDashboard.tsx) actually reads/writes
-- five more columns that were never added: section_name, invoice_date,
-- status, notes, added_by. FinRevenue.tsx's initial load query
-- (`.order('invoice_date', ...)`) failed outright with a
-- "column revenue.invoice_date does not exist" error, which a separate bug
-- in the same file's error handling then displayed as the unhelpful literal
-- "[object Object]" (also fixed, see FinRevenue.tsx commit).
--
-- SAFETY GUARANTEES:
--   - Every ALTER uses ADD COLUMN IF NOT EXISTS — a no-op if a column
--     already exists (e.g. if a later fresh install already has it via the
--     updated 01_extensions_and_core_tables.sql). Safe to run more than
--     once.
--   - No existing row is deleted, and no existing column's data is
--     modified. New columns are simply added as nullable (`status` gets a
--     default for new rows going forward; existing rows get NULL for it,
--     same as every other new column here — the frontend already treats a
--     null/missing status as falling back to
--     'Implemented - Pending ATP' at read time).
--   - No table other than public.revenue is touched.
--   - No RLS change (still 06's job, still deliberately not run).
--   - Nothing here is executed by me — file only, per standing
--     instructions. Run this yourself in the new staging project's SQL
--     Editor after confirming the project ref.
-- ============================================================================

alter table public.revenue add column if not exists section_name text;
alter table public.revenue add column if not exists invoice_date date;
alter table public.revenue add column if not exists status       text default 'Implemented - Pending ATP';
alter table public.revenue add column if not exists notes        text;
alter table public.revenue add column if not exists added_by     text;

-- ============================================================================
-- Deliberately NOT included in this file:
--   - Any NOT NULL constraint — the frontend already handles null/missing
--     values for every one of these columns (falls back to defaults at
--     read/edit time), so no backfill-then-constrain step is needed.
--   - Any DELETE/UPDATE against existing revenue rows.
--   - Any RLS change (06_enable_rls_no_policies.sql's job, still un-run).
--   - Any change to the old live JSR project or TAC's live project.
-- ============================================================================
