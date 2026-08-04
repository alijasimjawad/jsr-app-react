-- ============================================================================
-- Verification for 08_patch_projects_tac_mrc.sql
-- ============================================================================
-- Run AFTER 08_patch_projects_tac_mrc.sql, against the same NEW JSR staging
-- project. Every statement here is a SELECT — read-only, safe to run any
-- time, as many times as you like. Run one section at a time in the SQL
-- Editor (it only shows the last statement's result per batch), same
-- convention as verify_staging_schema.sql / verify_existing_staging_patch.sql.
-- ============================================================================

-- 1. Full current project list, in UI order — eyeball this first.
select key, display_name, has_sections, sort_order, is_active
from public.projects
order by sort_order;
-- Expect 6 rows: zain, nokia, huawei, ipt (unchanged, is_active = true),
-- moj, general (is_active = false), tac, mrc (is_active = true,
-- sort_order 5 and 6).

-- 2. moj and general are deactivated, not deleted.
select key, display_name, is_active
from public.projects
where key in ('moj', 'general');
-- Expect exactly 2 rows, both is_active = false. Zero rows here would mean
-- they were hard-deleted somewhere else, not by this patch.

-- 3. tac and mrc exist with the confirmed shape.
select key, display_name, has_sections, sort_order, is_active
from public.projects
where key in ('tac', 'mrc')
order by sort_order;
-- Expect exactly 2 rows:
--   tac | TAC Project | true | 5 | true
--   mrc | MRC Project | true | 6 | true

-- 4. What the app will actually show — mirrors
--    projectsCache.ts's ensureProjectsLoaded() query exactly
--    (.eq('is_active', true).order('sort_order')).
select key, display_name, has_sections, sort_order
from public.projects
where is_active = true
order by sort_order;
-- Expect 6 rows: zain, nokia, huawei, ipt, tac, mrc — moj/general absent.

-- 5. Data-preservation sanity check — any sections (and their rows) tied to
--    the moj/general project_name values are untouched by this patch.
select section.project_name, count(*) as section_count, sum(row_counts.row_count) as row_count
from public.sections section
left join (
  select section_id, count(*) as row_count
  from public.rows
  group by section_id
) row_counts on row_counts.section_id = section.id
where section.project_name in ('moj', 'general', 'MOJ Project', 'General')
group by section.project_name
order by section.project_name;
-- Informational only — compare against whatever counts you already knew
-- these held before running 08. This patch does not add, remove, or modify
-- any row in sections or rows; it only flips is_active on public.projects.
-- Note: sections.project_name historically stores whichever value the app
-- passed at write time (sometimes the key, sometimes the display name) —
-- checking both here rather than assuming one form.
