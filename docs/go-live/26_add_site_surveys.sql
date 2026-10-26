-- docs/go-live/26_add_site_surveys.sql
--
-- Purpose: "Site Surveys" — per-court site surveys (e.g. for installing new
--          Keystones) created from the app by field staff, with required
--          photos, reviewed by an admin.
--
-- Design (agreed with user in-chat):
--   1. One survey per court. A survey has a fixed set of form fields and a
--      fixed list of photo "slots" (overview, keystone location, power
--      point, cable route, mounting surface, access, obstacles).
--   2. Engineers and technicians create/fill/submit surveys. Admin reviews:
--      approve, or return with a comment so the surveyor can fix and
--      resubmit.
--      Status flow: draft -> submitted -> approved
--                              submitted -> returned -> (edit) -> submitted
--   3. Field users only see/edit their OWN surveys, and only while the
--      survey is 'draft' or 'returned'. They can never set 'approved' or
--      'returned' themselves (WITH CHECK allows only draft/submitted).
--      Admin can do everything.
--   4. Photos live in a PRIVATE storage bucket 'site-survey-photos'
--      (path: <survey_id>/<slot>-<timestamp>.jpg); public.survey_photos
--      stores one row per photo. Viewing uses signed URLs.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS / ON CONFLICT). File
-- only — run it yourself in the JSR React project's Supabase SQL Editor.
-- Requires rls_hardening.sql helper functions (jsr_is_admin,
-- jsr_current_user_id) to already exist.

-- ── Helper ───────────────────────────────────────────────────────────────────
-- jsr_current_user_id() is defined in rls_hardening.sql but is missing in this
-- project's database (ERROR 42883), so it is created here. Same definition as
-- rls_hardening.sql; CREATE OR REPLACE makes it safe to re-run.

create or replace function public.jsr_current_user_id()
  returns uuid
  language sql stable security definer
  set search_path = public, auth
as $$
  select id from public.users where auth_user_id = auth.uid() limit 1;
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────

create table if not exists public.site_surveys (
  id                 uuid        primary key default gen_random_uuid(),
  project_name       text,
  court_name         text        not null,
  court_id           text,
  governorate        text,
  address            text,
  latitude           numeric,
  longitude          numeric,
  survey_date        date        not null default current_date,
  court_type         text,                 -- 'indoor' | 'outdoor'
  dimensions         text,
  existing_cabling   text,                 -- 'yes' | 'no'
  existing_cabling_notes text,
  power_available    text,                 -- 'yes' | 'no'
  power_distance     text,
  mounting_surface   text,                 -- wall | pole | ceiling | other
  mounting_height    text,
  access_constraints text,
  contact_person     text,
  contact_phone      text,
  required_materials text,
  notes              text,
  feasibility        text,                 -- feasible | conditional | not_feasible
  status             text        not null default 'draft'
                       check (status in ('draft','submitted','approved','returned')),
  created_by         uuid        references public.users(id),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  submitted_at       timestamptz,
  reviewed_by        uuid        references public.users(id),
  reviewed_at        timestamptz,
  review_comment     text
);

create index if not exists site_surveys_project_idx on public.site_surveys(project_name);
create index if not exists site_surveys_status_idx  on public.site_surveys(status);
create index if not exists site_surveys_creator_idx on public.site_surveys(created_by);

create table if not exists public.survey_photos (
  id           uuid        primary key default gen_random_uuid(),
  survey_id    uuid        not null references public.site_surveys(id) on delete cascade,
  slot         text        not null,
  storage_path text        not null,
  caption      text,
  created_by   uuid        references public.users(id),
  created_at   timestamptz default now()
);

create index if not exists survey_photos_survey_idx on public.survey_photos(survey_id);

-- ── RLS: site_surveys ────────────────────────────────────────────────────────

alter table public.site_surveys enable row level security;

drop policy if exists "site_surveys_select_own"    on public.site_surveys;
drop policy if exists "site_surveys_select_admin"  on public.site_surveys;
drop policy if exists "site_surveys_insert_own"    on public.site_surveys;
drop policy if exists "site_surveys_insert_admin"  on public.site_surveys;
drop policy if exists "site_surveys_update_own"    on public.site_surveys;
drop policy if exists "site_surveys_update_admin"  on public.site_surveys;
drop policy if exists "site_surveys_delete_own"    on public.site_surveys;
drop policy if exists "site_surveys_delete_admin"  on public.site_surveys;

create policy "site_surveys_select_own" on public.site_surveys
  for select to authenticated
  using (created_by = public.jsr_current_user_id());

create policy "site_surveys_select_admin" on public.site_surveys
  for select to authenticated
  using (public.jsr_is_admin());

create policy "site_surveys_insert_own" on public.site_surveys
  for insert to authenticated
  with check (
    created_by = public.jsr_current_user_id()
    and status in ('draft', 'submitted')
  );

create policy "site_surveys_insert_admin" on public.site_surveys
  for insert to authenticated
  with check (public.jsr_is_admin());

