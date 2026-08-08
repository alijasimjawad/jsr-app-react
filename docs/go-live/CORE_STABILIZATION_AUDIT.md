# JSR Network Tracker — Core Stabilization Audit

**Date:** 2026-08-08  
**Branch:** master (latest: `25d0d96`)  
**Scope:** Read-only diagnosis of the React app against the new JSR Supabase staging project  
**Status:** READ-ONLY — no code or DB changes made during this audit

---

## Summary

| Priority | Count |
|----------|-------|
| P0 — module completely unusable | 1 |
| P1 — core business function broken | 3 |
| P2 — important but non-blocking | 7 |
| P3 — cosmetic | 2 |

**TypeScript:** `npx tsc -b` passes with 0 errors.

**GO/NO-GO: NO-GO** — P0 and P1 items must be resolved before go-live.

---

## P0 — Module Completely Unusable

| # | Module | Problem | Root Cause | Recommended Fix | Code/DB | Risk |
|---|--------|---------|------------|-----------------|---------|------|
| 1 | Finance › Revenue | Revenue page fails on load with PostgREST error (`column revenue.invoice_date does not exist`). The entire module shows an error banner and no data can be loaded, added, or edited. | `09_patch_revenue_missing_columns.sql` was committed (`25d0d96`) but **not yet run** against the staging project. The destination `revenue` table has 7 columns; the app reads/writes 12 (5 missing: `section_name`, `invoice_date`, `status`, `notes`, `added_by`). | Run `docs/phase3-staging-schema/09_patch_revenue_missing_columns.sql` in the staging project's Supabase SQL editor. Verify with `docs/phase3-staging-schema/verify_revenue_patch.sql`. | DB | Low — patch is idempotent, no row data is changed. |

---

## P1 — Core Business Function Broken

| # | Module | Problem | Root Cause | Recommended Fix | Code/DB | Risk |
|---|--------|---------|------------|-----------------|---------|------|
| 2 | Finance › Revenue (modal) | Opening the Add/Edit Revenue modal then selecting a section throws a PostgREST 400: `column rows.is_deleted does not exist`. The site-ID picker never loads; no new revenue entry can be saved correctly. | `FinRevenue.tsx:171`: `supabase.from('rows').select('data').eq('section_id', sec.id).neq('is_deleted', true)`. The `rows` table schema (`02_dependent_tables.sql`) has only `id, section_id, data, row_order, created_at, updated_at` — no `is_deleted`. The filter was borrowed from the `sections` pattern where it is valid. | Remove `.neq('is_deleted', true)` from the `rows` query at `FinRevenue.tsx:171`. Rows are never soft-deleted; the filter is always a no-op semantically and is only harmful to schema parity. | Code | Low — removing the filter returns all rows, which is the correct intent. |
| 3 | Finance › Expense Claims, Daily Activities | Car-trip expense claims cannot be created, updated, or looked up. `DailyActivities.tsx:307–308` filters by `.eq('daily_activity_id', daId).eq('is_car_trip', true)` and inserts `is_car_trip`, `car_id`, `car_trip_distance_km`, `car_trip_rate_iqd`, `daily_activity_id` — all 5 columns are absent from the destination `expense_claims` table. Every car-trip sync call fails with PostgREST 400. `FinExpClaims.tsx` reads these fields as `null` (renders `—`), which is non-crashing but misleading. | The 5 columns (`is_car_trip`, `daily_activity_id`, `car_id`, `car_trip_distance_km`, `car_trip_rate_iqd`) are noted in `docs/phase3-staging-schema/02_dependent_tables.sql` as deliberately excluded: "none of those exist on live JSR today." The React app extended the schema for a new car-trip feature that was never backfilled to the staging project. | Option A (preferred): `ALTER TABLE public.expense_claims ADD COLUMN IF NOT EXISTS` for all 5 columns with appropriate types (boolean, uuid, uuid, numeric, numeric — all nullable). Option B: Disable the car-trip UI path pending a decision. | DB | Medium — requires schema change decision; no existing row data is affected since these columns never existed. |
| 4 | All modules using project names | `projects` table patch (`08_patch_projects_tac_mrc.sql`) has not been run. The table still has `moj` and `general` as active projects, and `tac`/`mrc` are absent. Network Scopes shows MOJ and General tabs (confirmed migrated sections exist for both). Revenue/Invoices/Expense Claims project dropdowns include MOJ and General instead of TAC and MRC. User has explicitly requested retiring MOJ/General and replacing with TAC/MRC (`ad687e9`). | `08_patch_projects_tac_mrc.sql` was committed (`ad687e9`) but not yet run against the staging project. The staging `projects` table was seeded from the pre-`ad687e9` version of `01_extensions_and_core_tables.sql`. | Run `docs/phase3-staging-schema/08_patch_projects_tac_mrc.sql` in the staging project's Supabase SQL editor. Verify with `docs/phase3-staging-schema/verify_projects_patch.sql`. | DB | Low — soft-deactivates moj/general (no hard delete, no data loss); inserts tac/mrc via `ON CONFLICT DO NOTHING`. |

