-- ============================================================================
-- Phase 3 — 08: Patch public.projects — retire MOJ/General, add TAC/MRC
-- ============================================================================
-- TARGET: the NEW JSR staging project ("JSR Network Tracker React") ONLY —
-- the same project 07_patch_existing_staging_schema.sql was already run
-- against. Do NOT run against tltbkjvrhqsxdspdfeqk (old live JSR) or
-- gauejhgitzcqjvzalshf (TAC's live project). Verify the project ref in the
-- dashboard URL before running anything here.
--
-- WHY THIS FILE EXISTS: the user asked to remove the MOJ and General
-- projects from Network Scopes and replace them with a TAC project and an
-- MRC project, in the same two UI slots. `public.projects` is the single
-- source of truth for the app's project list (src/lib/projectsCache.ts
-- reads it directly, filtered to is_active = true) — no frontend code
-- change is needed, this table is the only thing that needs to change.
--
-- DECISIONS CONFIRMED WITH THE USER BEFORE WRITING THIS FILE:
--   - Target: the NEW JSR staging project only.
--   - Delete method: SOFT DEACTIVATE (is_active = false) for moj/general,
--     not a hard delete — this preserves the rows themselves and any
--     scopes/sections/rows data already associated with those project keys,
--     while immediately hiding them from the UI (ensureProjectsLoaded()
--     only loads rows where is_active = true).
--   - New projects: key='tac' / display_name='TAC Project' and
--     key='mrc' / display_name='MRC Project', both has_sections = true,
--     at sort_order 5 and 6 — the same slots moj/general occupied.
--
-- SAFETY GUARANTEES:
--   - No row is hard-deleted. moj/general rows and any data that
--     references them (scopes, sections, rows keyed by project) are left
--     fully intact — only is_active flips to false.
--   - No table other than public.projects is touched.
--   - No RLS change (still 06's job, still deliberately not run).
--   - Every statement is safe to run more than once: the UPDATE is a no-op
--     once is_active is already false, and the INSERT uses
--     ON CONFLICT (key) DO NOTHING so re-running never duplicates tac/mrc
--     or overwrites a since-edited row.
--   - Nothing here is executed by me — file only, per standing
--     instructions. Run this yourself in the new staging project's SQL
--     Editor after confirming the project ref.
-- ============================================================================

-- ── 1. Soft-deactivate moj and general ──────────────────────────────────────
-- Hides both from the UI immediately without deleting the rows or any
-- associated business data. Idempotent: no-op if already false.
update public.projects
set is_active = false
where key in ('moj', 'general');

-- ── 2. Add tac and mrc, same slots (sort_order 5, 6) ────────────────────────
-- ON CONFLICT (key) DO NOTHING makes this safe to re-run — if tac/mrc
-- already exist (e.g. from a fresh install using the updated seed in
-- 01_extensions_and_core_tables.sql), this is a no-op and won't clobber
-- any manual edits made since.
insert into public.projects (key, display_name, has_sections, sort_order, is_active) values
  ('tac', 'TAC Project', true, 5, true),
  ('mrc', 'MRC Project', true, 6, true)
on conflict (key) do nothing;

-- ============================================================================
-- Deliberately NOT included in this file:
--   - Any DELETE against public.projects or any other table — moj/general
--     are deactivated, never removed.
--   - Any change to scopes/sections/rows data that references the moj or
--     general project keys — that data is left exactly as-is.
--   - Any RLS change (06_enable_rls_no_policies.sql's job, still un-run).
--   - Any change to the old live JSR project or TAC's live project.
-- ============================================================================
