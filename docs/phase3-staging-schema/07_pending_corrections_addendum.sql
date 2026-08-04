-- ============================================================================
-- Phase 3 Step 2 — 07: APPLIED changelog (folded into 01/02/05/06 —
-- do not run this file, it is historical record only)
-- ============================================================================
-- Status: every correction below has been approved and folded directly into
-- the files it describes. This file is kept only as an audit trail of what
-- changed and why — running it now would be redundant (everything it does
-- is already in 01/02/05/06) and the DDL below no longer matches those
-- files' current state in a few places (e.g. `sections`/`rows` are now
-- created with the corrected shape directly in 01/02, so the `alter table`
-- statements below assume a table that already exists with the OLD, wrong
-- shape — that's no longer true for a fresh run of 01-05).
--
-- Where each correction landed:
--   - sections (section A below)        → 01_extensions_and_core_tables.sql
--   - rows + trigger (section B below)  → 02_dependent_tables.sql
--   - rows_section_order_idx fix        → 05_additional_indexes.sql
--   - project_expenses (section C)      → 01_extensions_and_core_tables.sql,
--                                          06_enable_rls_no_policies.sql,
--                                          staging_rollback_reset.sql,
--                                          verify_staging_schema.sql
--   - users.password nullable (added    → 01_extensions_and_core_tables.sql
--     after this file was first written,
--     per the Phase 4 correction round)
--
-- Source of every correction: /Users/alijasim/Desktop/JSR/supabase_setup.sql
-- — the OLD, live JSR app's own original schema-creation script. Found
-- after files 01-06 were already drafted/corrected once. Resolved the
-- "not fully live-confirmed" flag on `sections` and `rows` that had
-- followed this package since Phase 2B, and surfaced `project_expenses`, a
-- live production table that had fallen through every earlier audit pass.
-- ============================================================================

-- ── A. sections — bring to parity with original supabase_setup.sql ─────────
-- Every one of these three columns is NOT NULL in the original; the Phase 3
-- Step 2 version left them nullable because they were Phase 2B inference,
-- not yet cross-checked against this file. No data exists yet in staging
-- (0 rows per the verification script), so these ALTERs are safe as written.
alter table public.sections
  alter column section_label set not null,
  alter column columns       set not null,
  alter column columns       set default '[]'::jsonb,
  alter column is_custom     set not null,
  alter column is_deleted    set not null;

-- ── B. rows — bring to parity with original supabase_setup.sql ─────────────
-- 1. section_id needs ON DELETE CASCADE (currently no ON DELETE clause, which
--    defaults to NO ACTION — deleting a section would be blocked by any
--    remaining rows instead of cleaning them up, which is not how old JSR
--    behaves today).
alter table public.rows drop constraint if exists rows_section_id_fkey;
alter table public.rows
  add constraint rows_section_id_fkey
  foreign key (section_id) references public.sections(id) on delete cascade;

-- 2. data / row_order should be NOT NULL with the same defaults as the
--    original (currently nullable with no default for row_order).
alter table public.rows
  alter column data      set not null,
  alter column data      set default '{}'::jsonb,
  alter column row_order set not null,
  alter column row_order set default 0;

-- 3. rows_section_order_idx was built in 05_additional_indexes.sql as a
--    single-column index on row_order alone. The original indexes it as a
--    composite (section_id, row_order) — the shape that actually serves the
--    app's real query pattern (fetch a section's rows in order), the
--    single-column version doesn't. Drop and recreate with the right shape.
drop index if exists public.rows_section_order_idx;
create index if not exists rows_section_order_idx on public.rows (section_id, row_order);

-- 4. auto-maintained updated_at — entirely absent from Phase 3 Step 2 today.
--    Original defines a shared trigger function and attaches it to `rows`.
create or replace function public.update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists rows_updated_at on public.rows;
create trigger rows_updated_at
  before update on public.rows
  for each row execute procedure public.update_updated_at();

-- ── C. project_expenses — MISSING ENTIRELY from Phase 3 Step 2 ─────────────
-- This is not a column-level nitpick like A/B above — this is a live
-- production table with real business data that was never added to this
-- package at all, and never listed in STAGING_EXECUTION_CHECKLIST.md's
-- "intentionally excluded" section either (that section only names
-- `expenses`, `expense_budgets`, `work_log` as confirmed-dead exclusions).
--
-- Confirmed live via docs/schema-audit-results/11b_flagged_tables_schema_
-- complete.csv (17 columns, full types/nullability) and
-- docs/schema-audit-results/a_approx_row_counts.csv (169 rows — not empty,
-- not dead). Actively read/written today by src/pages/FinProjExp.tsx
-- (`.from('project_expenses').select('*')/.insert()/.update()/.delete()`),
-- and also referenced by FinDashboard.tsx, FinReport.tsx, FinExpClaims.tsx,
-- and BackupRestore.tsx. No FK to or from any other table
-- (docs/schema-audit-results/foreign_keys.csv has no row for it either
-- direction) — it's a flat table, same shape family as `general_expenses`.
--
-- If this table is not added before Phase 4's data migration runs, there is
-- no destination for its 169 production rows.
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

-- Not adding an index here beyond the implicit PK index — the live audit
-- records no additional index for this table, and it isn't queried by any
-- FK column, matching general_expenses' treatment in file 05.

-- ============================================================================
-- All of the following bookkeeping has now been applied:
--   - STAGING_EXECUTION_CHECKLIST.md: table count updated 24 → 25;
--     project_expenses added to the "live-column-confirmed" list in
--     section 1; sections/rows moved out of "not fully confirmed".
--   - verify_staging_schema.sql: project_expenses added to sections 1 and 2;
--     new sections 9 (rows_updated_at trigger) and 10 (users.password
--     nullable) added.
--   - 06_enable_rls_no_policies.sql: project_expenses added to the RLS-enable
--     list, header updated to 25 tables.
--   - staging_rollback_reset.sql: project_expenses drop added, plus an
--     explicit drop of the update_updated_at() function.
--   - Sections/rows fixes folded into 01/02/05 directly — a fresh 01-05 run
--     now produces the corrected shape without needing this file at all.
-- ============================================================================
