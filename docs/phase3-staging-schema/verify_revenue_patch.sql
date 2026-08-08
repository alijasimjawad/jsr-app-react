-- ============================================================================
-- Verification for 09_patch_revenue_missing_columns.sql
-- ============================================================================
-- Run AFTER 09_patch_revenue_missing_columns.sql, against the same NEW JSR
-- staging project. Every statement here is a SELECT — read-only, safe to
-- run any time, as many times as you like.
-- ============================================================================

-- 1. Full current column list for public.revenue — eyeball this first.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'revenue'
order by ordinal_position;
-- Expect 11 columns: id, project_name, section_name, site_id, amount,
-- invoice_date, month, year, status, notes, added_by, created_at (12 total
-- including id/created_at) — section_name/invoice_date/status/notes/
-- added_by must all be present now.

-- 2. The 5 newly-added columns specifically.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name    = 'revenue'
  and column_name   in ('section_name', 'invoice_date', 'status', 'notes', 'added_by')
order by column_name;
-- Expect exactly 5 rows.

-- 3. Row count, unchanged-data sanity check.
select count(*) as revenue_row_count from public.revenue;
-- Informational only — compare against whatever count you knew before
-- running 09. This patch never adds, removes, or modifies a row.

-- 4. What FinRevenue.tsx's initial load query will now run successfully —
--    mirrors `.select('*').order('invoice_date', { ascending: false })`.
select *
from public.revenue
order by invoice_date desc nulls last
limit 20;
-- Should no longer error. Empty result set is fine if revenue has 0 rows;
-- the goal here is confirming the query itself succeeds.
