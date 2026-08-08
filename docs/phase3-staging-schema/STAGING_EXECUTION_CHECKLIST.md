# Phase 3 Step 2 — Staging Schema Execution Checklist

Status: **Files only. Nothing in this folder has been run.** You review and
approve, then run each file yourself in the Supabase SQL Editor, in order.

## 0. Before you run anything

- [ ] Confirm you're in the **new staging project** ("JSR Network Tracker
      React"), not `tltbkjvrhqsxdspdfeqk` (live JSR) or `gauejhgitzcqjvzalshf`
      (TAC). Check the dashboard URL and Settings → General → Reference ID,
      same as every prior audit in this repo.
- [ ] Read section 1 below (data confidence per table) before running files
      that touch `sections`, `revenue`, or `rows` — see why first.

## 1. Data confidence — not every table below is equally certain

14 tables are built from a **live column export** (Phase 2C/2D audit CSVs) —
high confidence: `users`, `team_members`, `clients`, `activity_log`,
`general_expenses`, `project_expenses`, `daily_activities`,
`employee_documents`, `expense_claims`, `salary_adjustments`,
`push_subscriptions`, `invoices`, `invoice_items`, `invoice_payments`.
(`project_expenses` added by the Phase 4 schema patch — see below. Original
count here was 13; corrected count before that was drafted as 14 by mistake
too, which didn't match the 13 tables then actually listed; caught during
pre-execution review. Now genuinely 14, with `project_expenses` added.)

**`sections` and `rows` were never fully live-column-confirmed until the
Phase 4 schema patch** — the original
`/Users/alijasim/Desktop/JSR/supabase_setup.sql` (old JSR's own real
schema-creation script) was located during Phase 4 planning and confirms
every column for both tables, closing the gap that had followed this
package since Phase 2B:

- `sections` — now fully confirmed: `section_label`, `columns`, `is_custom`,
  and `is_deleted` are all `NOT NULL` live (previously left nullable here,
  as Phase 2B's inference from React's code, before this primary source was
  found — corrected in `01_extensions_and_core_tables.sql`).
- `rows` — now fully confirmed: `data`/`row_order` are `NOT NULL` with
  defaults, `section_id` has `ON DELETE CASCADE`, and a trigger keeps
  `updated_at` current (all previously missing — corrected in
  `02_dependent_tables.sql`, plus the `rows_section_order_idx` composite-index
  fix in `05_additional_indexes.sql`).

**`revenue` is still not fully live-column-confirmed against the old JSR
database** — only `id` (PK) is live-confirmed (primary_keys.csv), and it
doesn't appear in the original `supabase_setup.sql` at all. However, the
column set in `01_extensions_and_core_tables.sql` was corrected (2026-08) by
grepping every `.select()`/`.insert()`/`.update()`/`.order()` call against
`public.revenue` across the actual frontend (FinRevenue.tsx,
FinInvoices.tsx, FinReport.tsx, FinDashboard.tsx) — the original 6-column
Phase 2B guess was missing `section_name`, `invoice_date`, `status`,
`notes`, and `added_by`, which caused the Revenue page to error on the
already-provisioned staging project (fixed there via
`09_patch_revenue_missing_columns.sql`). The column set is now confirmed
against frontend usage, if not against a live old-JSR export.

**4 tables have no live JSR equivalent at all** (`cars`, `field_trips`,
`trip_participants`, `attendance`) — reverse-engineered from
`jsr-app-react`'s own source code (exact `.select()`/`.insert()` calls and
TypeScript interfaces), not from any database export, since these features
don't exist in old JSR. See the comments in
`03_new_react_only_tables.sql` for the specific files each column came from.

**`project_expenses` was missing from this entire package until the Phase 4
schema patch caught it** — it is not new/inferred like the tables above, it
is a fully live-confirmed table (17 columns, via
`docs/schema-audit-results/11b_flagged_tables_schema_complete.csv`) with 169
real production rows (`a_approx_row_counts.csv`) that simply never got added
to files 01-06 or listed as an intentional exclusion in section 2 below. Now
added to `01_extensions_and_core_tables.sql` and `06_enable_rls_no_
policies.sql`.

**`users.password` is now nullable** (was `NOT NULL`, matching live JSR) —
also part of the Phase 4 schema patch, not a live-data discrepancy. Phase 4's
Auth migration writes each source password into Supabase Auth exactly once
and never copies it into this column at the destination; migrated rows get
`password = null`. See the comment above the `users` table in
`01_extensions_and_core_tables.sql` for the full rationale, including the
plan to drop this column entirely once Auth migration is verified working.

## 2. What's intentionally excluded (confirm this matches your intent)

