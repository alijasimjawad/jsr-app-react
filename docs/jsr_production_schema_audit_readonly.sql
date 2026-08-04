-- ============================================================================
-- JSR Phase 2C — Read-only production schema audit
-- ============================================================================
-- Target project ONLY: tltbkjvrhqsxdspdfeqk  (JSR's real Supabase project)
-- Do NOT run this against gauejhgitzcqjvzalshf (TAC's project) or any other
-- project. See docs/jsr_production_schema_audit_readonly_INSTRUCTIONS.md
-- for how to run this safely and verify the project before executing.
--
-- Every statement in this file is a SELECT against Postgres/Supabase system
-- catalogs (information_schema, pg_catalog, pg_policies, pg_stat_user_tables)
-- or a plain `select count(*) from <table>` against public-schema tables.
-- Nothing here creates, alters, drops, inserts, updates, deletes, truncates,
-- grants, revokes, or changes any RLS policy. It only reads metadata and
-- counts rows.
--
-- HOW TO RUN: the Supabase SQL Editor only displays the result of the LAST
-- statement in a batch when you run multiple statements at once. Run ONE
-- numbered section at a time (select just that section's text, then Run)
-- so you can see and export each section's own result grid before moving
-- to the next one.
-- ============================================================================


-- ============================================================================
-- 0. Sanity header — confirms you're connected to *a* database; does NOT by
--    itself prove which Supabase project you're in. You must verify the
--    project visually in the dashboard URL/Settings before running anything
--    (see the instructions file).
-- ============================================================================
select
  current_database() as database_name,
  now()               as run_at;


-- ============================================================================
-- 1. All public tables
-- ============================================================================
select
  table_name,
  table_type
from information_schema.tables
where table_schema = 'public'
order by table_name;


-- ============================================================================
-- 2. Every column: data type, nullability, default (all public tables)
-- ============================================================================
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.character_maximum_length,
  c.numeric_precision,
  c.numeric_scale,
  c.is_nullable,
  c.column_default
from information_schema.columns c
where c.table_schema = 'public'
order by c.table_name, c.ordinal_position;


-- ============================================================================
-- 3. Primary keys
-- ============================================================================
select
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name
 and tc.table_schema    = kcu.table_schema
where tc.constraint_type = 'PRIMARY KEY'
  and tc.table_schema    = 'public'
order by tc.table_name, kcu.ordinal_position;


-- ============================================================================
-- 4. Foreign keys
-- ============================================================================
select
  tc.table_name  as referencing_table,
  kcu.column_name as referencing_column,
  ccu.table_name  as referenced_table,
  ccu.column_name as referenced_column,
  tc.constraint_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema    = 'public'
order by tc.table_name, kcu.column_name;


-- ============================================================================
-- 5. Unique constraints
-- ============================================================================
select
  tc.table_name,
  tc.constraint_name,
  kcu.column_name,
  kcu.ordinal_position
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
where tc.constraint_type = 'UNIQUE'
  and tc.table_schema    = 'public'
order by tc.table_name, kcu.ordinal_position;


-- ============================================================================
-- 6. Indexes
-- ============================================================================
select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;


-- ============================================================================
-- 7. RLS enabled/disabled status per table
-- ============================================================================
select
  n.nspname     as schema_name,
  c.relname     as table_name,
  c.relrowsecurity     as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
order by c.relname;


-- ============================================================================
-- 8. All current RLS policies
-- ============================================================================
select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;


-- ============================================================================
-- 9a. Approximate row counts for ALL public tables (fast, no table scan —
--     reads Postgres's own live-tuple statistics, safe on large tables)
-- ============================================================================
select
  schemaname,
  relname as table_name,
  n_live_tup as approx_row_count
from pg_stat_user_tables
where schemaname = 'public'
order by relname;


-- ============================================================================
-- 9b. Exact row counts for the 12 named tables from item 11 below.
--     If any of these tables doesn't exist in this project, its line will
--     error out the whole block — run query 11a first to see which of the
--     12 actually exist here, then comment out (prefix with `--`) any line
--     below for a table that doesn't exist before running this section.
-- ============================================================================
select 'users'               as table_name, count(*) as exact_row_count from public.users
union all select 'team_members',        count(*) from public.team_members
union all select 'project_expenses',    count(*) from public.project_expenses
union all select 'push_subscriptions',  count(*) from public.push_subscriptions
union all select 'expense_claims',      count(*) from public.expense_claims
union all select 'daily_activities',    count(*) from public.daily_activities
union all select 'salary_adjustments',  count(*) from public.salary_adjustments
union all select 'invoices',            count(*) from public.invoices
union all select 'invoice_items',       count(*) from public.invoice_items
union all select 'invoice_payments',    count(*) from public.invoice_payments
union all select 'clients',             count(*) from public.clients
union all select 'employee_documents',  count(*) from public.employee_documents
order by table_name;


-- ============================================================================
-- 10. Whether auth.users has any records — count only, no emails or
--     identities are selected or exposed.
-- ============================================================================
select count(*) as auth_users_count
from auth.users;


-- ============================================================================
-- 11a. Existence check for the 12 named tables (run this BEFORE 9b/11b so
--      you know which of them actually exist in this project)
-- ============================================================================
select
  t as expected_table_name,
  exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name   = t
  ) as exists_in_this_project
from unnest(array[
  'users', 'team_members', 'project_expenses', 'push_subscriptions',
  'expense_claims', 'daily_activities', 'salary_adjustments', 'invoices',
  'invoice_items', 'invoice_payments', 'clients', 'employee_documents'
]) as t
order by t;


-- ============================================================================
-- 11b. Exact schema (columns + nullability + default + PK/FK flags) for the
--      12 named tables only — a filtered, convenience view of items 2-4
--      scoped to just the tables in item 11 of the request.
-- ============================================================================
select
  c.table_name,
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default,
  exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.constraint_type = 'PRIMARY KEY'
      and tc.table_schema    = 'public'
      and kcu.table_name     = c.table_name
      and kcu.column_name    = c.column_name
  ) as is_primary_key,
  exists (
    select 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema    = 'public'
      and kcu.table_name     = c.table_name
      and kcu.column_name    = c.column_name
  ) as is_foreign_key
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name in (
    'users', 'team_members', 'project_expenses', 'push_subscriptions',
    'expense_claims', 'daily_activities', 'salary_adjustments', 'invoices',
    'invoice_items', 'invoice_payments', 'clients', 'employee_documents'
  )
order by c.table_name, c.ordinal_position;


-- ============================================================================
-- 11c. Indexes and RLS policies for just the 12 named tables (convenience
--      filter of items 6 and 8)
-- ============================================================================
select
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'users', 'team_members', 'project_expenses', 'push_subscriptions',
    'expense_claims', 'daily_activities', 'salary_adjustments', 'invoices',
    'invoice_items', 'invoice_payments', 'clients', 'employee_documents'
  )
order by tablename, indexname;

select
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'users', 'team_members', 'project_expenses', 'push_subscriptions',
    'expense_claims', 'daily_activities', 'salary_adjustments', 'invoices',
    'invoice_items', 'invoice_payments', 'clients', 'employee_documents'
  )
order by tablename, policyname;

-- ============================================================================
-- End of audit. Nothing above modifies any data, schema, policy, or grant.
-- ============================================================================
