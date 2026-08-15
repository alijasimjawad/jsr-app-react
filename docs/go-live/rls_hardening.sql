-- ============================================================================
-- JSR Network Tracker — RLS Hardening Migration
-- Project ref: qaqxoakjnyivuegsopha
-- Date: 2026-08-16
-- Idempotent: all statements use CREATE OR REPLACE / DROP POLICY IF EXISTS
-- Apply via Supabase Management API or dashboard SQL editor.
-- DO NOT run against old production (tltbkjvrhqsxdspdfeqk).
-- ============================================================================


-- ============================================================================
-- PART A: SECURITY DEFINER Helper Functions
-- All functions live in the `auth` schema so they can call auth.uid() without
-- needing SET search_path. Each one queries public.users / public.team_members
-- using a fixed, safe search_path to prevent search_path injection.
-- SECURITY DEFINER means the function runs with its owner's privileges and
-- bypasses RLS on the tables it reads — this prevents recursive RLS loops.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.jsr_current_role()
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT role FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.jsr_is_admin()
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.users
    WHERE auth_user_id = auth.uid() AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION public.jsr_current_user_id()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT id FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.jsr_current_user_full_name()
  RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT full_name FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.jsr_current_permissions()
  RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT permissions FROM public.users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- Resolves the team_members.id for the current session's user.
-- Joins users → team_members via full_name (confirmed unique; no duplicates).
-- Returns NULL if the user has no linked team_member row (e.g. admin-only accounts).
CREATE OR REPLACE FUNCTION public.jsr_current_team_member_id()
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, auth
AS $$
  SELECT tm.id
  FROM public.team_members tm
  JOIN public.users u ON u.full_name = tm.full_name
  WHERE u.auth_user_id = auth.uid()
  LIMIT 1;
$$;


-- ============================================================================
-- PART B: Enable RLS on all tables
-- push_subscriptions already has RLS — listed here for completeness.
-- ============================================================================

ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_claims     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rows               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revenue            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_activities   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_trips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cars               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_points       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.general_expenses   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_expenses   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites              ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- PART C: Drop all existing policies (idempotent cleanup)
-- ============================================================================

-- users
DROP POLICY IF EXISTS "users_select_own"       ON public.users;
DROP POLICY IF EXISTS "users_select_admin"     ON public.users;
DROP POLICY IF EXISTS "users_insert_admin"     ON public.users;
DROP POLICY IF EXISTS "users_update_own"       ON public.users;
DROP POLICY IF EXISTS "users_update_admin"     ON public.users;
DROP POLICY IF EXISTS "users_delete_admin"     ON public.users;

-- team_members
DROP POLICY IF EXISTS "team_members_select_authenticated" ON public.team_members;
DROP POLICY IF EXISTS "team_members_insert_admin"         ON public.team_members;
DROP POLICY IF EXISTS "team_members_update_admin"         ON public.team_members;
DROP POLICY IF EXISTS "team_members_delete_admin"         ON public.team_members;

-- expense_claims
DROP POLICY IF EXISTS "expense_claims_select_own"         ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_select_admin"       ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_insert_own"         ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_insert_admin"       ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_update_own_pending" ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_update_admin"       ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_delete_own_pending" ON public.expense_claims;
DROP POLICY IF EXISTS "expense_claims_delete_admin"       ON public.expense_claims;

-- sections
DROP POLICY IF EXISTS "sections_select_authenticated" ON public.sections;
DROP POLICY IF EXISTS "sections_insert_admin"         ON public.sections;
DROP POLICY IF EXISTS "sections_update_admin"         ON public.sections;
DROP POLICY IF EXISTS "sections_delete_admin"         ON public.sections;

-- rows
DROP POLICY IF EXISTS "rows_select_authenticated" ON public.rows;
DROP POLICY IF EXISTS "rows_insert_admin"         ON public.rows;
DROP POLICY IF EXISTS "rows_update_admin"         ON public.rows;
DROP POLICY IF EXISTS "rows_delete_admin"         ON public.rows;

-- revenue
DROP POLICY IF EXISTS "revenue_select_admin" ON public.revenue;
DROP POLICY IF EXISTS "revenue_insert_admin" ON public.revenue;
DROP POLICY IF EXISTS "revenue_update_admin" ON public.revenue;
DROP POLICY IF EXISTS "revenue_delete_admin" ON public.revenue;

