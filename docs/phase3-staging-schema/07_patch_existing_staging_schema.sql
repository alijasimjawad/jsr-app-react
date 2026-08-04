-- ============================================================================
-- Phase 3 Step 2 — 07: Patch for the ALREADY-EXECUTED staging project
-- ============================================================================
-- TARGET: the EXISTING staging project ("JSR Network Tracker React") ONLY —
-- the same project files 01-05 (their earlier, pre-Phase-4-correction
-- versions) were already successfully run against. Do NOT run against
-- tltbkjvrhqsxdspdfeqk (live JSR) or gauejhgitzcqjvzalshf (TAC). Verify the
-- project ref in the dashboard URL before running anything here.
--
-- WHY THIS FILE EXISTS: 01, 02, 05, and 06 were edited in place after this
-- project was already built from their earlier versions, so this project's
-- live schema is missing the six Phase 4 corrections (project_expenses,
-- sections NOT NULLs, rows NOT NULLs/cascade/trigger, the composite index,
-- users.password nullable). Re-running 01-05 from scratch is unnecessary —
-- this file brings the EXISTING schema up to that same corrected state with
-- targeted, idempotent statements only. It does not recreate anything that
-- already matches, and does not touch any other table.
--
-- SAFETY GUARANTEES:
--   - No RLS is touched (that's 06's job, still deliberately not run).
--   - No row is inserted, updated, or deleted in any production-shaped
--     table — the only UPDATEs below are narrow, null-only backfills of
--     structural columns (`columns`, `is_custom`, `is_deleted`,
--     `section_label`, `data`, `row_order`) on `sections`/`rows`, which
--     verify_staging_schema.sql's own section 2 expects to hold 0 rows at
--     this stage anyway (no production data has been migrated yet). If
--     those tables really are empty, every UPDATE below is a no-op.
--   - Every statement is written to be safe to run more than once: table/
--     index/function/trigger creation all use IF NOT EXISTS / OR REPLACE /
--     IF EXISTS guards, ALTER ... SET NOT NULL and ALTER ... SET DEFAULT
--     don't error when already applied, and the FK swap looks up whatever
--     constraint currently exists (by shape, not by assumed name) before
--     dropping and recreating it.
--   - Nothing here is executed by me — file only, per standing instructions.
-- ============================================================================

-- ── 1. project_expenses — create only if missing ───────────────────────────
-- Identical definition to the one added to 01_extensions_and_core_tables.sql.
-- `create table if not exists` is already a no-op if this project happens to
-- have it from a later partial run.
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

-- ── 2. users.password — make nullable ───────────────────────────────────────
-- DROP NOT NULL is a no-op (no error) if the column is already nullable.
alter table public.users alter column password drop not null;

-- ── 3. sections — apply the confirmed NOT NULL constraints safely ──────────
alter table public.sections alter column columns set default '[]'::jsonb;

-- Null-only backfill, structural columns only, matching the original
-- supabase_setup.sql's defaults. No-op if the table is empty or already
-- populated with non-null values in these columns.
update public.sections set columns    = '[]'::jsonb where columns    is null;
update public.sections set is_custom  = false        where is_custom  is null;
update public.sections set is_deleted = false        where is_deleted is null;

-- section_label has no independent default in the original schema. If any
-- existing row somehow has it null, fall back to that same row's
-- section_name (an existing, already-real value) rather than inventing new
-- data — this only matters if sections has non-empty rows, which
-- verify_staging_schema.sql expects it not to at this stage.
update public.sections set section_label = section_name where section_label is null;

-- SET NOT NULL is a no-op (no error) on a column that's already NOT NULL,
-- so this block is safe whether or not a previous run of this patch already
-- applied it.
alter table public.sections
  alter column section_label set not null,
  alter column columns       set not null,
  alter column is_custom     set not null,
  alter column is_deleted    set not null;

-- ── 4. rows — apply the confirmed defaults/NOT NULL constraints safely ─────
alter table public.rows alter column data      set default '{}'::jsonb;
alter table public.rows alter column row_order set default 0;

update public.rows set data      = '{}'::jsonb where data      is null;
update public.rows set row_order = 0            where row_order is null;

alter table public.rows
  alter column data      set not null,
  alter column row_order set not null;

-- ── 5. rows.section_id FK — replace with ON DELETE CASCADE, data untouched ──
-- Looks up whatever FK currently sits on rows.section_id → sections(id) by
-- shape (not by assumed constraint name), drops it, and recreates it with
-- ON DELETE CASCADE. Constraint metadata only — no row in `rows` or
-- `sections` is read, written, or removed by this block. Safe to rerun: if
-- the cascade version is already in place, this finds it, drops it, and
-- puts back the identical definition.
do $$
declare
  fk_name text;
begin
  select tc.constraint_name into fk_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema     = kcu.table_schema
  join information_schema.constraint_column_usage ccu
    on tc.constraint_name = ccu.constraint_name
   and tc.table_schema     = ccu.table_schema
  where tc.constraint_type = 'FOREIGN KEY'
    and tc.table_schema    = 'public'
    and tc.table_name      = 'rows'
    and kcu.column_name    = 'section_id'
    and ccu.table_name     = 'sections'
  limit 1;

  if fk_name is not null then
    execute format('alter table public.rows drop constraint %I', fk_name);
  end if;
end $$;

alter table public.rows
  add constraint rows_section_id_fkey
  foreign key (section_id) references public.sections(id) on delete cascade;

-- ── 6. rows_updated_at — create or replace the trigger + backing function ──
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

-- ── 7. rows_section_order_idx — replace with the confirmed composite shape ─
drop index if exists public.rows_section_order_idx;
create index if not exists rows_section_order_idx on public.rows (section_id, row_order);

-- ============================================================================
-- Deliberately NOT included in this file:
--   - Any `alter table ... enable row level security` statement (that's
--     06_enable_rls_no_policies.sql's job, and it stays un-run until Auth +
--     policy work is ready — same standing warning as that file).
--   - Any insert/update/delete against production-shaped business data —
--     the only UPDATEs above are null-only structural backfills on tables
--     expected to hold 0 rows right now.
--   - Any change to a table other than project_expenses/users/sections/rows.
-- ============================================================================
