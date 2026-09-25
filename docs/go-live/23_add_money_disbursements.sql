-- docs/go-live/23_add_money_disbursements.sql
--
-- Purpose: "Money Out" — a standalone admin-only ledger of every disbursement
--          out of the company (salaries, team advances, operational spend,
--          anything else). Not linked to invoices/revenue/payroll, and not
--          a cost-categorization report like General Expenses / Project
--          Expenses — this is a custody/accountability log: who gave the
--          money out, who/what it went to, and who logged the entry.
--
-- Design (agreed with user in-chat before this file was written):
--   1. Free-text log, not a structured expense-category breakdown. Fields:
--      date, given_by (free text — who inside the company handed the money
--      out, e.g. "Finance Manager" or a name), given_to (free text — who or
--      what it went to, e.g. "Team salaries — September" or a person's
--      name), category (free text tag reusing the existing General
--      Expenses category list for filtering, but not restricted to it),
--      amount, notes.
--   2. Admin-only — same access model as Partner Capital: no leader/self
--      view split, any admin who opens the page sees the full log. No
--      permissionsCatalog / ACTION_SCOPES entries — gated by a direct
--      `currentUser.role === 'admin'` check in the page component, and a
--      hardcoded admin-only Sidebar entry, matching how Partner Capital is
--      wired (see src/pages/PartnerCapital.tsx, src/components/Sidebar.tsx).
--   3. Every entry records who added it (created_by) and, if edited, who
--      last edited it (updated_by/updated_at), so the page can show
--      "Added by X" / "Edited by Y" per row — same pattern as Partner
--      Capital.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Idempotent: create table/policy use IF NOT EXISTS / DROP POLICY IF EXISTS
-- guards — safe to re-run. Not executed by me — file only, per standing
-- instructions. Run this yourself in the JSR React project's Supabase SQL
-- Editor after confirming the project ref in the dashboard URL.
-- Requires rls_hardening.sql's jsr_is_admin() helper function to already
-- exist in this project.

-- ── Table ────────────────────────────────────────────────────────────────────

create table if not exists public.money_disbursements (
  id               uuid        primary key default gen_random_uuid(),
  disbursement_date date       not null default current_date,
  given_by         text        not null,
  given_to         text        not null,
  category         text,
  amount           numeric     not null check (amount > 0),
  notes            text,
  created_by       uuid        references public.users(id),
  created_at       timestamptz default now(),
  updated_by       uuid        references public.users(id),
  updated_at       timestamptz
);

create index if not exists money_disbursements_date_idx     on public.money_disbursements(disbursement_date);
create index if not exists money_disbursements_category_idx on public.money_disbursements(category);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Admin-only, full stop — matches Partner Capital's agreed design.

alter table public.money_disbursements enable row level security;

drop policy if exists "money_disbursements_select_admin" on public.money_disbursements;
drop policy if exists "money_disbursements_insert_admin" on public.money_disbursements;
drop policy if exists "money_disbursements_update_admin" on public.money_disbursements;
drop policy if exists "money_disbursements_delete_admin" on public.money_disbursements;

create policy "money_disbursements_select_admin" on public.money_disbursements
  for select to authenticated
  using (public.jsr_is_admin());

create policy "money_disbursements_insert_admin" on public.money_disbursements
  for insert to authenticated
  with check (public.jsr_is_admin());

create policy "money_disbursements_update_admin" on public.money_disbursements
  for update to authenticated
  using (public.jsr_is_admin())
  with check (public.jsr_is_admin());

create policy "money_disbursements_delete_admin" on public.money_disbursements
  for delete to authenticated
  using (public.jsr_is_admin());


-- ── Post-apply verification ──────────────────────────────────────────────────
-- Expected: table exists with rowsecurity = true, 4 policies.
select relname, relrowsecurity
from pg_class
where relname = 'money_disbursements';

select schemaname, tablename, policyname, cmd
from pg_policies
where tablename = 'money_disbursements'
order by policyname;