---

## P2 — Important but Non-Blocking

| # | Module | Problem | Root Cause | Recommended Fix | Code/DB | Risk |
|---|--------|---------|------------|-----------------|---------|------|
| 5 | Finance › Invoices | Revenue load in `FinInvoices.tsx:233` orders by `section_name` (a column that doesn't exist until patch 09 is run). Resolves automatically once P0 #1 is fixed — listed separately to prevent confusion if the invoices page fails before patch 09 is run. | Same root cause as P0 #1. | Run patch 09 (fixes P0 #1 and P2 #5 together). | DB | Resolves with P0 fix. |
| 6 | Push Notifications | All in-app push notifications silently fail. `pushNotify.ts:14` calls `fetch('/api/send-push', ...)` — this Vercel serverless function does not exist in the JSR React project. Failures are swallowed (`console.warn` only) so no visible crash occurs, but no user is ever notified of expense claim approvals, revenue updates, etc. | The `/api/send-push` endpoint was not ported from the TAC project to JSR during de-branding (Phase 1). | Port or create `api/send-push.ts` (Vercel edge/serverless function) and configure web-push credentials (VAPID keys) in the Vercel project environment. | Code | Medium — no crash, but a core HR/finance workflow feature is silently dead. |
| 7 | HR › Profiles / My Profile | All 25 migrated `team_members` rows have `username = null` (the source JSR `team_members` table had no `username` column). HrProfiles displays `—` for username. MyProfile HR-link lookup tries username first (no match), falls back to `full_name` match (works). Display-only issue. | Source `team_members` schema had no `username` column per Phase 3 audit. The column was added to the destination schema for new React-only functionality. | Optionally populate `username` values for existing team members via a one-off SQL UPDATE (matching by `full_name` to `users.username`), or accept `—` as the display state for migrated members. | DB (data) | Low — display only, no crash, fallback logic works. |
| 8 | HR › Profile Photo Uploads | Profile photo uploads in `MyProfile.tsx:261` and `HrProfiles.tsx` target `supabase.storage.from('employee-docs')`. This Storage bucket may not exist in the new JSR project. Uploads will fail with a "Bucket not found" error. | The `employee-docs` Storage bucket exists in the old JSR project but must be created fresh in the new staging project's Supabase dashboard. | Create an `employee-docs` public bucket in the new JSR Supabase project under Storage. | DB (infra) | Low — read paths (existing photo URLs) are unaffected; only new uploads break. |
| 9 | Sites DB, Daily Activities | `cars`, `sites`, `field_trips`, `trip_participants` tables are all empty (React-only tables, no migrated data, no seed data). Sites DB shows an empty map. Daily Activities car-trip form has no cars to select. HR Profiles trip history shows no trips. | These tables have no equivalent in the old JSR database and were never populated. | Populate `cars` via the app UI; import `sites` data via the XLSX import in Sites DB. Field trips accumulate naturally once daily activities are used. | DB (data) | Low — modules degrade gracefully to empty state, no crash. |
| 10 | Dashboard | The "Recent Activity" panel on Dashboard is a hardcoded empty state (`<div>No recent activity</div>`). The `activity_log` table is populated correctly by `logActivity()` throughout the app but is never queried on the Dashboard. | The component is a static placeholder — `Dashboard.tsx` `RecentActivity` returns hardcoded content instead of a live Supabase query. | Implement a live `activity_log` query in `Dashboard.tsx` (order by `created_at desc`, limit 10). | Code | Low — cosmetic, data is safe. |
| 11 | All (error display) | 16 catch blocks in HrProfiles.tsx, FinGenExp.tsx, FinProjExp.tsx, and MyProfile.tsx use the old `e instanceof Error ? e.message : String(e)` pattern. Supabase's `PostgrestError` is a plain object, not an `Error` instance, so it falls through to `String(e)` → `"[object Object]"`. The same bug was fixed in `FinRevenue.tsx` (commit `25d0d96`) using the new `errorMessage()` helper in `src/lib/errorMessage.ts`. | Identified in commit `25d0d96` as a known follow-up: "the same instanceof-Error anti-pattern exists in HrProfiles.tsx, FinGenExp.tsx, FinProjExp.tsx, and MyProfile.tsx (16 occurrences total)". | Replace the `instanceof Error` pattern with `errorMessage(e)` from `src/lib/errorMessage.ts` in all 4 files. | Code | Low — affects error display quality only; no data loss or crash. |

---

## P3 — Cosmetic

| # | Module | Problem | Root Cause | Recommended Fix | Code/DB | Risk |
|---|--------|---------|------------|-----------------|---------|------|
| 12 | Branding | Logo images still reference `tac-logo.png` and `tac-logo-light.png` (TAC brand assets). App name and auth domain are correctly updated to JSR (`brand.ts`). | Phase 1 de-branding updated text but did not replace logo image assets. | Create JSR logo PNG assets and update the `logoLight`/`logoDark` paths in `src/config/brand.ts`. | Code + Assets | Low — cosmetic only. |
| 13 | HR › Documents | `EmployeeDocument.created_at` (`HrProfiles.tsx:36`) is typed as `string | null` but the destination `employee_documents` table has `uploaded_at` instead of `created_at`. Any document list column showing "Date Added" or similar will render as `—` for all migrated documents. | Source schema used `uploaded_at`; the React interface added a parallel `created_at` field that was never added to the DB. | Either rename the DB column to `created_at` (ALTER TABLE), or update the interface to use `uploaded_at`. | DB or Code | Low — display only. |

---

## Recommended Fix Order

**Before first login test:**
1. **DB — Run `09_patch_revenue_missing_columns.sql`** (resolves P0 #1 and P2 #5)
2. **DB — Run `08_patch_projects_tac_mrc.sql`** (resolves P1 #4)

**Before core workflow test:**
3. **Code — Remove `.neq('is_deleted', true)` from `rows` query in `FinRevenue.tsx:171`** (resolves P1 #2)
4. **DB — Add 5 missing columns to `expense_claims`** (resolves P1 #3)

**Before go-live:**
5. **Infra — Create `employee-docs` Storage bucket** (resolves P2 #8)
6. **Code — Replace `instanceof Error` pattern in 4 files** (resolves P2 #11)
7. **Code/Infra — Port `/api/send-push` endpoint** (resolves P2 #6)

**Post-launch (can defer):**
8. DB — Populate `team_members.username` (P2 #7)
9. DB — Add `cars`/`sites` seed data (P2 #9)
10. Code — Implement live RecentActivity query on Dashboard (P2 #10)
11. Code — Fix `employee_documents.created_at` (P3 #13)
12. Assets — Create JSR logo assets (P3 #12)

---

## Notes

- `npx tsc -b` passes cleanly — no TypeScript errors anywhere in the codebase.
- Authentication (Supabase Auth + `public.users` `auth_user_id` bridge) was not audited for live DB connectivity — requires a login test with a real migrated user account.
- RLS has **not** been enabled (`06_enable_rls_no_policies.sql` was intentionally not run). All data is accessible to the anon key without policies. This is a go-live blocker for production; not a blocker for internal staging use.
- FinReport.tsx and FinDashboard.tsx both select only the revenue columns that exist in the original schema — they are safe regardless of whether patch 09 has been run.
- The `activity_log` write path (`src/lib/activityLog.ts`) is correct and safe for all columns it writes (`user_full_name, action, project_name, section_name, details`).
