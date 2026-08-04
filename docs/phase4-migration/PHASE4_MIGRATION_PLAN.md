# Phase 4 — Production Data Migration Plan

Status: **Plan only. Nothing has been executed against any Supabase project.**
No script referenced below has been built or run. This document is the plan;
the scripts it describes are separate deliverables, built only after the
schema patch below (section 1) has been applied **and verified** against the
actual staging project — per your explicit item 6 correction, migration
scripts are not to be built before that.

This is a revision of the first version of this plan, incorporating your six
approved corrections. What changed from the first version is called out
inline in each section rather than hidden — this is a moving document, not a
final spec.

## 0. Scope and non-negotiables (per your Phase 4 instructions)

- Source: old JSR's live Supabase project (`tltbkjvrhqsxdspdfeqk`) — **read
  only**, via scripts you run yourself with your own credentials. Nothing in
  this plan writes to it.
- Destination: the new staging project ("JSR Network Tracker React") that
  Phase 3 Step 2 built the schema for.
- TAC's Supabase project (`gauejhgitzcqjvzalshf`) is not touched anywhere in
  this plan.
- No manual/dashboard-created admin or bootstrap account, anywhere. Every
  account in the destination comes from migrating a real row out of old
  JSR's `users` table.
- Nothing executes until you approve each script. This document is the plan;
  the scripts are separate deliverables, built after you've seen this.
- **New this revision:** no legacy plaintext password is ever copied into the
  destination's `public.users` table (section 2 below).

## 1. Prerequisite — the schema patch (status: files corrected, NOT yet run)

Phase 3 Step 2's schema (files 01-06 in `docs/phase3-staging-schema/`) has
now been corrected in place — not just proposed in the old standalone
addendum file, which has been retired to a historical changelog
(`07_pending_corrections_addendum.sql`). The corrections, all folded directly
into 01/02/05/06:

- `sections.section_label` / `sections.columns` / `sections.is_custom` /
  `sections.is_deleted` are now `NOT NULL`, matching old JSR's real schema
  (confirmed via the original `supabase_setup.sql`, not just Phase 2B
  inference anymore).
- `rows.data` / `rows.row_order` are now `NOT NULL DEFAULT`, `rows.section_id`
  now has `ON DELETE CASCADE`, `rows_section_order_idx` is now a composite
  `(section_id, row_order)` index instead of single-column, and a
  `rows_updated_at` trigger now auto-maintains `updated_at`.
- **`project_expenses` has been added** — a live table with 169 real
  production rows (`docs/schema-audit-results/a_approx_row_counts.csv`),
  actively used by `src/pages/FinProjExp.tsx`, that had fallen through every
  earlier audit pass and wasn't in the schema at all until this patch.
- **`users.password` is now nullable** (was `NOT NULL`, matching old JSR) —
  this is the change your correction #1 required; see section 2 below for
  why.
- Table count updated 24 → 25 everywhere it's referenced
  (`STAGING_EXECUTION_CHECKLIST.md`, `verify_staging_schema.sql`,
  `06_enable_rls_no_policies.sql`).
- `verify_staging_schema.sql` gained two new checks: section 9 (the
  `rows_updated_at` trigger exists) and section 10 (`users.password` is
  nullable).

**What is NOT done yet:** none of files 01-06 have actually been run against
the staging Supabase project — the checklist's own status line still reads
"nothing in this folder has been run." Per your correction #4, this plan
does not proceed to script-building until you've run the corrected 01-06 in
the SQL Editor and confirmed `verify_staging_schema.sql` sections 1, 2, 3, 9,
and 10 all pass against the real staging project. That execution is yours to
do (same standing rule as every SQL file in this repo) — I'll wait for
confirmation before drafting the migration scripts themselves.

## 2. Password handling (correction #1 — reworked from the first version)

The first version of this plan said source passwords would be "copied as-is
for parity" into the destination's `users.password` column. That's wrong and
has been removed. The corrected flow:

