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
-- NOT live-column-confirmed beyond id/PK, section_id/FK
-- (foreign_keys.csv confirms `rows.section_id → sections.id`), and two
-- named indexes (rows_section_id_idx, rows_section_order_idx — implying a
-- row-ordering column exists). The rest of the column list below is Phase
-- 2B's inference from React's code, not a live export. Recommend
-- confirming with a live column export before running this file — see
-- checklist. `data` as jsonb is a guess based on this table's apparent
-- purpose (a generic per-section data-grid row store) — verify before
-- relying on it.
create table if not exists public.rows (
  id          uuid        primary key default gen_random_uuid(),
  section_id  uuid        references public.sections(id),
  data        jsonb       default '{}'::jsonb,
  row_order   integer,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

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
