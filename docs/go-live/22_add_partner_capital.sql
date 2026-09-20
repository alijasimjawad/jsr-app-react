-- docs/go-live/22_add_partner_capital.sql
--
-- Purpose: "Partner Capital" — a standalone admin-only ledger tracking how
--          much money each company partner has put into the company. Not
--          linked to invoices/revenue/payroll — a separate section.
--
-- Design (agreed with user in-chat before this file was written):
--   1. Partners ARE the existing admin accounts (public.users where
--      role = 'admin') — there is no separate "partners" table. A dropdown
--      on the page lists admin-role users to attribute a contribution to.
--   2. Only admins can add, view, edit, or delete entries. There is no
--      leader/self-view split like Advances — any admin who opens the page
--      sees every partner's full contribution history.
--   3. No ownership-percentage/ratio calculation — just running amounts per
--      partner and a grand total.
--   4. Every entry records who added it (created_by) and, if edited, who
--      last edited it (updated_by/updated_at) so the page can show
--      "Added by X" / "Edited by Y" per row.
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

create table if not exists public.partner_capital_entries (
  id           uuid        primary key default gen_random_uuid(),
  partner_id   uuid        not null references public.users(id),
  amount       numeric     not null check (amount > 0),
  entry_date   date        not null default current_date,
  note         text,
  created_by   uuid        references public.users(id),
  created_at   timestamptz default now(),
  updated_by   uuid        references public.users(id),
  updated_at   timestamptz
);

create index if not exists partner_capital_entries_partner_idx on public.partner_capital_entries(partner_id);
create index if not exists partner_capital_entries_date_idx    on public.partner_capital_entries(entry_date);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Admin-only, full stop — no partner self-view, matches the agreed design.

alter table public.partner_capital_entries enable row level security;

drop policy if exists "partner_capital_entries_select_admin" on public.partner_capital_entries;
drop policy if exists "partner_capital_entries_insert_admin" on public.partner_capital_entries;
drop policy if exists "partner_capital_entries_update_admin" on public.partner_capital_entries;
drop policy if exists "partner_capital_entries_delete_admin" on public.partner_capital_entries;

create policy "partner_capital_entries_select_admin" on public.partner_capital_entries
  for select to authenticated
  using (public.jsr_is_admin());

create policy "partner_capital_entries_insert_admin" on public.partner_capital_entries
  for insert to authenticated
  with check (public.jsr_is_admin());

create policy "partner_capital_entries_update_admin" on public.partner_capital_entries
  for update to authenticated
  using (public.jsr_is_admin())
  with check (public.jsr_is_admin());

create policy "partner_capital_entries_delete_admin" on public.partner_capital_entries
  for delete to authenticated
  using (public.jsr_is_admin());


-- ── Post-apply verification ──────────────────────────────────────────────────
-- Expected: table exists with rowsecurity = true, 4 policies.
select relname, relrowsecurity
from pg_class
where relname = 'partner_capital_entries';

select schemaname, tablename, policyname, cmd
from pg_policies
where tablename = 'partner_capital_entries'
order by policyname;
