# JSR Network Tracker — Full CRUD / Functional QA Checklist

**Phase:** Go-Live QA  
**Env:** NEW JSR staging project (`qaqxoakjnyivuegsopha`)  
**RLS:** Not yet enabled — all rows visible to anon key during this phase  
**Date created:** 2026-08-08

**How to use this file:**  
Work through each section in the order listed under [Recommended Execution Order](#recommended-execution-order). Fill in PASS / FAIL and any notes after each test. The verification script `scripts/verify-qa-writes.ts` can be run after completing a module to confirm writes actually persisted in Supabase.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| **CRITICAL** | Must PASS before go-live |
| **IMPORTANT** | Should PASS before go-live; minor workaround acceptable |
| **POST-LIVE** | Can be deferred; does not block launch |
| R | SELECT / read |
| I | INSERT |
| U | UPDATE |
| D | DELETE |

---

## 1. Authentication

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 1.1 | Login | Enter valid `username` + `password` for a migrated user | Login succeeds; redirected to Dashboard or role default page | `auth.users`, `public.users` | R | **CRITICAL** | | |
| 1.2 | Login | Enter invalid password | Error message displayed; not logged in | — | R | **CRITICAL** | | |
| 1.3 | Login | Enter a username with no matching `auth_user_id` in `public.users` | Clear error: "Login succeeded but user profile not found" (not a silent crash) | — | R | **CRITICAL** | | |
| 1.4 | Session | Refresh the browser tab while logged in | Session persists; user remains logged in | `auth.users` | R | **CRITICAL** | | |
| 1.5 | Logout | Click logout | Redirected to Login page; protected routes inaccessible | — | R | **CRITICAL** | | |
| 1.6 | Role redirect | Log in as `engineer` or `technician` role | Redirected to `/my-work` instead of `/attendance` | `public.users` | R | IMPORTANT | | |
| 1.7 | Permission guard | Log in as `engineer`; attempt to navigate to `/user-management` | Access denied (redirect or permission error) | — | R | IMPORTANT | | |
| 1.8 | Password change | My Profile → Change Password → enter current + new password | Password updated; can log in with new password | `auth.users` | U | IMPORTANT | |

---

## 2. Network Scopes / Projects

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 2.1 | Network Scopes | Load the page | Project tabs shown: Zain, Nokia, Huawei, IPT, TAC, MRC (in sort order); MOJ/General absent | `projects`, `sections` | R | **CRITICAL** | | Patch 08 verified |
| 2.2 | Network Scopes | Select a project tab (e.g. Zain) | Sections listed (ftk, tdd, addsector); migrated rows present | `sections`, `rows` | R | **CRITICAL** | | |
| 2.3 | Network Scopes | Add a new section to an existing project | Section appears in list; `section_name`, `section_label`, `project_name`, `columns`, `is_deleted`, `is_custom` all set | `sections` | I | **CRITICAL** | | |
| 2.4 | Network Scopes | Edit a section's label or columns | Updated values appear immediately; correct row updated | `sections` | U | **CRITICAL** | | |
| 2.5 | Network Scopes | Soft-delete (retire) a section | Section no longer appears in active list; `is_deleted = true` in DB | `sections` | U | **CRITICAL** | | |
| 2.6 | Network Scopes | Add a row to a section | Row appears in section table; `data`, `row_order`, `section_id` set correctly | `rows` | I | **CRITICAL** | | |
| 2.7 | Network Scopes | Edit a row's cell value | Change persists on reload; `rows.data` JSONB updated | `rows` | U | **CRITICAL** | | |
| 2.8 | Network Scopes | Delete a row | Row removed; `rows` count decreases | `rows` | D | **CRITICAL** | | |
| 2.9 | Network Scopes | Reorder rows (drag or reorder action) | New order persists; `row_order` values updated | `rows` | U | IMPORTANT | | |
| 2.10 | Network Scopes | Import rows via Excel/CSV upload | Rows inserted for correct section; schema unchanged | `rows` | I | IMPORTANT | **PASS** | Fixed 2026-08-15: title-row detection in `handleImportFile` (skips JSR brand title row); schema protection in `doImportWith` (headers must match section columns exactly, no `sections.columns` update); safe INSERT-first-then-DELETE pattern (no data loss on partial failure); always-show preview dialog. 23/23 unit parse tests pass, 40/40 round-trip QA tests pass. QA section `3813b019` restored. |
| 2.11 | Network Scopes | Export section to Excel | XLSX downloaded; contains correct column headers and all rows | `rows` | R | IMPORTANT | | |

---

## 3. Sites DB

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 3.1 | Sites DB | Load page for Zain or Asia Cell | Table and map render (empty is acceptable — no migrated sites data) | `sites` | R | **CRITICAL** | | `sites` starts empty |
| 3.2 | Sites DB | Add a single site manually | Site appears in table and map marker added | `sites` | I | **CRITICAL** | | |
| 3.3 | Sites DB | Edit a site's field (e.g. governorate) | Updated value persists | `sites` | U | IMPORTANT | | |
| 3.4 | Sites DB | Delete a site | Site removed from table and map | `sites` | D | IMPORTANT | | |
| 3.5 | Sites DB | Import via XLSX (use sample file) | Sites inserted; numeric `site_code` preserved as string (not corrupted by Excel number format) | `sites` | I | **CRITICAL** | | Fix already in `86e9907` |
| 3.6 | Sites DB | Export to XLSX | Download contains all current sites with correct columns | `sites` | R | IMPORTANT | | |
| 3.7 | Sites DB | Enrich existing sites from XLSX (update mode) | Only enrichable columns overwritten on matching `site_code`; no duplicate rows | `sites` | U | IMPORTANT | | |
| 3.8 | Sites DB | Map: click a marker | Popup shows correct site info | `sites` | R | POST-LIVE | | |
| 3.9 | Route Planner | Load Route Planner | Map loads; site search functional | `sites` | R | POST-LIVE | | |
| 3.10 | Site Lookup | Search by site code | Correct site returned | `sites` | R | POST-LIVE | | |

---

## 4. Revenue

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 4.1 | Finance › Revenue | Load page | Migrated revenue rows displayed; no error banner; table shows `section_name`, `site_id`, `amount`, `status` | `revenue`, `sections` | R | **CRITICAL** | | Patch 09 verified |
| 4.2 | Finance › Revenue | Filter by project | Only rows for selected project shown | `revenue` | R | **CRITICAL** | | |
| 4.3 | Finance › Revenue | Filter by month + year | Rows filtered correctly | `revenue` | R | **CRITICAL** | | |
| 4.4 | Finance › Revenue | Add new revenue entry → select project → select section | Section list loads; site-ID picker populates (no `rows.is_deleted` 400 error) | `revenue`, `sections`, `rows` | R | **CRITICAL** | | P1-A fix verified |
| 4.5 | Finance › Revenue | Save new revenue entry | Row appears in table; `project_name`, `section_name`, `site_id`, `amount`, `invoice_date`, `status`, `added_by` all set | `revenue` | I | **CRITICAL** | | |
| 4.6 | Finance › Revenue | Edit an existing revenue row | Changes persist; correct row updated | `revenue` | U | **CRITICAL** | | |
| 4.7 | Finance › Revenue | Quick-edit amount inline | Amount updates without opening full modal | `revenue` | U | IMPORTANT | | |
| 4.8 | Finance › Revenue | Delete a revenue row | Row removed; confirmation dialog shown first | `revenue` | D | **CRITICAL** | | |
| 4.9 | Finance › Revenue | Sync from Network Scopes | New site IDs from `rows` inserted as revenue entries; no duplicate for existing `project_name + site_id` | `revenue`, `rows`, `sections` | I | IMPORTANT | | |
| 4.10 | Finance › Revenue | Current Revenue stage display | Stage percentages computed correctly from `rows` data (delivery 15%, installation 50%, etc.) | `rows`, `sections` | R | IMPORTANT | | |
| 4.11 | Finance › Revenue | Export to XLSX | Download contains all filtered revenue rows | `revenue` | R | IMPORTANT | | |

---

## 5. General Expenses

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 5.1 | Finance › General Expenses | Load page | Migrated rows displayed; no error | `general_expenses` | R | **CRITICAL** | | |
| 5.2 | Finance › General Expenses | Filter by month + year | Correct rows shown | `general_expenses` | R | **CRITICAL** | | |
| 5.3 | Finance › General Expenses | Add new expense | Row inserted; `description`, `category`, `amount`, `month`, `year`, `added_by` set | `general_expenses` | I | **CRITICAL** | | |
| 5.4 | Finance › General Expenses | Edit expense | Changes persist | `general_expenses` | U | **CRITICAL** | | |
| 5.5 | Finance › General Expenses | Delete expense | Row removed | `general_expenses` | D | **CRITICAL** | | |
| 5.6 | Finance › General Expenses | Export to XLSX | Download with correct columns | `general_expenses` | R | IMPORTANT | | |

---

## 6. Project Expenses

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 6.1 | Finance › Project Expenses | Load page | Migrated rows (169 expected) displayed; no error | `project_expenses` | R | **CRITICAL** | | |
| 6.2 | Finance › Project Expenses | Filter by project + month | Correct rows shown | `project_expenses` | R | **CRITICAL** | | |
| 6.3 | Finance › Project Expenses | Add new project expense | Row inserted; all 17 columns set correctly | `project_expenses` | I | **CRITICAL** | | |
| 6.4 | Finance › Project Expenses | Edit expense | Changes persist | `project_expenses` | U | IMPORTANT | | |
| 6.5 | Finance › Project Expenses | Delete expense | Row removed | `project_expenses` | D | IMPORTANT | | |
| 6.6 | Finance › Project Expenses | Export to XLSX | XLSX downloaded with correct data | `project_expenses` | R | IMPORTANT | | |

---

## 7. Expense Claims

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 7.1 | Finance › Expense Claims | Load page | Migrated claims displayed; no error | `expense_claims`, `team_members` | R | **CRITICAL** | | |
| 7.2 | Finance › Expense Claims | Filter by team member + status | Correct rows shown | `expense_claims` | R | IMPORTANT | | |
| 7.3 | Finance › Expense Claims | Submit new normal claim (transport + food) | Claim created with `status=pending`; `member_id`, `project_name`, `activity_date`, `total_amount` set | `expense_claims` | I | **CRITICAL** | | |
| 7.4 | Finance › Expense Claims | Approve a pending claim | `status` updated to `approved`; `reviewed_by`, `reviewed_at` set | `expense_claims` | U | **CRITICAL** | | |
| 7.5 | Finance › Expense Claims | Reject a claim with reason | `status=rejected`, `rejection_reason` populated | `expense_claims` | U | **CRITICAL** | | |
| 7.6 | Finance › Expense Claims | Edit an existing claim | Changes persist | `expense_claims` | U | IMPORTANT | | |
| 7.7 | Finance › Expense Claims | Car-trip claim: create daily activity with a car | `expense_claims` row inserted with `is_car_trip=true`, `car_id`, `daily_activity_id`, `car_trip_distance_km`, `car_trip_rate_iqd` all set | `expense_claims`, `daily_activities`, `cars` | I | **CRITICAL** | | P1-B patch required and verified |
| 7.8 | Finance › Expense Claims | Car-trip claim: re-save daily activity | Existing `is_car_trip=true` claim updated, not duplicated | `expense_claims` | U | **CRITICAL** | | Requires `cars` table to have ≥1 entry |
| 7.9 | Finance › Expense Claims | My Expenses: employee views own claims | Only own claims shown | `expense_claims` | R | IMPORTANT | | |

---

## 8. Finance Dashboard & Report

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 8.1 | Finance › Dashboard | Load; select month with migrated data | Revenue, expense, profit KPIs populated; charts render; no error | `revenue`, `general_expenses`, `project_expenses`, `team_members`, `salary_adjustments` | R | **CRITICAL** | | |
| 8.2 | Finance › Dashboard | Change month/year selector | KPIs and charts update for selected period | same | R | IMPORTANT | | |
| 8.3 | Finance › Report | Load report page | Per-project margin table populated; 6-month trend renders | same | R | **CRITICAL** | | |
| 8.4 | Finance › Report | Set salary adjustment for a team member | Adjusted salary reflected in report for that month | `salary_adjustments` | I/U | IMPORTANT | | Uses `onConflict: 'member_id,month,year'` — unique constraint must exist |
| 8.5 | Finance › Payslips | Load payslips for a member + month | Salary + expenses breakdown shown; PDF/print button visible | `team_members`, `salary_adjustments`, `expense_claims` | R | IMPORTANT | | Read-only page |

---

## 9. Clients

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 9.1 | Finance › Clients | Load page | Migrated clients displayed | `clients` | R | **CRITICAL** | | |
| 9.2 | Finance › Clients | Add new client | Row inserted; `company_name`, `contact_person`, `email`, `phone`, `address` set | `clients` | I | **CRITICAL** | | |
| 9.3 | Finance › Clients | Edit client | Changes persist | `clients` | U | IMPORTANT | | |
| 9.4 | Finance › Clients | Delete client with no linked invoices | Row removed | `clients` | D | IMPORTANT | | |
| 9.5 | Finance › Clients | Delete client with linked invoices | Either blocked or cascades correctly (check FK behaviour) | `clients`, `invoices` | D | IMPORTANT | | |

---

## 10. Invoices & Payments

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 10.1 | Finance › Invoices | Load page | Migrated invoices displayed; KPI cards show correct totals | `invoices`, `invoice_items`, `invoice_payments`, `clients`, `revenue` | R | **CRITICAL** | | |
| 10.2 | Finance › Invoices | Create invoice: select client + project → pick revenue sites | Revenue picker loads; available/invoiced counts shown; line items computed | `revenue`, `invoice_items` | R | **CRITICAL** | | |
| 10.3 | Finance › Invoices | Save new invoice | Invoice row inserted; `invoice_items` rows inserted with correct `revenue_id`; picked revenue sites marked invoiced | `invoices`, `invoice_items` | I | **CRITICAL** | | |
| 10.4 | Finance › Invoices | Edit invoice: change status or add custom line item | Changes persist; total recalculated | `invoices`, `invoice_items` | U | **CRITICAL** | | |
| 10.5 | Finance › Invoices | Record payment against invoice | `invoice_payments` row inserted; `invoices.amount_received` + `status` updated | `invoices`, `invoice_payments` | I/U | **CRITICAL** | | |
| 10.6 | Finance › Invoices | Invoice auto-overdue | Invoice with past `due_date` and unpaid balance flips to `Overdue` on next load | `invoices` | U | IMPORTANT | | |
| 10.7 | Finance › Invoices | View invoice detail | Line items and payment history shown correctly | `invoice_items`, `invoice_payments` | R | IMPORTANT | | |
| 10.8 | Finance › Invoices | Print / PDF invoice | Browser print dialog opens; invoice renders correctly | — | R | IMPORTANT | | Client-side only |
| 10.9 | Finance › Invoices | Delete invoice | Invoice + associated items deleted; revenue sites become available again | `invoices`, `invoice_items` | D | IMPORTANT | | |
| 10.10 | Finance › Invoices | Pending invoice widget | Revenue rows without `revenue_id` FK in `invoice_items` appear as pending | `revenue`, `invoice_items` | R | IMPORTANT | | |

---

## 11. Team Members / HR

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 11.1 | HR › Profiles | Load page | All 25 migrated team members listed with name, role, status | `team_members` | R | **CRITICAL** | | |
| 11.2 | HR › Profiles | Open member profile | Personal, employment, documents, trips tabs load | `team_members`, `employee_documents`, `field_trips` | R | **CRITICAL** | | |
| 11.3 | HR › Profiles | Edit member details (phone, address, salary) | Changes persist; `team_members` row updated | `team_members` | U | **CRITICAL** | | |
| 11.4 | HR › Profiles | Deactivate a member | `is_active=false`, `deactivated_at` set | `team_members` | U | IMPORTANT | | |
| 11.5 | HR › Profiles | Reactivate a member | `is_active=true`, `activated_at` updated | `team_members` | U | IMPORTANT | | |
| 11.6 | HR › Profiles | Upload a document (PDF/image) | File uploaded to `employee-docs` storage; `employee_documents` row inserted | `employee_documents` + Storage | I | IMPORTANT | | Requires `employee-docs` bucket |
| 11.7 | HR › Profiles | Delete a document | `employee_documents` row deleted; file in storage remains (or is deleted if implemented) | `employee_documents` | D | IMPORTANT | | |
| 11.8 | HR › Profiles | Photo upload for a member | Photo uploaded to `employee-docs` storage; `team_members.profile_photo_url` updated | `team_members` + Storage | U | IMPORTANT | | Requires `employee-docs` bucket |
| 11.9 | HR › Profiles | Trips tab for a member | Field trips list rendered (empty is fine if no trips yet) | `field_trips`, `trip_participants` | R | POST-LIVE | | |
| 11.10 | Finance › Team Members (FinTeam) | Load page | All migrated members shown; salary column present | `team_members` | R | **CRITICAL** | | |
| 11.11 | Finance › Team Members | Add new team member | Row inserted; `full_name`, `role`, `monthly_salary`, `is_active`, `activated_at` set | `team_members` | I | **CRITICAL** | | |
| 11.12 | Finance › Team Members | Edit monthly salary | `monthly_salary` updated | `team_members` | U | **CRITICAL** | | Affects all finance reports |
| 11.13 | Finance › Team Members | Export team to XLSX | Download with correct columns | `team_members` | R | IMPORTANT | | |
| 11.14 | Finance › Team Members | Bulk salary import (XLSX) | Salaries updated for matched members | `team_members` | U | IMPORTANT | | |

---

## 12. User Management

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 12.1 | User Management | Load page (admin only) | All 26 users listed with role and last-login status | `users` | R | **CRITICAL** | | |
| 12.2 | User Management | Edit user role | `users.role` updated | `users` | U | **CRITICAL** | | |
| 12.3 | User Management | Edit user permissions (toggles) | `users.permissions` JSONB updated | `users` | U | **CRITICAL** | | |
| 12.4 | User Management | Create new user | Auth user created; `public.users` row inserted; `auth_user_id` populated | `auth.users`, `users` | I | **CRITICAL** | | Calls Supabase Admin API |
| 12.5 | User Management | Reset user password | Auth user password updated | `auth.users` | U | IMPORTANT | | |

---

## 13. My Profile

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 13.1 | My Profile | Load page | Own name, role, personal fields displayed | `users`, `team_members` | R | **CRITICAL** | | HR-linked fields sourced from `team_members` if match found |
| 13.2 | My Profile | Edit own profile (phone, address) | `users` row updated (only when no HR link) | `users` | U | IMPORTANT | | Disabled when HR-linked |
| 13.3 | My Profile | Change password (correct current password) | Auth password updated; can log in with new password | `auth.users` | U | **CRITICAL** | | |
| 13.4 | My Profile | Upload profile photo | File in `employee-docs` storage; `users.profile_photo_url` updated; avatar changes | `users` + Storage | U | IMPORTANT | | Requires `employee-docs` bucket |

---

## 14. Attendance

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 14.1 | Attendance Admin | Load page | Attendance records displayed; member filter works | `attendance`, `team_members` | R | **CRITICAL** | | |
| 14.2 | Attendance Admin | Set attendance for a member (upsert) | Row inserted or updated; `member_id`, `date`, `clock_in`, `clock_out`, `hours_worked` set; unique constraint `(member_id, date)` respected | `attendance` | I/U | **CRITICAL** | | |
| 14.3 | Attendance Admin | Edit existing attendance row | Hours/status corrected; `updated_by` set | `attendance` | U | IMPORTANT | | |
| 14.4 | My Attendance | Employee clocks in via My Attendance | `attendance` upserted for today's date + logged-in member | `attendance` | U | IMPORTANT | | |
| 14.5 | Attendance Admin | Filter by date range | Correct records shown | `attendance` | R | IMPORTANT | | |

---

## 15. Daily Activities & Field Trips

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 15.1 | Daily Activities | Load page | Activities listed; date and member filters work | `daily_activities`, `team_members` | R | **CRITICAL** | | |
| 15.2 | Daily Activities | Create new activity (no car trip) | `daily_activities` row inserted; project, section, site, team members, description set | `daily_activities` | I | **CRITICAL** | | |
| 15.3 | Daily Activities | Create activity with car trip enabled | `daily_activities` + `field_trips` + `trip_participants` rows inserted; `expense_claims` car-trip row auto-created with `is_car_trip=true` | `daily_activities`, `field_trips`, `trip_participants`, `expense_claims`, `cars` | I | **CRITICAL** | | Requires ≥1 car in `cars`; P1-B verified |
| 15.4 | Daily Activities | Edit an existing activity | All fields updated; car-trip claim updated if changed | `daily_activities`, `expense_claims` | U | **CRITICAL** | | |
| 15.5 | Daily Activities | Delete an activity | `daily_activities` row deleted; linked `field_trips` and `trip_participants` cascade-deleted; `expense_claims` car-trip row deleted | `daily_activities`, `field_trips`, `trip_participants`, `expense_claims` | D | IMPORTANT | | |
| 15.6 | Live Trips | Load Live Trips | Active field trips visible; participant status shown | `field_trips`, `trip_participants`, `sites` | R | IMPORTANT | | |
| 15.7 | Live Trips | Start a trip | `field_trips.started_at` and `started_by` set | `field_trips` | U | IMPORTANT | | |
| 15.8 | My Trips | Employee views own trips | Trip history for logged-in member | `field_trips`, `trip_participants` | R | IMPORTANT | | |
| 15.9 | FinCars | Add a car | `cars` row inserted; car appears in Daily Activities car selector | `cars` | I | **CRITICAL** | | Without this, car-trip tests 7.7/7.8/15.3 cannot run |

---

## 16. Activity Log

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 16.1 | Activity Log | Load page | Log entries displayed; migrated entries visible | `activity_log` | R | IMPORTANT | | |
| 16.2 | Activity Log | Perform any write action elsewhere (e.g. edit revenue) | New entry appears in Activity Log with correct `user_full_name`, `action`, `project_name` | `activity_log` | R | IMPORTANT | | Write is fire-and-forget via `logActivity()`; console warns on failure |

---

## 17. My Work / My Sites / My Expenses

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 17.1 | My Work | Load as engineer/technician | Assigned activities and sites for logged-in member shown | `daily_activities`, `field_trips`, `sections`, `rows` | R | IMPORTANT | | |
| 17.2 | My Sites | Load | Sections/rows assigned to logged-in member visible | `sections`, `rows` | R | POST-LIVE | | |
| 17.3 | My Expenses | Load as non-admin | Own expense claims listed | `expense_claims` | R | IMPORTANT | | |

---

## 18. Backup & Restore

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 18.1 | Backup & Restore | Export all tables | JSON download contains all tables with current row data | All | R | IMPORTANT | | |
| 18.2 | Backup & Restore | Import a previously exported backup | Rows upserted (`onConflict: 'id'`); no duplicate primary keys | All | U | POST-LIVE | | Test with non-destructive subset only |

---

## 19. Notifications

| # | Module / Page | Test Action | Expected Result | Tables Affected | Op | Classification | PASS/FAIL | Notes |
|---|--------------|-------------|-----------------|-----------------|-----|---------------|-----------|-------|
| 19.1 | Push notifications | Approve an expense claim | No crash; push attempt made silently (check console for `[Push]` warn) | `push_subscriptions` | R | POST-LIVE | | `/api/send-push` not yet deployed; failures are swallowed |
| 19.2 | Push notifications | Subscribe to notifications (browser prompt) | `push_subscriptions` row inserted for this user | `push_subscriptions` | I | POST-LIVE | | |

---

## Recommended Execution Order

Run tests in this order to build on dependencies (earlier tests seed data for later ones):

```
PHASE A — Foundation (must pass before anything else)
  1. Auth (tests 1.1–1.5)
  2. FinCars: Add ≥1 car (test 15.9)  ← unblocks car-trip tests
  3. User Management load + permissions (tests 12.1–12.3)

PHASE B — Core Data Read (validate migrated data intact)
  4. Network Scopes read (tests 2.1–2.2)
  5. Revenue read + filter (tests 4.1–4.3)
  6. General Expenses load (test 5.1)
  7. Project Expenses load (test 6.1)
  8. Expense Claims load (test 7.1)
  9. HR Profiles load (test 11.1)
  10. Finance Dashboard (test 8.1)
  11. Finance Report (test 8.3)
  12. Clients load (test 9.1)
  13. Invoices load (test 10.1)

PHASE C — Core CRUD
  14. Network Scopes: add section → add rows → edit → retire (2.3–2.8)
  15. Revenue: add entry via modal → edit → delete (4.4–4.8)
  16. General Expenses: add → edit → delete (5.2–5.5)
  17. Project Expenses: add → edit → delete (6.2–6.5)
  18. Expense Claims: submit normal claim → approve → reject (7.2–7.5)
  19. HR › Team Members: add → edit salary → activate/deactivate (11.10–11.12, 11.4–11.5)
  20. Attendance: set attendance for a member (14.1–14.2)
  21. Daily Activities: create normal activity → create car-trip activity (15.1–15.4)
  22. Expense Claims: verify car-trip claim created (7.7)
  23. Clients: add → edit (9.1–9.3)
  24. Invoices: create → add line items → record payment (10.2–10.5)

PHASE D — Profile, Documents, Auth Changes
  25. My Profile load + password change (13.1, 13.3)
  26. HR Profiles: edit member → upload document → upload photo (11.3, 11.6, 11.8)

PHASE E — Secondary Workflows
  27. Sites DB: add site → import XLSX → export (3.1–3.6)
  28. Finance Payslips + Report salary adjustments (8.4–8.5)
  29. User Management: create user → edit permissions (12.4, 12.3)
  30. Activity Log verification (16.1–16.2)

PHASE F — Exports & Deferred
  31. All XLSX exports: Revenue, General Expenses, Project Expenses, Team Members (4.11, 5.6, 6.6, 11.13)
  32. Invoice PDF print (10.8)
  33. Backup export (18.1)
  34. My Work, My Sites, My Expenses, My Trips (17.1–17.3, 15.8)
  35. Notifications (19.1–19.2)
  36. Live Trips (15.6–15.7)
```

---

## Totals

| Classification | Count |
|---------------|-------|
| **CRITICAL** | **49** |
| **IMPORTANT** | **37** |
| **POST-LIVE** | **11** |
| **Total** | **97** |

---

## Pre-Test Setup Checklist

Before starting PHASE A, confirm the following in the staging project:

- [ ] `.env` points to `qaqxoakjnyivuegsopha` (already confirmed)
- [ ] Storage bucket `employee-docs` exists in Supabase Dashboard → Storage
- [ ] At least one admin-role user can log in (verify `auth_user_id` is set)
- [ ] Patches 08, 09, 10 verified applied (already confirmed by re-audit)
- [ ] No existing `cars` rows — create at least one before car-trip tests

---

*After completing each phase, run `scripts/verify-qa-writes.ts` to confirm writes persisted in Supabase.*