1. Read `password` from the source `users` row.
2. Use it exactly once, as the `password` argument to
   `supabase.auth.admin.createUser()` **against the destination project**.
   Supabase Auth hashes it on write; this script never stores the plaintext
   value anywhere itself (no file, no log line, no destination column).
3. Insert the destination `public.users` row with `password = null`
   explicitly. This is why `01_extensions_and_core_tables.sql` now defines
   `password` as nullable instead of `NOT NULL` — the insert would fail
   otherwise.
4. Once Auth migration and rollback testing are both verified working
   against staging, the plan is to drop `users.password` entirely (it
   becomes dead weight the moment Auth is the real login path). Not dropped
   immediately, in case something in testing still needs to reference it —
   tracked as a follow-up, not forgotten.

## 3. Migration order

### Step 1 — Auth users (your item 1)

For every row in old JSR's `public.users` (26 rows, per
`a_approx_row_counts.csv`):

1. Read `id, username, password, full_name, role` from source.
2. Build the synthetic email `username@jsr.internal` via the same
   `buildAuthEmail()` pattern already in `src/config/brand.ts`.
3. Run the idempotency checks in section 4 below.
4. If none of those checks say "skip" or "reuse," call
   `supabase.auth.admin.createUser()` against the **destination** project
   with that password, capture the new `auth.users.id`.

This differs from the existing `scripts/migrate-users-to-auth.ts` in one
structural way worth repeating: that script assumes source and destination
are the *same* project. Phase 4 is a two-project move — a read-only client
against source, a service-role client against destination — and the Auth
account is created in the destination project, not the source.

### Step 2 — Insert `users` rows + populate `auth_user_id` (your item 2)

For each source user not already migrated (per section 4's checks), insert
into the destination `public.users` with:

- `id` = the **original** source row's `id` (preserved as-is — every other
  table's FK into `users`, e.g. `push_subscriptions.user_id`, points at this
  value, so it cannot change).
- `password` = `null` (never the source value — see section 2).
- `auth_user_id` = the Auth UUID from Step 1 (freshly created, or reused per
  section 4).
- Every other column copied as-is (`username`, `role`, `full_name`,
  `permissions`, `created_at`, plus the 9 profile columns from file 04, all
  `null` for existing users until they fill in "My Profile" themselves).

### Step 3 — Migrate all remaining production tables (your item 3)

Dependency-safe order, derived from
`docs/schema-audit-results/foreign_keys.csv` plus the schema built in Phase 3
Step 2 (now including `project_expenses`):

**Tier 0 — no FK dependency on another migrated table:**
`team_members`, `clients`, `sections`, `activity_log`, `general_expenses`,
`project_expenses`, `daily_activities`, `revenue`.

**Tier 1 — depend on Tier 0 / users:**
`employee_documents` (→ `team_members`), `expense_claims` (→
`team_members`), `salary_adjustments` (→ `team_members`),
`push_subscriptions` (→ `users`), `invoices` (→ `clients`), `rows` (→
`sections`).

**Tier 2 — depend on Tier 1:**
`invoice_items` (→ `invoices`), `invoice_payments` (→ `invoices`).

**Not part of data migration:** `sites`, `app_settings`, `projects`,
`saved_points`, `cars`, `field_trips`, `trip_participants`, `attendance` are
all React-only tables with no live JSR equivalent — old JSR has zero rows
for them because the tables don't exist there. `app_settings` and `projects`
already have their staging config seed rows from file 01; the rest start
empty, same as they do today.