-- daily_activities
DROP POLICY IF EXISTS "daily_activities_select_authenticated"  ON public.daily_activities;
DROP POLICY IF EXISTS "daily_activities_insert_authenticated"  ON public.daily_activities;
DROP POLICY IF EXISTS "daily_activities_update_authenticated"  ON public.daily_activities;
DROP POLICY IF EXISTS "daily_activities_delete_admin"          ON public.daily_activities;

-- field_trips
DROP POLICY IF EXISTS "field_trips_select_authenticated" ON public.field_trips;
DROP POLICY IF EXISTS "field_trips_insert_authenticated" ON public.field_trips;
DROP POLICY IF EXISTS "field_trips_update_authenticated" ON public.field_trips;
DROP POLICY IF EXISTS "field_trips_delete_admin"         ON public.field_trips;

-- trip_participants
DROP POLICY IF EXISTS "trip_participants_select_authenticated" ON public.trip_participants;
DROP POLICY IF EXISTS "trip_participants_insert_authenticated" ON public.trip_participants;
DROP POLICY IF EXISTS "trip_participants_update_own"           ON public.trip_participants;
DROP POLICY IF EXISTS "trip_participants_delete_admin"         ON public.trip_participants;

-- cars
DROP POLICY IF EXISTS "cars_select_authenticated" ON public.cars;
DROP POLICY IF EXISTS "cars_insert_admin"         ON public.cars;
DROP POLICY IF EXISTS "cars_update_admin"         ON public.cars;
DROP POLICY IF EXISTS "cars_delete_admin"         ON public.cars;

-- attendance
DROP POLICY IF EXISTS "attendance_select_own"   ON public.attendance;
DROP POLICY IF EXISTS "attendance_select_admin" ON public.attendance;
DROP POLICY IF EXISTS "attendance_insert_own"   ON public.attendance;
DROP POLICY IF EXISTS "attendance_insert_admin" ON public.attendance;
DROP POLICY IF EXISTS "attendance_update_own"   ON public.attendance;
DROP POLICY IF EXISTS "attendance_update_admin" ON public.attendance;

-- activity_log
DROP POLICY IF EXISTS "activity_log_insert_authenticated" ON public.activity_log;
DROP POLICY IF EXISTS "activity_log_select_admin"         ON public.activity_log;
DROP POLICY IF EXISTS "activity_log_delete_admin"         ON public.activity_log;

-- app_settings
DROP POLICY IF EXISTS "app_settings_select_authenticated" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_insert_admin"         ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_update_admin"         ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_delete_admin"         ON public.app_settings;

-- saved_points
DROP POLICY IF EXISTS "saved_points_select_authenticated" ON public.saved_points;
DROP POLICY IF EXISTS "saved_points_insert_admin"         ON public.saved_points;
DROP POLICY IF EXISTS "saved_points_update_admin"         ON public.saved_points;
DROP POLICY IF EXISTS "saved_points_delete_admin"         ON public.saved_points;

-- employee_documents
DROP POLICY IF EXISTS "employee_documents_select_admin" ON public.employee_documents;
DROP POLICY IF EXISTS "employee_documents_insert_admin" ON public.employee_documents;
DROP POLICY IF EXISTS "employee_documents_update_admin" ON public.employee_documents;
DROP POLICY IF EXISTS "employee_documents_delete_admin" ON public.employee_documents;

-- general_expenses
DROP POLICY IF EXISTS "general_expenses_select_admin" ON public.general_expenses;
DROP POLICY IF EXISTS "general_expenses_insert_admin" ON public.general_expenses;
DROP POLICY IF EXISTS "general_expenses_update_admin" ON public.general_expenses;
DROP POLICY IF EXISTS "general_expenses_delete_admin" ON public.general_expenses;

-- project_expenses
DROP POLICY IF EXISTS "project_expenses_select_admin" ON public.project_expenses;
DROP POLICY IF EXISTS "project_expenses_insert_admin" ON public.project_expenses;
DROP POLICY IF EXISTS "project_expenses_update_admin" ON public.project_expenses;
DROP POLICY IF EXISTS "project_expenses_delete_admin" ON public.project_expenses;