-- Field user: edit own survey only while draft/returned; may only leave it
-- as draft or move it to submitted (never approve / return).
create policy "site_surveys_update_own" on public.site_surveys
  for update to authenticated
  using (
    created_by = public.jsr_current_user_id()
    and status in ('draft', 'returned')
  )
  with check (
    created_by = public.jsr_current_user_id()
    and status in ('draft', 'submitted')
  );

create policy "site_surveys_update_admin" on public.site_surveys
  for update to authenticated
  using (public.jsr_is_admin())
  with check (public.jsr_is_admin());

create policy "site_surveys_delete_own" on public.site_surveys
  for delete to authenticated
  using (
    created_by = public.jsr_current_user_id()
    and status in ('draft', 'returned')
  );

create policy "site_surveys_delete_admin" on public.site_surveys
  for delete to authenticated
  using (public.jsr_is_admin());

-- ── RLS: survey_photos ───────────────────────────────────────────────────────
-- A photo is accessible when its parent survey is (own survey, or admin).
-- Writes by the owner are allowed only while the survey is draft/returned.

alter table public.survey_photos enable row level security;

drop policy if exists "survey_photos_select" on public.survey_photos;
drop policy if exists "survey_photos_insert" on public.survey_photos;
drop policy if exists "survey_photos_update" on public.survey_photos;
drop policy if exists "survey_photos_delete" on public.survey_photos;

create policy "survey_photos_select" on public.survey_photos
  for select to authenticated
  using (
    public.jsr_is_admin()
    or exists (select 1 from public.site_surveys s
               where s.id = survey_id and s.created_by = public.jsr_current_user_id())
  );

create policy "survey_photos_insert" on public.survey_photos
  for insert to authenticated
  with check (
    public.jsr_is_admin()
    or exists (select 1 from public.site_surveys s
               where s.id = survey_id
                 and s.created_by = public.jsr_current_user_id()
                 and s.status in ('draft', 'returned'))
  );

create policy "survey_photos_update" on public.survey_photos
  for update to authenticated
  using (
    public.jsr_is_admin()
    or exists (select 1 from public.site_surveys s
               where s.id = survey_id
                 and s.created_by = public.jsr_current_user_id()
                 and s.status in ('draft', 'returned'))
  )
  with check (
    public.jsr_is_admin()
    or exists (select 1 from public.site_surveys s
               where s.id = survey_id
                 and s.created_by = public.jsr_current_user_id()
                 and s.status in ('draft', 'returned'))
  );

create policy "survey_photos_delete" on public.survey_photos
  for delete to authenticated
  using (
    public.jsr_is_admin()
    or exists (select 1 from public.site_surveys s
               where s.id = survey_id
                 and s.created_by = public.jsr_current_user_id()
                 and s.status in ('draft', 'returned'))
  );

-- ── Storage: private bucket + object policies ────────────────────────────────
-- Object path's first folder = survey id (uuid), so access mirrors the
-- survey's own access rules.

insert into storage.buckets (id, name, public)
values ('site-survey-photos', 'site-survey-photos', false)
on conflict (id) do nothing;

drop policy if exists "survey_photos_obj_select" on storage.objects;
drop policy if exists "survey_photos_obj_insert" on storage.objects;
drop policy if exists "survey_photos_obj_update" on storage.objects;
drop policy if exists "survey_photos_obj_delete" on storage.objects;

create policy "survey_photos_obj_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'site-survey-photos'
    and (
      public.jsr_is_admin()
      or exists (select 1 from public.site_surveys s
                 where s.id::text = (storage.foldername(name))[1]
                   and s.created_by = public.jsr_current_user_id())
    )
  );

create policy "survey_photos_obj_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'site-survey-photos'
    and (
      public.jsr_is_admin()
      or exists (select 1 from public.site_surveys s
                 where s.id::text = (storage.foldername(name))[1]
                   and s.created_by = public.jsr_current_user_id()
                   and s.status in ('draft', 'returned'))
    )
  );

create policy "survey_photos_obj_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'site-survey-photos'
    and (
      public.jsr_is_admin()
      or exists (select 1 from public.site_surveys s
                 where s.id::text = (storage.foldername(name))[1]
                   and s.created_by = public.jsr_current_user_id()
                   and s.status in ('draft', 'returned'))
    )
  );

create policy "survey_photos_obj_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'site-survey-photos'
    and (
      public.jsr_is_admin()
      or exists (select 1 from public.site_surveys s
                 where s.id::text = (storage.foldername(name))[1]
                   and s.created_by = public.jsr_current_user_id()
                   and s.status in ('draft', 'returned'))
    )
  );

-- ── Post-apply verification ──────────────────────────────────────────────────
-- Expected: both tables rowsecurity = true; 8 policies on site_surveys,
-- 4 on survey_photos; bucket exists with public = false; 4 storage policies.
select relname, relrowsecurity from pg_class
where relname in ('site_surveys', 'survey_photos');

select tablename, count(*) as policies from pg_policies
where tablename in ('site_surveys', 'survey_photos')
group by tablename;

select id, public from storage.buckets where id = 'site-survey-photos';

select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like 'survey_photos_obj_%'
order by policyname;