**Explicitly excluded per Phase 2D / the Step 2 checklist (still holds):**
`expenses`, `expense_budgets`, `work_log` — confirmed dead (0-1 rows, never
read/written by old JSR's live app).

For every migrated table: preserve the source `id` on insert (never let the
destination generate a new one), copy all columns as exported, and skip rows
whose `id` already exists at the destination (idempotent re-run).

**Pagination:** none of these tables currently exceed ~600 rows
(`activity_log` is the largest at 586), but the script should still page
through results (e.g. 500 rows per page) rather than assume a single request
always returns everything.

## 4. Idempotency for the Auth migration (correction #2 — new section)

The first version of this plan only had a reactive fallback (catch a
"duplicate email" error from `createUser()` and look up the existing
account). That's not enough on its own — it depends on Supabase Auth's error
message staying stable and only covers one of several partial-failure
shapes. The corrected script checks proactively, in this order, before ever
calling `createUser()`:

1. **Check destination `public.users` by preserved source `id`.** If a row
   already exists there, this user has already gone through Step 2 — skip
   both Auth creation and the insert entirely.
2. **Check that row's `auth_user_id`, if the row exists but came from a
   partial run.** If it's already set, skip Auth creation, nothing to do.
3. **Check whether an Auth user already exists for `username@jsr.internal`**
   via the destination's `supabase.auth.admin.listUsers()` (paginated,
   matched by email) before attempting `createUser()`. If found, reuse that
   Auth UUID as `auth_user_id` instead of creating a second account.
4. **Only if none of 1-3 apply**, call `createUser()` and use the UUID it
   returns.

This guarantees: never more than one Auth account per `username@jsr.internal`
regardless of how many times the script is run or where a previous run
failed, and a `users` row is only ever inserted once per preserved `id`.

## 5. Credential storage (correction #3 — new section)

Both source and destination service-role keys live in one new,
git-ignored, local-only file: **`.env.phase4.local`** (the repo's
`.gitignore` already covers the `*.local` pattern, confirmed — no gitignore
change needed). Rules, same spirit as the existing
`scripts/migrate-users-to-auth.ts` rules, extended to the two-project case:

- Never in the committed `.env` or `.env.example`.
- Never in any `VITE_`-prefixed variable — this file is Node-script-only and
  must never be bundled into the frontend.
- Never committed (covered by `*.local` in `.gitignore`).
- Never printed to console, never included in any report, log line, or
  screenshot this migration produces.
- Never pasted into chat — if something needs debugging, the script should
  print masked identifiers (e.g. project ref, row counts) never full keys or
  URLs with embedded keys.

Expected contents of `.env.phase4.local` (you create this file yourself,
locally, when you're ready to run the scripts — not created for you, since
it will hold real secrets):

```
SOURCE_SUPABASE_URL=https://tltbkjvrhqsxdspdfeqk.supabase.co
SOURCE_SUPABASE_SERVICE_ROLE_KEY=...
DEST_SUPABASE_URL=https://<staging-ref>.supabase.co
DEST_SUPABASE_SERVICE_ROLE_KEY=...
EXPECTED_SOURCE_PROJECT_REF=tltbkjvrhqsxdspdfeqk
EXPECTED_DEST_PROJECT_REF=<staging-ref>
```

The `EXPECTED_*_PROJECT_REF` values feed the preflight check in section 6 —
you fill in the real staging ref once you have it; I don't currently have it
recorded anywhere in this repo.

## 6. Preflight script (correction #5 — new deliverable)

A new script, `scripts/phase4-00-preflight.ts`, that every other Phase 4
script imports and runs first — refuses to proceed unless every check below
passes:

1. **Source project ref matches old JSR.** Extract the ref from
   `SOURCE_SUPABASE_URL` (the subdomain in `https://<ref>.supabase.co`) and
   compare to `EXPECTED_SOURCE_PROJECT_REF`. Fail loudly on mismatch.
2. **Destination project ref matches the JSR React staging project.** Same
   extraction, compared to `EXPECTED_DEST_PROJECT_REF`. Fail on mismatch.
3. **Source and destination refs are different.** A guard against both env
   vars accidentally pointing at the same project. Also explicitly rejects
   the destination ref matching either `tltbkjvrhqsxdspdfeqk` (old JSR) or
   `gauejhgitzcqjvzalshf` (TAC) — the destination must be the staging
   project, never one of the two protected ones, no matter what
   `EXPECTED_DEST_PROJECT_REF` says.
