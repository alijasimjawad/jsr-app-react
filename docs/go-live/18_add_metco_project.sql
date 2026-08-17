-- docs/go-live/18_add_metco_project.sql
--
-- Purpose: Add a new project — key='metco', display_name='Metco Project' —
--          to public.projects, so it appears in Network Scopes / Dashboard /
--          User Management's per-project permission toggles.
--
-- WHY: public.projects is the single source of truth for the app's project
--      list (src/lib/projectsCache.ts reads it directly, filtered to
--      is_active = true) — no other table needs to change to add a project.
--      Sidebar.tsx and Dashboard.tsx already have a 'metco' entry in their
--      DEFAULT_SECTIONS map (FTK, TDD, Add Sector — same as Zain/Nokia/
--      Huawei), so the first time any user loads the sidebar after this
--      project exists, those 3 default sections are auto-seeded into
--      public.sections for it (see NetworkScopesTree()'s section-seed
--      effect in Sidebar.tsx).
--
-- Current active projects (sort_order): zain(1), nokia(2), huawei(3),
--   ipt(4), tac(5), mrc(6). moj/general are soft-deactivated (is_active =
--   false) per 08_patch_projects_tac_mrc.sql. metco takes the next slot, 7.
--
-- Permissions: view_metco is NOT granted to anyone by default (secure by
--   default — see hasPerm() in AuthContext.tsx). After running this, go to
--   User Management → edit each user who needs Metco access → toggle on
--   "Metco Project" under the Projects permission group. Admins already see
--   everything regardless.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Idempotent: ON CONFLICT (key) DO NOTHING — safe to re-run.
-- Not executed by me — file only, per standing instructions. Run this
-- yourself in the JSR React project's Supabase SQL Editor after confirming
-- the project ref in the dashboard URL.

insert into public.projects (key, display_name, has_sections, sort_order, is_active) values
  ('metco', 'Metco Project', true, 7, true)
on conflict (key) do nothing;

-- ── Post-apply verification ──────────────────────────────────────────────────
-- Expected: 1 row, is_active = true, sort_order = 7.
select key, display_name, has_sections, sort_order, is_active
from public.projects
where key = 'metco';
