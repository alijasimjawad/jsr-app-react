-- ============================================================================
-- Phase 3 Step 2 — Verification (run after 01-05, in the staging project)
-- ============================================================================
-- Every statement here is a SELECT/count — read-only, safe to run any time,
-- as many times as you like. Run one section at a time in the SQL Editor
-- (it only shows the last statement's result per batch), same as the Phase
-- 2C audit file.
-- ============================================================================

-- 1. All 25 expected tables exist (17 old-JSR-derived minus 3 dead ones,
--    plus 8 React-only tables = 25) — this returns 25 rows if everything in
--    01-03 ran cleanly. Anything missing shows up as absent from the list.
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;

-- 2. Row counts — every table should show 0 (item 9: no production data
--    migrated yet), EXCEPT app_settings (1 seed row) and projects (6 seed
--    rows) from file 01.
select 'users' as table_name, count(*) from public.users
union all select 'team_members', count(*) from public.team_members
union all select 'clients', count(*) from public.clients
union all select 'activity_log', count(*) from public.activity_log
union all select 'general_expenses', count(*) from public.general_expenses
union all select 'daily_activities', count(*) from public.daily_activities
union all select 'sections', count(*) from public.sections
union all select 'revenue', count(*) from public.revenue
union all select 'sites', count(*) from public.sites
union all select 'app_settings', count(*) from public.app_settings
union all select 'projects', count(*) from public.projects
union all select 'saved_points', count(*) from public.saved_points
union all select 'employee_documents', count(*) from public.employee_documents
union all select 'expense_claims', count(*) from public.expense_claims
union all select 'salary_adjustments', count(*) from public.salary_adjustments
union all select 'push_subscriptions', count(*) from public.push_subscriptions
union all select 'invoices', count(*) from public.invoices
union all select 'rows', count(*) from public.rows
union all select 'invoice_items', count(*) from public.invoice_items
union all select 'invoice_payments', count(*) from public.invoice_payments
union all select 'cars', count(*) from public.cars
union all select 'field_trips', count(*) from public.field_trips
union all select 'trip_participants', count(*) from public.trip_participants
union all select 'attendance', count(*) from public.attendance
order by table_name;

-- 3. users has the 10 new columns (auth_user_id + 9 profile fields) and
--    team_members has username — confirms file 04 ran.
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'users' and column_name in (
      'auth_user_id','phone','national_id','date_of_birth','address',
      'emergency_contact_name','emergency_contact_phone','start_date',
      'notes','profile_photo_url'
    ))
    or (table_name = 'team_members' and column_name = 'username')
  )
order by table_name, column_name;
-- Expect 11 rows total (10 for users + 1 for team_members). Fewer rows
-- means file 04 didn't fully apply.

-- 4. All foreign keys are in place (spot-check against
--    docs/schema-audit-results/foreign_keys.csv plus the new FKs added for
--    the 8 React-only tables in file 03).
select
  tc.table_name  as referencing_table,
  kcu.column_name as referencing_column,
  ccu.table_name  as referenced_table,
  ccu.column_name as referenced_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and tc.table_schema    = 'public'
order by tc.table_name, kcu.column_name;

-- 5. Unique constraints — confirms salary_adjustments(member_id,month,year),
--    attendance(member_id,date), sections(project_name,section_name),
--    users.username, invoices.invoice_number, push_subscriptions.user_id,
--    projects.key all landed.
select tc.table_name, tc.constraint_name, kcu.column_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu
  on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
where tc.constraint_type = 'UNIQUE'
  and tc.table_schema    = 'public'
order by tc.table_name, kcu.ordinal_position;

-- 6. Indexes — confirms the 3 preserved live indexes plus the 5 new ones
--    added for the React-only tables in file 05.
select tablename, indexname
from pg_indexes
where schemaname = 'public'
  and indexname not like '%_pkey'
  and indexname not like '%_key'
order by tablename, indexname;

-- 7. auth.users is empty in this new staging project too (expected — this
--    is a brand-new Supabase project, no Auth migration has run yet).
select count(*) as auth_users_count from auth.users;

-- 8. Extensions confirmed present (needed for users.id's uuid_generate_v4()
--    default from file 01).
select extname from pg_extension where extname in ('pgcrypto','uuid-ossp');