-- clients
DROP POLICY IF EXISTS "clients_select_admin" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_admin" ON public.clients;
DROP POLICY IF EXISTS "clients_update_admin" ON public.clients;
DROP POLICY IF EXISTS "clients_delete_admin" ON public.clients;

-- invoices
DROP POLICY IF EXISTS "invoices_select_admin" ON public.invoices;
DROP POLICY IF EXISTS "invoices_insert_admin" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update_admin" ON public.invoices;
DROP POLICY IF EXISTS "invoices_delete_admin" ON public.invoices;

-- invoice_items
DROP POLICY IF EXISTS "invoice_items_select_admin" ON public.invoice_items;
DROP POLICY IF EXISTS "invoice_items_insert_admin" ON public.invoice_items;
DROP POLICY IF EXISTS "invoice_items_update_admin" ON public.invoice_items;
DROP POLICY IF EXISTS "invoice_items_delete_admin" ON public.invoice_items;

-- invoice_payments
DROP POLICY IF EXISTS "invoice_payments_select_admin" ON public.invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_insert_admin" ON public.invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_update_admin" ON public.invoice_payments;
DROP POLICY IF EXISTS "invoice_payments_delete_admin" ON public.invoice_payments;

-- salary_adjustments
DROP POLICY IF EXISTS "salary_adjustments_select_admin" ON public.salary_adjustments;
DROP POLICY IF EXISTS "salary_adjustments_insert_admin" ON public.salary_adjustments;
DROP POLICY IF EXISTS "salary_adjustments_update_admin" ON public.salary_adjustments;
DROP POLICY IF EXISTS "salary_adjustments_delete_admin" ON public.salary_adjustments;

-- projects
DROP POLICY IF EXISTS "projects_select_authenticated" ON public.projects;
DROP POLICY IF EXISTS "projects_insert_admin"         ON public.projects;
DROP POLICY IF EXISTS "projects_update_admin"         ON public.projects;
DROP POLICY IF EXISTS "projects_delete_admin"         ON public.projects;

-- sites
DROP POLICY IF EXISTS "sites_select_authenticated" ON public.sites;
DROP POLICY IF EXISTS "sites_insert_admin"         ON public.sites;
DROP POLICY IF EXISTS "sites_update_admin"         ON public.sites;
DROP POLICY IF EXISTS "sites_delete_admin"         ON public.sites;


-- ============================================================================
-- PART D: Create Policies
-- Design tiers:
--   Tier 1 — Finance / sensitive:  admin-only all ops
--   Tier 2 — Ownership-based:      field roles own records, admin all
--   Tier 3 — Authenticated read, admin write
--   Tier 4 — Authenticated write (lower-risk operational tables)
-- ============================================================================


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: users
-- Critical bootstrap: AuthContext.tsx reads own row on every session start.
-- Non-admin users update only their own safe profile fields.
-- WITH CHECK prevents role or permissions self-escalation via direct API call.
-- ──────────────────────────────────────────────────────────────────────────────

-- SELECT: own row (AuthContext session bootstrap) OR admin (UserManagement list)
CREATE POLICY "users_select_own" ON public.users
  FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "users_select_admin" ON public.users
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

-- INSERT: admin only — user creation goes through admin-user-ops Edge Function
CREATE POLICY "users_insert_admin" ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

-- UPDATE non-admin: own row; cannot change role or permissions via direct API
CREATE POLICY "users_update_own" ON public.users
  FOR UPDATE TO authenticated
  USING (
    auth_user_id = auth.uid()
    AND NOT public.jsr_is_admin()
  )
  WITH CHECK (
    auth_user_id = auth.uid()
    AND role = public.jsr_current_role()
    AND (permissions IS NOT DISTINCT FROM public.jsr_current_permissions())
  );

-- UPDATE admin: any row, any values (UserManagement page)
CREATE POLICY "users_update_admin" ON public.users
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

