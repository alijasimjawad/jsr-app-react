-- docs/go-live/24_add_kuwait_energy_project.sql
--
-- Purpose: Add a new project — key='kuwaitenergy',
--          display_name='Kuwait Energy (Safe Hands)' — to public.projects, so
--          it appears in Network Scopes / Dashboard / User Management's
--          per-project permission toggles.
--
-- Same mechanism as 18_add_metco_project.sql: public.projects is the single
-- source of truth for the project list. Sidebar.tsx and Dashboard.tsx have a
-- 'kuwaitenergy' entry in DEFAULT_SECTIONS (FTK, TDD, Add Sector), so the
-- default sections are auto-seeded into public.sections the first time the
-- sidebar loads after this project exists.
--
-- Active projects (sort_order): zain(1), nokia(2), huawei(3), ipt(4), tac(5),
--   mrc(6), metco(7). kuwaitenergy takes the next slot, 8.
--
-- Permissions: view_kuwaitenergy is NOT granted to anyone by default. After
--   running this, go to User Management → edit each user who needs access →
--   toggle on "Kuwait Energy (Safe Hands)" under Projects. Admins see all.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Idempotent: ON CONFLICT (key) DO NOTHING — safe to re-run.

insert into public.projects (key, display_name, has_sections, sort_order, is_active) values
  ('kuwaitenergy', 'Kuwait Energy (Safe Hands)', true, 8, true)
on conflict (key) do nothing;

-- Verification: expect 1 row, is_active = true, sort_order = 8.
select key, display_name, has_sections, sort_order, is_active
from public.projects
where key = 'kuwaitenergy';