4. **All required destination tables and columns exist.** Query
   `information_schema.tables`/`columns` against the destination for the
   full 25-table list and the specific corrected shapes from section 1
   (`project_expenses` exists; `sections.section_label` is `NOT NULL`;
   `rows.data`/`row_order` are `NOT NULL`; `rows.section_id`'s FK has
   `ON DELETE CASCADE` via `information_schema.referential_constraints`;
   `users.password` is nullable). This is the "verified" half of your
   correction #4 — enforced by the script, not just eyeballed once.
5. **Destination migrated tables are empty, or resume is explicitly
   approved.** For every Tier 0-2 table in section 3, check
   `count(*) = 0`. If any is non-zero, abort unless an explicit
   `ALLOW_RESUME=true` env var is set — a safety net against accidentally
   re-running a full migration on top of itself, while still allowing a
   deliberate resume after a partial failure.

Only if every check passes does the preflight print `PREFLIGHT OK` and let
the calling script continue. Any failure exits non-zero with a specific
reason — no partial credit, no "warning and continue."

## 7. Row-count verification (your item 4)

A script that runs `select count(*)` against both source and destination for
every migrated table and prints a diff table: source count, destination
count, match/mismatch. Any mismatch fails loudly rather than being logged and
ignored. Also re-confirms `auth.users` count in the destination equals the
number of `public.users` rows with a non-null `auth_user_id`.

## 8. Verification and rollback reports (your item 5)

- **Verification report**: covers row-count parity (section 7), a spot-check
  of a handful of FK relationships actually resolving (e.g. a sample
  `push_subscriptions.user_id` still finds its `users` row, a sample
  `rows.section_id` still finds its `sections` row), and confirmation every
  migrated `users` row has a non-null `auth_user_id` and a `null` `password`.
- **Rollback**: staging is disposable — `staging_rollback_reset.sql` (now
  also drops `project_expenses` and the `update_updated_at()` function)
  resets the schema to empty, then 01-07 and the migration scripts re-run
  fresh. Because every insert is idempotent (section 4's checks generalize
  to every table in section 3, not just `users`), a partial failure can also
  be re-run in place without a full reset.

## 9. Build order (correction #6 — explicit gating)

Nothing gets built out of this order:

1. ~~Schema patch corrections~~ — done, this revision (section 1).
2. **You run the corrected 01-06 against staging and confirm
   `verify_staging_schema.sql` passes.** Waiting on you.
3. ~~`scripts/phase4-00-preflight.ts` (section 6)~~ — built, statically
   type-checked, not yet executed. Handed to you for review; see
   `scripts/README.md` for run instructions. Nothing was written to either
   database.
4. ~~`scripts/phase4-01-migrate-auth-users.ts` (sections 2-4)~~ — built,
   statically type-checked, not yet executed. Dry-run by default; requires
   `--execute` to write anything. See `scripts/README.md` for usage and
   rollback guidance. Nothing was written to either database.
5. `scripts/phase4-02-migrate-tables.ts` (section 3).
6. `scripts/phase4-03-verify-migration.ts` (sections 7-8).

Each handed over separately for review, none run until you say so — no
script beyond the preflight gets written until you've confirmed step 2.

## 10. Risks / open questions still worth flagging

- **`expense_claims` has both `rejection_comment` and `rejection_reason`
  live** (already flagged in Phase 2D) — migration will copy both as-is; no
  attempt to merge or pick one.
- **`revenue` has no FK, no unique constraint, and was never fully
  live-column-confirmed** (still true even after finding the original
  `supabase_setup.sql` — that file predates this table). If the live table
  has columns beyond what Phase 3 Step 2 guessed, the migration script's
  `select *` will surface that immediately as an insert failure.
- **`EXPECTED_DEST_PROJECT_REF` isn't filled in anywhere yet** — I don't have
  the staging project's real reference ID recorded in this repo. You'll need
  to supply it in `.env.phase4.local` before the preflight script can run.
