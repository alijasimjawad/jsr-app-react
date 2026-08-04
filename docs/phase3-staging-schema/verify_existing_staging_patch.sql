-- ============================================================================
-- Verification for 07_patch_existing_staging_schema.sql
-- ============================================================================
-- Run AFTER 07_patch_existing_staging_schema.sql, against the same EXISTING
-- staging project ("JSR Network Tracker React"). Every statement here is a
-- SELECT — read-only, safe to run any time, as many times as you like. Run
-- one section at a time in the SQL Editor (it only shows the last
-- statement's result per batch), same convention as verify_staging_schema.sql.
-- ============================================================================

-- 1. project_expenses exists with the expected column count/shape.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'project_expenses'
order by ordinal_position;
-- Expect 16 rows (id through approved_by). Zero rows means the create
-- statement in 07 did not run or failed.

-- 2. project_expenses row count — informational only, not a pass/fail
-- signal on its own (this patch never writes production data, so whatever
-- count shows here reflects whatever existed before/after independently of
-- this file).
select count(*) as project_expenses_row_count from public.project_expenses;

-- 3. users.password is nullable.
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'users'
  and column_name   = 'password';
-- Expect is_nullable = 'YES'.

-- 4. sections — the four corrected columns are all NOT NULL, with the
--    `columns` default in place.
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'sections'
  and column_name   in ('section_label', 'columns', 'is_custom', 'is_deleted')
order by column_name;
-- Expect all 4 rows with is_nullable = 'NO'; `columns` row's column_default
-- should show '[]'::jsonb.

-- 5. rows — data/row_order are NOT NULL with the corrected defaults.
select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'rows'
  and column_name   in ('data', 'row_order')
order by column_name;
-- Expect both rows with is_nullable = 'NO'; `data` default '{}'::jsonb,
-- `row_order` default 0.

-- 6. rows.section_id FK has ON DELETE CASCADE.
select
  tc.constraint_name,
  rc.delete_rule
from information_schema.table_constraints tc
join information_schema.referential_constraints rc
  on tc.constraint_name = rc.constraint_name
 and tc.table_schema     = rc.constraint_schema
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema     = kcu.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema    = 'public'
  and tc.table_name      = 'rows'
  and kcu.column_name    = 'section_id';
-- Expect exactly 1 row, delete_rule = 'CASCADE'.

-- 7. rows_updated_at trigger exists.
select trigger_name, event_manipulation, event_object_table, action_timing
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name    = 'rows_updated_at';
-- Expect exactly 1 row: rows_updated_at | UPDATE | rows | BEFORE.

-- 8. rows_section_order_idx is the composite (section_id, row_order) shape,
--    not the old single-column version.
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename    = 'rows'
  and indexname    = 'rows_section_order_idx';
-- Expect indexdef to reference both (section_id, row_order), in that order.

-- 9. RLS sanity check — confirms this patch did NOT enable RLS on any of
--    the four tables it touched (that stays 06's job, still un-run).
select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('project_expenses', 'users', 'sections', 'rows');
-- Expect relrowsecurity = false for all 4 rows, until 06 is deliberately run.

-- 10. Row counts, unchanged-data sanity check — sections/rows/project_expenses
--     row counts, so you can compare against whatever you already knew these
--     held before running 07 (this patch does not add, remove, or modify any
--     business-data row).
select 'sections' as table_name, count(*) from public.sections
union all select 'rows', count(*) from public.rows
union all select 'project_expenses', count(*) from public.project_expenses
union all select 'users', count(*) from public.users
order by table_name;
