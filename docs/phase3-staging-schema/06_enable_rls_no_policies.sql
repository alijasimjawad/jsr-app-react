-- ============================================================================
-- Phase 3 Step 2 — 06: Enable RLS only, zero policies (NOT part of the
-- 01-05 baseline run order — see warning below)
-- ============================================================================
-- TARGET: the NEW staging project ("JSR Network Tracker React") ONLY.
-- Do NOT run against tltbkjvrhqsxdspdfeqk (live JSR) or gauejhgitzcqjvzalshf
-- (TAC).
--
-- ██ DO NOT RUN THIS FILE YET ██
--
-- This file flips row-level security ON for all 24 tables created by
-- 01-03, and creates ZERO policies. No permissive/mirroring policies are
-- included anywhere in this package — that was explicitly declined.
--
-- Enabling RLS with no policies attached means EVERY table becomes
-- completely inaccessible via the Supabase API (PostgREST) — not just
-- writes, reads too — for both the anon and authenticated roles. Postgres's
-- RLS default, once enabled, is deny-all until a policy explicitly grants
-- access. Running this file before Auth migration + policy work (Phase 3
-- Step 3, still ahead) will break the app against this staging project
-- entirely: every list, form, and dashboard that currently reads or writes
-- through Supabase will start failing.
--
-- Only run this file once you have policies ready to apply immediately
-- after it (ideally in the same session), or you're intentionally testing
-- what a fully-locked-down state looks like and are prepared for the app
-- to stop working against staging until policies land.
--
-- This file exists now so it's ready when that work is approved — it is
-- NOT part of the execution order in STAGING_EXECUTION_CHECKLIST.md's
-- section 3, and is not implied to run alongside 01-05.
-- ============================================================================

alter table public.users                 enable row level security;
alter table public.team_members          enable row level security;
alter table public.clients               enable row level security;
alter table public.activity_log          enable row level security;
alter table public.general_expenses      enable row level security;
alter table public.daily_activities      enable row level security;
alter table public.sections              enable row level security;
alter table public.revenue               enable row level security;
alter table public.sites                 enable row level security;
alter table public.app_settings          enable row level security;
alter table public.projects              enable row level security;
alter table public.saved_points          enable row level security;
alter table public.employee_documents    enable row level security;
alter table public.expense_claims        enable row level security;
alter table public.salary_adjustments    enable row level security;
alter table public.push_subscriptions    enable row level security;
alter table public.invoices              enable row level security;
alter table public.rows                  enable row level security;
alter table public.invoice_items         enable row level security;
alter table public.invoice_payments      enable row level security;
alter table public.cars                  enable row level security;
alter table public.field_trips           enable row level security;
alter table public.trip_participants     enable row level security;
alter table public.attendance            enable row level security;

-- No `create policy` statements below this line, by design. Zero policies
-- ship in this file — adding any would be inventing an access-control
-- decision unasked, which was explicitly declined for this package.
