-- ============================================================================
-- Phase 3 Step 2 — 02: Tables that depend on 01 (FKs to users/team_members/
-- clients/sections)
-- ============================================================================
-- Run AFTER 01_extensions_and_core_tables.sql. Same target-project warning
-- applies — see STAGING_EXECUTION_CHECKLIST.md.
-- ============================================================================

-- ── employee_documents (→ team_members) ─────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.employee_documents (
  id           uuid        primary key default gen_random_uuid(),
  member_id    uuid        references public.team_members(id),
  file_name    text        not null,
  file_url     text        not null,
  file_type    text,
  uploaded_by  text,
  uploaded_at  timestamp   default now()
);

-- ── expense_claims (→ team_members) ─────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv (20 columns).
-- Note (already flagged in Phase 2D): has BOTH rejection_comment and
-- rejection_reason live — not recreating one as an assumed duplicate,
-- both are kept for parity until you confirm which one the app actually
-- writes to.
--
-- Scope note: does NOT include is_car_trip / daily_activity_id / car_id /
-- car_trip_distance_km / car_trip_rate_iqd (react_migration_phase17) or
-- section_id / section_label (react_migration_phase15) — none of those
-- exist on live JSR today and you didn't list them in Step 2. Same
-- follow-up note as daily_activities in file 01.
create table if not exists public.expense_claims (
  id                 uuid        primary key default gen_random_uuid(),
  member_id          uuid        references public.team_members(id),
  project_name       text        not null,
  site_id            text,
  governorate        text,
  description        text,
  activity_date      date        not null,
  transport_amount   numeric     default 0,
  food_amount        numeric     default 0,
  accommodation      text,
  extra_categories   jsonb       default '[]'::jsonb,
  total_amount       numeric     default 0,
  status             text        default 'pending',
  rejection_comment  text,
  submitted_at       timestamp   default now(),
  reviewed_at        timestamp,
  reviewed_by        text,
  notes              text,
  rejection_reason   text,
  employee_ids       jsonb       default '[]'::jsonb
);

-- ── salary_adjustments (→ team_members) ─────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/12_missing_core_tables_schema.csv
create table if not exists public.salary_adjustments (
  id               uuid        primary key default gen_random_uuid(),
  member_id        uuid        references public.team_members(id),
  month            integer     not null,
  year             integer     not null,
  adjusted_amount  numeric     not null default 0,
  reason           text,
  created_at       timestamptz default now(),
  adj_type         text        default 'override',
  constraint salary_adjustments_member_month_year_unique unique (member_id, month, year)
);

-- ── push_subscriptions (→ users) ─────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
-- Note: user_id points directly at users.id (old JSR never used Supabase
-- Auth) — no auth_user_id indirection at the DB level for this table.
create table if not exists public.push_subscriptions (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        unique references public.users(id),
  subscription  jsonb       not null,
  created_at    timestamp   default now()
);

-- ── invoices (→ clients) ─────────────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/11b_flagged_tables_schema_complete.csv
create table if not exists public.invoices (
  id               uuid        primary key default gen_random_uuid(),
  created_at       timestamptz default now(),
  invoice_number   text        not null unique,
  client_id        uuid        references public.clients(id),
  project_name     text,
  issue_date       date,
  due_date         date,
  total_amount     numeric     default 0,
  amount_received  numeric     default 0,
  status           text        default 'Draft',
  notes            text,
  created_by       text
);

-- ── rows (→ sections) ────────────────────────────────────────────────────
-- RESOLVED as part of the Phase 4 schema patch: the original
-- /Users/alijasim/Desktop/JSR/supabase_setup.sql confirms every column and
-- constraint below, superseding the Phase 2B inference this table
-- previously relied on (beyond id/PK and the section_id FK, which
-- foreign_keys.csv already confirmed). Three corrections against the
-- previous version of this file:
--   1. section_id now has ON DELETE CASCADE (previously no ON DELETE
--      clause, which defaults to NO ACTION — deleting a section would have
--      been blocked by its remaining rows instead of cleaning them up).
--   2. data / row_order are now NOT NULL with the same defaults as the
--      original (previously nullable, row_order had no default).
--   3. A shared `update_updated_at()` trigger function now keeps
--      `updated_at` current on every row change (previously absent
--      entirely — updated_at existed as a column but nothing maintained
--      it after the initial insert).
create table if not exists public.rows (
  id          uuid        primary key default gen_random_uuid(),
  section_id  uuid        references public.sections(id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  row_order   integer     not null default 0,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- Auto-maintained updated_at — matches original supabase_setup.sql exactly.
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

-- ── invoice_items (→ invoices) ───────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.invoice_items (
  id            uuid        primary key default gen_random_uuid(),
  invoice_id    uuid        references public.invoices(id),
  site_id       text,
  section_name  text,
  description   text,
  amount        numeric     default 0,
  revenue_id    uuid
);

-- ── invoice_payments (→ invoices) ────────────────────────────────────────
-- Live-confirmed via docs/schema-audit-results/all_columns.csv
create table if not exists public.invoice_payments (
  id            uuid        primary key default gen_random_uuid(),
  created_at    timestamptz default now(),
  invoice_id    uuid        references public.invoices(id),
  payment_date  date,
  amount        numeric     default 0,
  reference     text,
  notes         text,
  recorded_by   text
);