-- DELETE: admin only — deletion goes through admin-user-ops Edge Function
CREATE POLICY "users_delete_admin" ON public.users
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: team_members
-- Read by every role (member resolution for DA, attendance, expenses, trips).
-- Writes are admin-only: FinTeam.tsx and HrProfiles.tsx are admin pages.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "team_members_select_authenticated" ON public.team_members
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "team_members_insert_admin" ON public.team_members
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "team_members_update_admin" ON public.team_members
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "team_members_delete_admin" ON public.team_members
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: expense_claims
-- Ownership key is member_id (team_members.id), resolved via current_team_member_id().
-- Anti-fraud rules enforced at DB layer:
--   • Non-admin can only see/edit/delete their OWN claims.
--   • Non-admin can only edit claims in 'pending' status.
--   • WITH CHECK status='pending' blocks a field user from self-approving via API.
--   • Only admin can set status='approved' or 'rejected'.
-- ──────────────────────────────────────────────────────────────────────────────

-- SELECT own (NotificationBell, MyExpenses, MyWork) OR admin (FinExpClaims)
CREATE POLICY "expense_claims_select_own" ON public.expense_claims
  FOR SELECT TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    AND NOT public.jsr_is_admin()
  );

CREATE POLICY "expense_claims_select_admin" ON public.expense_claims
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

-- INSERT: field role inserts own pending claims (MyExpenses, DailyActivities car trip)
CREATE POLICY "expense_claims_insert_own" ON public.expense_claims
  FOR INSERT TO authenticated
  WITH CHECK (
    member_id = public.jsr_current_team_member_id()
    AND (status IS NULL OR status = 'pending')
    AND NOT public.jsr_is_admin()
  );

CREATE POLICY "expense_claims_insert_admin" ON public.expense_claims
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

-- UPDATE: field role — own pending only; WITH CHECK keeps status='pending' (blocks self-approve)
CREATE POLICY "expense_claims_update_own_pending" ON public.expense_claims
  FOR UPDATE TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    AND status = 'pending'
    AND NOT public.jsr_is_admin()
  )
  WITH CHECK (
    member_id = public.jsr_current_team_member_id()
    AND status = 'pending'
  );

-- UPDATE: admin — any claim, any status (approve / reject / edit)
CREATE POLICY "expense_claims_update_admin" ON public.expense_claims
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

-- DELETE: field role — own pending only; admin — any
CREATE POLICY "expense_claims_delete_own_pending" ON public.expense_claims
  FOR DELETE TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    AND status = 'pending'
    AND NOT public.jsr_is_admin()
  );

CREATE POLICY "expense_claims_delete_admin" ON public.expense_claims
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: sections
-- Read by every role (dashboard, DA, MyExpenses, FinRevenue, SiteLookup, etc.).
-- Writes are admin-only. Sidebar.tsx section-init INSERT is fire-and-forget
-- with no error check — silently a no-op for non-admin (sections already seeded).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "sections_select_authenticated" ON public.sections
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "sections_insert_admin" ON public.sections
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "sections_update_admin" ON public.sections
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "sections_delete_admin" ON public.sections
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: rows
-- Read by every role (Dashboard stats, NetworkScopes, FinRevenue, DailyActivities).
-- Writes are admin-only: all sdb_add_rows / sdb_edit_rows / sdb_delete_rows
-- operations are admin-level permissions in the app.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "rows_select_authenticated" ON public.rows
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "rows_insert_admin" ON public.rows
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "rows_update_admin" ON public.rows
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "rows_delete_admin" ON public.rows
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: revenue  [Tier 1 — Finance, admin only]
-- Includes invoice amounts and financial status. Admin-only at DB layer.
-- Note: NetworkScopes.tsx creates revenue placeholders on site add/delete, but
-- that code path is gated by sdb_add_rows which is an admin permission.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "revenue_select_admin" ON public.revenue
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "revenue_insert_admin" ON public.revenue
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "revenue_update_admin" ON public.revenue
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "revenue_delete_admin" ON public.revenue
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: daily_activities
-- All authenticated can SELECT (MyWork, MySites personal pages; SiteLookup).
-- INSERT/UPDATE: all authenticated — field roles create/edit their own DAs;
--   app layer enforces da_add_rows / da_edit_rows permission gates.
-- DELETE: admin only — da_delete_rows is an elevated operation.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "daily_activities_select_authenticated" ON public.daily_activities
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "daily_activities_insert_authenticated" ON public.daily_activities
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "daily_activities_update_authenticated" ON public.daily_activities
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "daily_activities_delete_admin" ON public.daily_activities
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: field_trips
-- All authenticated can SELECT (MyTrips, LiveTrips, SiteLookup, MyWork).
-- INSERT/UPDATE: all authenticated — trip lifecycle is managed by participants;
--   TripDetailModal.tsx allows any participant to start/depart/complete.
-- DELETE: admin only (cascades from da_delete_rows which is admin-only).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "field_trips_select_authenticated" ON public.field_trips
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "field_trips_insert_authenticated" ON public.field_trips
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "field_trips_update_authenticated" ON public.field_trips
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "field_trips_delete_admin" ON public.field_trips
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: trip_participants
-- All authenticated can SELECT (TripDetailModal, MyTrips, MyWork, HrProfiles).
-- INSERT: all authenticated (DailyActivities creates participants).
-- UPDATE: own participant record (GPS pings, join status) OR admin.
-- DELETE: admin only (cascades from DA/trip delete).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "trip_participants_select_authenticated" ON public.trip_participants
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "trip_participants_insert_authenticated" ON public.trip_participants
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "trip_participants_update_own" ON public.trip_participants
  FOR UPDATE TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    OR public.jsr_is_admin()
  )
  WITH CHECK (
    member_id = public.jsr_current_team_member_id()
    OR public.jsr_is_admin()
  );

