-- docs/go-live/20_add_salary_advances.sql
--
-- Purpose: Add salary-advance ("سلفة") tracking — a team leader/engineer
--          receives a lump-sum advance from admin, distributes it in cash to
--          their own team members over time (logged one payment at a time),
--          and whatever they haven't distributed by the time payroll runs
--          is deducted from their own salary instead. Every recipient
--          (including the leader, for their undistributed remainder) has
--          their share deducted from THEIR OWN net pay in the target month.
--
-- WHY: Existing public.salary_adjustments has a UNIQUE(member_id, month,
--      year) constraint and is already used by the "Adjust Salary" admin
--      action (FinReport.tsx / fin_report_adjust_salary permission) — a
--      single override/bonus/deduction slot per member per month. Advances
--      needed their own tables instead of overloading that one slot,
--      because (a) a member could already have a manual adjustment that
--      month for an unrelated reason, and (b) advances need a running,
--      itemized ledger (who got how much, when, why) — not a single number.
--      FinPayslips.tsx/FinReport.tsx compute the advance deduction live from
--      these tables at payroll time; nothing is written back into
--      salary_adjustments.
--
-- Design (agreed with user in-chat before this file was written):
--   1. Admin opens an `advances` batch: total amount, assigned to a
--      team_leader (team_members.id), target deduction month/year (defaults
--      to the nearest upcoming payroll).
--   2. The team leader (logged in as that team_member, resolved via
--      jsr_current_team_member_id()) adds `advance_distributions` entries
--      over time as they actually hand out cash — one row per payment:
--      recipient member, amount, date, free-text details. They can keep
--      adding entries until the batch's remaining balance
--      (total_amount - sum(distributions)) hits zero.
--   3. Every recipient (including the leader) can see their own
--      distribution entries — "how much did I get, when, for what".
--   4. At payroll time for the batch's target month/year:
--        - each recipient's net pay is reduced by the sum of distributions
--          they personally received under batches targeting that month;
--        - the leader's net pay is ADDITIONALLY reduced by any remainder
--          left undistributed in their own batches targeting that month
--          (total_amount - sum(distributions) at the time payroll runs) —
--          automatic, no manual "close batch" step required.
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
-- Requires rls_hardening.sql's helper functions (jsr_is_admin(),
-- jsr_current_team_member_id()) to already exist in this project.

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists public.advances (
  id             uuid        primary key default gen_random_uuid(),
  team_leader_id uuid        not null references public.team_members(id),
  total_amount   numeric     not null check (total_amount > 0),
  month          integer     not null check (month between 1 and 12),
  year           integer     not null check (year between 2020 and 2100),
  reason         text,
  created_by     uuid        references public.users(id),
  created_at     timestamptz default now()
);

create index if not exists advances_team_leader_idx on public.advances(team_leader_id);
create index if not exists advances_month_year_idx  on public.advances(month, year);

create table if not exists public.advance_distributions (
  id           uuid        primary key default gen_random_uuid(),
  advance_id   uuid        not null references public.advances(id) on delete cascade,
  member_id    uuid        not null references public.team_members(id),
  amount       numeric     not null check (amount > 0),
  entry_date   date        not null default current_date,
  details      text,
  created_by   uuid        references public.team_members(id),
  created_at   timestamptz default now()
);

create index if not exists advance_distributions_advance_idx on public.advance_distributions(advance_id);
create index if not exists advance_distributions_member_idx  on public.advance_distributions(member_id);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Mirrors the pattern already applied in docs/go-live/rls_hardening.sql
-- (jsr_is_admin(), jsr_current_team_member_id() helper functions).

alter table public.advances              enable row level security;
alter table public.advance_distributions enable row level security;

drop policy if exists "advances_select_own_or_admin" on public.advances;
drop policy if exists "advances_insert_admin"         on public.advances;
drop policy if exists "advances_update_admin"         on public.advances;
drop policy if exists "advances_delete_admin"         on public.advances;

-- SELECT: the assigned team leader sees their own batches; admin sees all.
create policy "advances_select_own_or_admin" on public.advances
  for select to authenticated
  using (
    team_leader_id = public.jsr_current_team_member_id()
    or public.jsr_is_admin()
  );

-- INSERT/UPDATE/DELETE: admin only — opening/editing/removing a batch is an
-- admin action. Team leaders never touch this table directly, only
-- advance_distributions.
create policy "advances_insert_admin" on public.advances
  for insert to authenticated
  with check (public.jsr_is_admin());

create policy "advances_update_admin" on public.advances
  for update to authenticated
  using (public.jsr_is_admin())
  with check (public.jsr_is_admin());

create policy "advances_delete_admin" on public.advances
  for delete to authenticated
  using (public.jsr_is_admin());


drop policy if exists "advance_distributions_select_recipient_or_leader_or_admin" on public.advance_distributions;
drop policy if exists "advance_distributions_insert_leader_or_admin"              on public.advance_distributions;
drop policy if exists "advance_distributions_update_leader_or_admin"              on public.advance_distributions;
drop policy if exists "advance_distributions_delete_leader_or_admin"              on public.advance_distributions;

-- SELECT: the recipient sees their own entries; the leader who owns the
-- parent batch sees every entry under it (so they can track what they've
-- given out so far); admin sees all.
create policy "advance_distributions_select_recipient_or_leader_or_admin" on public.advance_distributions
  for select to authenticated
  using (
    member_id = public.jsr_current_team_member_id()
    or advance_id in (
      select id from public.advances where team_leader_id = public.jsr_current_team_member_id()
    )
    or public.jsr_is_admin()
  );

-- INSERT: only the leader who owns the batch, logging entries under their
-- own name, or admin.
create policy "advance_distributions_insert_leader_or_admin" on public.advance_distributions
  for insert to authenticated
  with check (
    (
      created_by = public.jsr_current_team_member_id()
      and advance_id in (
        select id from public.advances where team_leader_id = public.jsr_current_team_member_id()
      )
    )
    or public.jsr_is_admin()
  );

-- UPDATE/DELETE: the leader can fix/remove their own logged entries; admin any.
create policy "advance_distributions_update_leader_or_admin" on public.advance_distributions
  for update to authenticated
  using (created_by = public.jsr_current_team_member_id() or public.jsr_is_admin())
  with check (created_by = public.jsr_current_team_member_id() or public.jsr_is_admin());

create policy "advance_distributions_delete_leader_or_admin" on public.advance_distributions
  for delete to authenticated
  using (created_by = public.jsr_current_team_member_id() or public.jsr_is_admin());


-- ── Post-apply verification ──────────────────────────────────────────────────
-- Expected: both tables exist with rowsecurity = true, 4 policies on
-- advances, 4 on advance_distributions.
select relname, relrowsecurity
from pg_class
where relname in ('advances', 'advance_distributions');

select schemaname, tablename, policyname, cmd
from pg_policies
where tablename in ('advances', 'advance_distributions')
order by tablename, policyname;