- `expenses`, `expense_budgets`, `work_log` — confirmed dead in Phase 2D
  (0-1 rows, never read/written by old JSR's `index.html`). Not recreated.
- Car-trip columns on `daily_activities` and `expense_claims`
  (`react_migration_phase17-21`), and section-linkage columns on
  `expense_claims` (`react_migration_phase15`) — none of these exist on
  live JSR today, and you didn't list them in your Step 2 requirements, so
  they're not included. If the car-trip or section-linkage features need to
  work against JSR, that needs its own explicit follow-up phase, layered on
  top of this baseline the same way phases 15/17-21 were layered onto TAC.
- Final RLS hardening, and permissive RLS policies — per your item 8 and
  your explicit correction not to add permissive policies. **This baseline
  (files 01-05) does not enable RLS at all** (Postgres's default is RLS off
  = unrestricted, the simplest "not hardened yet" state for testing). A
  separate `06_enable_rls_no_policies.sql` is included that flips RLS on for
  all 24 tables with zero policies — that file is NOT part of this
  baseline's run order and must not be run until Auth policies exist (see
  its header). No permissive/mirroring policies have been written anywhere
  in this package.
- Production data — per your item 9. The only rows in this baseline are
  `app_settings`'s 1 seed row and `projects`'s 6 seed rows (app
  configuration required for the app to function at all, not
  user/business data) — remove those two `insert` statements from
  `01_extensions_and_core_tables.sql` first if you'd rather seed them by
  hand.

## 3. Execution order

Run each file's full contents as one paste in the SQL Editor, check for
errors, then move to the next:

1. `01_extensions_and_core_tables.sql` — extensions + 13 independent tables
   (`users`, `team_members`, `clients`, `activity_log`, `general_expenses`,
   `project_expenses`, `daily_activities`, `sections`, `revenue`, `sites`,
   `app_settings`, `projects`, `saved_points`).
2. `02_dependent_tables.sql` — 8 tables with FKs into file 01's tables
   (`employee_documents`, `expense_claims`, `salary_adjustments`,
   `push_subscriptions`, `invoices`, `rows`, `invoice_items`,
   `invoice_payments`), plus the `update_updated_at()` trigger function and
   `rows_updated_at` trigger (added by the Phase 4 schema patch).
3. `03_new_react_only_tables.sql` — 4 more React-only tables with FKs into
   files 01-02 (`cars`, `field_trips`, `trip_participants`, `attendance`).
4. `04_required_column_additions.sql` — your items 4 & 5: `username` on
   `team_members`, `auth_user_id` + 9 profile columns on `users`.
5. `05_additional_indexes.sql` — the 3 confirmed-live extra indexes plus 5
   new ones for the React-only tables' FK columns. `rows_section_order_idx`
   is now a composite `(section_id, row_order)` index (corrected by the
   Phase 4 schema patch — previously single-column `(row_order)`).
6. `06_enable_rls_no_policies.sql` — **do not run yet.** Enables RLS on all
   25 tables with zero policies attached. See the file's own header for why
   this must not run before Auth policies exist (it would block all API
   access). Provided now so it's ready for whenever Auth migration/policy
   work is approved — not part of this baseline's execution.

That's **25 tables total** (corrected again — this was 24 as of the last
review, then `project_expenses` was found missing during Phase 4 planning
and added; see section 1 above): 14 live-column-confirmed old-JSR tables + 2
old-JSR-derived tables now fully confirmed via the original
`supabase_setup.sql` (`sections`, `rows`) + 1 old-JSR-derived table still
partly inferred (`revenue`) = 17 old-JSR-derived tables, plus 8 new
React-only tables (`sites`, `app_settings`, `projects`, `saved_points`,
`cars`, `field_trips`, `trip_participants`, `attendance`) = 25.

## 4. After running 01-05

6. Run `verify_staging_schema.sql`, section by section, and confirm:
   - Section 1 lists all 25 tables.
   - Section 2 shows 0 rows everywhere except `app_settings` (1) and
     `projects` (6).
   - Section 3 returns 11 rows (confirms file 04 applied fully).
   - Sections 4-6 match what you expect from the confirmed FK/unique/index
     lists in `docs/schema-audit-results/`.
   - Section 7 confirms `auth.users` is still empty (expected — no Auth
     migration has run against staging yet, that's Phase 4, ahead).
   - Section 9 confirms the `rows_updated_at` trigger exists.
   - Section 10 confirms `users.password` is nullable (Phase 4 requirement).

## 5. If something goes wrong

`staging_rollback_reset.sql` drops every table this folder creates, in
reverse dependency order, so you can fix a file and re-run 01-05 from a
clean state. Staging is disposable — there's no risk to production from
using this freely. Double-check the project ref before running it anyway,
since a `DROP TABLE CASCADE` in the wrong project would not be recoverable
the same way.

## 6. What this does NOT do (per your items 8-10)

- Does not enable/harden RLS as part of the 01-05 baseline. `06_enable_rls_
  no_policies.sql` exists on disk but is explicitly excluded from the run
  order above and must not be run until Auth policies are ready.
- Does not insert or migrate any production data (only the two small app-
  config seed lists noted in section 2 above).
- Does not run anything automatically — every file above is provided for
  your review, and only you decide when and whether to run each one.
- Does not touch the old JSR live Supabase project or the TAC Supabase
  project in any way.