CREATE POLICY "trip_participants_delete_admin" ON public.trip_participants
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: cars
-- SELECT: all authenticated (carsCache loaded on demand for car trip forms).
-- Writes: admin only (FinCars.tsx is admin-gated via view_fin_cars).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "cars_select_authenticated" ON public.cars
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "cars_insert_admin" ON public.cars
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "cars_update_admin" ON public.cars
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "cars_delete_admin" ON public.cars
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: attendance
-- Ownership key: member_id (team_members.id).
-- Field roles: see/clock own records only.
-- Admin: AttendanceAdmin.tsx full roster access.
-- MyAttendance.tsx uses upsert (INSERT + UPDATE) — both policies cover it.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "attendance_select_own" ON public.attendance
  FOR SELECT TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    AND NOT public.jsr_is_admin()
  );

CREATE POLICY "attendance_select_admin" ON public.attendance
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

-- INSERT: own member_id (clock-in upsert)
CREATE POLICY "attendance_insert_own" ON public.attendance
  FOR INSERT TO authenticated
  WITH CHECK (
    member_id = public.jsr_current_team_member_id()
    AND NOT public.jsr_is_admin()
  );

CREATE POLICY "attendance_insert_admin" ON public.attendance
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

-- UPDATE: own record (clock-out) OR admin (AttendanceAdmin edits)
CREATE POLICY "attendance_update_own" ON public.attendance
  FOR UPDATE TO authenticated
  USING (
    member_id = public.jsr_current_team_member_id()
    AND NOT public.jsr_is_admin()
  )
  WITH CHECK (member_id = public.jsr_current_team_member_id());

