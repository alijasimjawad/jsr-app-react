-- ============================================================================
-- Phase 3 Step 2 — Staging-only rollback / reset
-- ============================================================================
-- STAGING ONLY. This drops every table created by 01-05 of this folder, in
-- reverse dependency order, so the staging project can be reset to a clean
-- empty state and rebuilt from scratch.
--
-- Before running this, verify in the dashboard URL / Settings → General
-- that you are in the NEW staging project ("JSR Network Tracker React"),
-- NOT tltbkjvrhqsxdspdfeqk (live JSR) and NOT gauejhgitzcqjvzalshf (TAC).
-- This file is dangerous by design (it's a reset tool) — the project-ref
-- check matters more here than anywhere else in this folder.
--
-- This does NOT touch auth.users (Supabase Auth). If you also want to wipe
-- any test Auth accounts created during staging testing, that's the
-- separate, explicitly-commented block at the very bottom — off by default.
-- ============================================================================

-- ── Tier 2 (depend on tier 1) ────────────────────────────────────────────
drop table if exists public.trip_participants cascade;
drop table if exists public.invoice_items cascade;
drop table if exists public.invoice_payments cascade;

-- ── Tier 1 (depend on tier 0) ────────────────────────────────────────────
drop table if exists public.field_trips cascade;
drop table if exists public.attendance cascade;
drop table if exists public.cars cascade;
drop table if exists public.rows cascade;
drop table if exists public.invoices cascade;
drop table if exists public.push_subscriptions cascade;
drop table if exists public.salary_adjustments cascade;
drop table if exists public.expense_claims cascade;
drop table if exists public.employee_documents cascade;

-- ── Tier 0 (no dependents left after the above) ─────────────────────────
drop table if exists public.saved_points cascade;
drop table if exists public.projects cascade;
drop table if exists public.app_settings cascade;
drop table if exists public.sites cascade;
drop table if exists public.revenue cascade;
drop table if exists public.project_expenses cascade;
drop table if exists public.sections cascade;
drop table if exists public.daily_activities cascade;
drop table if exists public.general_expenses cascade;
drop table if exists public.activity_log cascade;
drop table if exists public.clients cascade;
drop table if exists public.team_members cascade;
drop table if exists public.users cascade;

-- Also drops the shared trigger function added by the Phase 4 schema patch
-- (rows_updated_at's backing function) — cascade on the `rows` table drop
-- above removes the trigger itself, but the function object persists until
-- dropped explicitly.
drop function if exists public.update_updated_at();

-- Not dropping the pgcrypto / uuid-ossp extensions — harmless to leave
-- enabled, and other Supabase-managed schemas may depend on pgcrypto.

-- ============================================================================
-- OPTIONAL — wipe test Auth accounts too. Commented out on purpose. Only
-- uncomment and run this if you specifically want to clear Supabase Auth
-- users created during staging testing (e.g. after testing Phase 4's
-- Auth migration script against staging). Never run this anywhere except
-- the staging project.
-- ============================================================================
-- delete from auth.users;
