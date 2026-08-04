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

13 tables are built from a **live column export** (Phase 2C/2D audit CSVs) —
high confidence: `users`, `team_members`, `clients`, `activity_log`,
`general_expenses`, `daily_activities`, `employee_documents`,
`expense_claims`, `salary_adjustments`, `push_subscriptions`, `invoices`,
`invoice_items`, `invoice_payments`.
(Corrected count — an earlier draft of this checklist said 14, which didn't
match the 13 tables actually listed; caught during pre-execution review.)

**3 tables were never fully live-column-confirmed**, despite being labeled
"confirmed compatible" in the Phase 2D closure report — that labeling was a
mistake carried over from Phase 2B's earlier static-file inference and
should have been caught sooner:

- `sections` — only `id` (PK) and the `(project_name, section_name)` unique
  constraint are live-confirmed. The rest of its columns are Phase 2B's
  inference from React's code.
- `revenue` — only `id` (PK) is live-confirmed. No FK, no unique constraint,
  no extra index recorded for it anywhere in the audit. Columns are Phase
  2B's inference from a partial `.select()` call.
- `rows` — `id` (PK) and `section_id` (FK → sections) are live-confirmed,
  plus two named indexes implying a row-ordering column exists. The rest
  (`data jsonb`, `row_order`, timestamps) is inferred.

**Recommendation:** before running `01_extensions_and_core_tables.sql` and
`02_dependent_tables.sql`, consider one more small live query (scoped to
just these 3 table names, same pattern as the earlier `11b`/`12` re-exports)
to close this gap with certainty. Not required — staging is disposable if
these guesses are wrong — but cheap insurance before building on top of them.

**4 tables have no live JSR equivalent at all** (`cars`, `field_trips`,
`trip_participants`, `attendance`) — reverse-engineered from
`jsr-app-react`'s own source code (exact `.select()`/`.insert()` calls and
TypeScript interfaces), not from any database export, since these features
don't exist in old JSR. See the comments in
`03_new_react_only_tables.sql` for the specific files each column came from.

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

1. `01_extensions_and_core_tables.sql` — extensions + 12 independent tables
   (`users`, `team_members`, `clients`, `activity_log`, `general_expenses`,
   `daily_activities`, `sections`, `revenue`, `sites`, `app_settings`,
   `projects`, `saved_points`).
2. `02_dependent_tables.sql` — 8 tables with FKs into file 01's tables
   (`employee_documents`, `expense_claims`, `salary_adjustments`,
   `push_subscriptions`, `invoices`, `rows`, `invoice_items`,
   `invoice_payments`).
3. `03_new_react_only_tables.sql` — 4 more React-only tables with FKs into
   files 01-02 (`cars`, `field_trips`, `trip_participants`, `attendance`).
4. `04_required_column_additions.sql` — your items 4 & 5: `username` on
   `team_members`, `auth_user_id` + 9 profile columns on `users`.
5. `05_additional_indexes.sql` — the 3 confirmed-live extra indexes plus 5
   new ones for the React-only tables' FK columns.
6. `06_enable_rls_no_policies.sql` — **do not run yet.** Enables RLS on all
   24 tables with zero policies attached. See the file's own header for why
   this must not run before Auth policies exist (it would block all API
   access). Provided now so it's ready for whenever Auth migration/policy
   work is approved — not part of this baseline's execution.

That's **24 tables total** (corrected — an earlier draft of this section
said 25, which didn't match the actual table count; caught during
pre-execution review): 13 live-column-confirmed old-JSR tables + 3
old-JSR-derived tables with inferred columns (`sections`, `revenue`, `rows`)
= 16 old-JSR-derived tables, plus 8 new React-only tables (`sites`,
`app_settings`, `projects`, `saved_points`, `cars`, `field_trips`,
`trip_participants`, `attendance`) = 24.

## 4. After running 01-05

6. Run `verify_staging_schema.sql`, section by section, and confirm:
   - Section 1 lists all 24 tables.
   - Section 2 shows 0 rows everywhere except `app_settings` (1) and
     `projects` (6).
   - Section 3 returns 11 rows (confirms file 04 applied fully).
   - Sections 4-6 match what you expect from the confirmed FK/unique/index
     lists in `docs/schema-audit-results/`.
   - Section 7 confirms `auth.users` is still empty (expected — no Auth
     migration has run against staging yet, that's Phase 3 Step 3, later).

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