CREATE POLICY "attendance_update_admin" ON public.attendance
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: activity_log
-- INSERT: all authenticated (lib/activityLog.ts fires after every mutation).
-- SELECT: admin only (NotificationBell admin feed, ActivityLog page).
-- DELETE: admin only (activity_log_clear feature).
-- No UPDATE ever — audit records must not be modified.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "activity_log_insert_authenticated" ON public.activity_log
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "activity_log_select_admin" ON public.activity_log
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "activity_log_delete_admin" ON public.activity_log
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: app_settings
-- SELECT: all authenticated (carSettingsCache loaded for trip cost calculations).
-- Writes: admin only (car km rate set in FinCars.tsx via view_fin_cars).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "app_settings_select_authenticated" ON public.app_settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "app_settings_insert_admin" ON public.app_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "app_settings_update_admin" ON public.app_settings
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "app_settings_delete_admin" ON public.app_settings
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: saved_points
-- SELECT: all authenticated (savedPointsCache for trip route planning).
-- Writes: admin only (FinCars.tsx manages saved points via view_fin_cars).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "saved_points_select_authenticated" ON public.saved_points
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "saved_points_insert_admin" ON public.saved_points
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "saved_points_update_admin" ON public.saved_points
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "saved_points_delete_admin" ON public.saved_points
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: employee_documents  [Tier 1 — HR sensitive, admin only]
-- All operations via HrProfiles.tsx which is admin-gated (view_hr_profiles).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "employee_documents_select_admin" ON public.employee_documents
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "employee_documents_insert_admin" ON public.employee_documents
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "employee_documents_update_admin" ON public.employee_documents
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "employee_documents_delete_admin" ON public.employee_documents
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: general_expenses  [Tier 1 — Finance, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "general_expenses_select_admin" ON public.general_expenses
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "general_expenses_insert_admin" ON public.general_expenses
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "general_expenses_update_admin" ON public.general_expenses
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "general_expenses_delete_admin" ON public.general_expenses
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: project_expenses  [Tier 1 — Finance, admin only]
-- Also auto-created by FinExpClaims.tsx on claim approval (admin action).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "project_expenses_select_admin" ON public.project_expenses
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "project_expenses_insert_admin" ON public.project_expenses
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "project_expenses_update_admin" ON public.project_expenses
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "project_expenses_delete_admin" ON public.project_expenses
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: clients  [Tier 1 — Finance, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "clients_select_admin" ON public.clients
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "clients_insert_admin" ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "clients_update_admin" ON public.clients
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "clients_delete_admin" ON public.clients
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: invoices  [Tier 1 — Finance, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "invoices_select_admin" ON public.invoices
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "invoices_insert_admin" ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoices_update_admin" ON public.invoices
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoices_delete_admin" ON public.invoices
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: invoice_items  [Tier 1 — Finance, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "invoice_items_select_admin" ON public.invoice_items
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "invoice_items_insert_admin" ON public.invoice_items
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoice_items_update_admin" ON public.invoice_items
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoice_items_delete_admin" ON public.invoice_items
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: invoice_payments  [Tier 1 — Finance, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "invoice_payments_select_admin" ON public.invoice_payments
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "invoice_payments_insert_admin" ON public.invoice_payments
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoice_payments_update_admin" ON public.invoice_payments
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "invoice_payments_delete_admin" ON public.invoice_payments
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: salary_adjustments  [Tier 1 — Finance / HR sensitive, admin only]
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "salary_adjustments_select_admin" ON public.salary_adjustments
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "salary_adjustments_insert_admin" ON public.salary_adjustments
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "salary_adjustments_update_admin" ON public.salary_adjustments
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "salary_adjustments_delete_admin" ON public.salary_adjustments
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: projects
-- SELECT: all authenticated (projectsCache loaded on login for all pages).
-- Writes: admin only.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "projects_select_authenticated" ON public.projects
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "projects_insert_admin" ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "projects_update_admin" ON public.projects
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "projects_delete_admin" ON public.projects
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ──────────────────────────────────────────────────────────────────────────────
-- TABLE: sites
-- SELECT: all authenticated (sitesCache loaded on login; TripDetailModal map routing).
-- Writes: admin only (SitesDB.tsx, gated by sitesdb_* permissions).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE POLICY "sites_select_authenticated" ON public.sites
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "sites_insert_admin" ON public.sites
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "sites_update_admin" ON public.sites
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "sites_delete_admin" ON public.sites
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ============================================================================
-- PART E: Anon access verification note
-- All policies above are scoped to TO authenticated.
-- The anon role receives no policies → zero effective access on all tables.
-- push_subscriptions already has its own RLS (applied in prior migration).
-- ============================================================================


-- ============================================================================
-- PART F: Verification queries
-- Run these after applying to confirm the state is correct.
-- ============================================================================

-- 1. Confirm RLS is enabled on all target tables:
-- SELECT tablename, rowsecurity
--   FROM pg_tables
--  WHERE schemaname = 'public'
--  ORDER BY tablename;

-- 2. List all policies created:
-- SELECT tablename, policyname, roles, cmd, qual, with_check
--   FROM pg_policies
--  WHERE schemaname = 'public'
--  ORDER BY tablename, policyname;

-- 3. Verify anon gets zero rows (run as anon role):
-- SET ROLE anon;
-- SELECT count(*) FROM public.users;          -- expect 0
-- SELECT count(*) FROM public.revenue;        -- expect 0
-- SELECT count(*) FROM public.expense_claims; -- expect 0
-- RESET ROLE;

-- 4. Verify helper functions exist:
-- SELECT routine_name FROM information_schema.routines
--  WHERE routine_schema = 'auth'
--    AND routine_name IN ('is_admin','current_user_role','current_team_member_id',
--                         'current_user_id','current_user_full_name','current_user_permissions');
