# Migration scripts

## migrate-users-to-auth.ts

One-off script that creates a Supabase Auth user for every row in the `users`
table and writes the resulting `auth.users.id` back into `users.auth_user_id`.

**Run this exactly once, locally, before using the new React app.**

### Prerequisites

1. Get the **service role key** from Supabase Dashboard → Settings → API →
   `service_role` secret. This key bypasses Row-Level Security and grants full
   database access — treat it like a root password.

2. Install `tsx` if you don't have it:  
   ```
   npm install -g tsx
   ```
   Or use `npx tsx` (no global install needed).

### How to run

```bash
SUPABASE_SERVICE_ROLE_KEY=eyJ... npx tsx scripts/migrate-users-to-auth.ts
```

The script is **idempotent** — rows that already have `auth_user_id` set are
skipped, so it's safe to re-run if something fails partway through.

### Security rules — do not break these

- **Never** commit the service role key to git.
- **Never** put it in `.env` (the frontend `.env` is bundled by Vite and
  ships to browsers; the service role key must never reach the browser).
- **Never** import or use this script from any code that gets deployed.
- After migration is complete and verified, you can delete the key from your
  terminal history (`history -d <line>` in bash or `fc -p` in zsh).

## phase4-00-preflight.ts

Read-only safety gate for Phase 4 (the JSR → JSR Network Tracker React data
migration). Run this before any migration script and confirm it prints
**PASS** before proceeding. It performs **zero writes** to either database:
no inserts, updates, deletes, or Auth user creation — checks only.

It verifies:

1. The source project is the original live JSR project
   (`tltbkjvrhqsxdspdfeqk`) and the destination is the new JSR Network
   Tracker React staging project — and that source and destination aren't
   accidentally the same project.
2. All required destination tables exist.
3. All required columns exist on each of those tables.
4. The destination's migrated-data tables are empty (so migration can't
   silently double-insert).
5. `auth.users` on the destination is empty (so migration can't collide with
   pre-existing Auth accounts).

It does **not** re-check NOT NULL constraints, FK cascade behavior, trigger
existence, or index shape — those are already covered by
`docs/phase3-staging-schema/verify_existing_staging_patch.sql` and
`verify_staging_schema.sql`, so this script isn't duplicating that work.

### Prerequisites

Create a gitignored `.env.phase4.local` file (covered by the `*.local`
pattern in `.gitignore`) in the repo root with:

```
SOURCE_SUPABASE_URL=https://tltbkjvrhqsxdspdfeqk.supabase.co
SOURCE_SUPABASE_SERVICE_ROLE_KEY=eyJ...
DEST_SUPABASE_URL=https://<staging-project-ref>.supabase.co
DEST_SUPABASE_SERVICE_ROLE_KEY=eyJ...
EXPECTED_SOURCE_PROJECT_REF=tltbkjvrhqsxdspdfeqk
EXPECTED_DEST_PROJECT_REF=<staging-project-ref>
```

See `docs/phase4-migration/PHASE4_MIGRATION_PLAN.md` section 5 for the full
credential-source rationale.

### How to run

```bash
npx tsx scripts/phase4-00-preflight.ts
```

The script prints a per-check PASS/WARN/FAIL report and exits with code `0`
only if every check passed (exit `1` on any FAIL). Re-run it as many times as
needed — it's fully read-only and safe to repeat.

If you're deliberately resuming a partially-completed migration and expect
the migrated tables to already hold some rows, set `ALLOW_RESUME=true` to
downgrade "table must be empty" failures to warnings instead of failures:

```bash
ALLOW_RESUME=true npx tsx scripts/phase4-00-preflight.ts
```

### Security rules — do not break these

- **Never** commit `.env.phase4.local` or any service role key to git.
- **Never** put Phase 4 credentials in the frontend `.env` or any file that
  ships to the browser.
- **Never** print a service role key to the console, a report, or a commit
  message — this script never logs key values, only PASS/WARN/FAIL results.
- This script performs no writes and creates no Auth users; if a future
  Phase 4 script needs to do either, that is out of scope for this file.

## phase4-01-migrate-auth-users.ts

Migrates old JSR's `public.users` rows into the destination staging
project: creates one Supabase Auth user per source user (email
`username@jsr.internal`), and inserts/updates the matching destination
`public.users` row with `password = null` and `auth_user_id` populated.

**Run `phase4-00-preflight.ts` first and confirm `PREFLIGHT: PASS`** before
running this script at all.

This script touches only the destination `public.users` table and the
destination's Auth users. It never touches any other table and never
enables or modifies Row-Level Security. The source project is read-only —
only `id, username, password, full_name, role, permissions, created_at` are
read from it, nothing is ever written back.

### Dry run vs execute

The script defaults to a **dry run**: it reads both projects (including the
destination's existing Auth users) and prints exactly what it would do for
every source user, but makes zero writes. Nothing is created, inserted, or
updated unless you pass `--execute`.

```bash
# Dry run — prints the full plan, writes nothing
npx tsx scripts/phase4-01-migrate-auth-users.ts

# Execute — performs the writes described in the dry-run output
npx tsx scripts/phase4-01-migrate-auth-users.ts --execute
```

### Expected output

Dry run prints one line per source user tagged with the action it would
take — `SKIP` (already fully migrated), `LINK` / `LINK+CREATE` (destination
row exists but is missing `auth_user_id`), `INSERT` / `INSERT+CREATE`
(destination row doesn't exist yet) — followed by a plan summary with
counts for each category, and a reminder of scope (only `public.users` +
Auth on the destination). It ends with:

```
DRY RUN complete — no writes were made. Re-run with --execute to apply.
```

Execute mode prints the same per-user lines with real outcomes (`OK`,
`LINK`, or `FAIL`), followed by an execute summary (created / reused /
inserted / linked / skipped / failed counts) and exits non-zero if any user
failed.

### Idempotency / resuming

Safe to run any number of times, including after a partial failure or
`Ctrl-C` mid-run. Every source user is independently classified before any
write happens, based on what already exists in the destination:

- a destination `users` row for that id already has `auth_user_id` set →
  skipped entirely;
- a destination `users` row exists but `auth_user_id` is null → the
  existing (or newly created) Auth user is linked to that row, no duplicate
  row is inserted;
- no destination row exists yet, but an Auth user for that email already
  exists → that Auth user is reused, no duplicate Auth account is created;
- neither exists → both are created fresh.

Never more than one Auth account per `username@jsr.internal`, and a
`users` row is inserted at most once per preserved source `id`, regardless
of how many times you run this script.

### Rollback guidance

Staging is disposable. To undo a run against the destination staging
project only (never against old JSR):

1. In the Supabase Dashboard for the **staging** project (double-check the
   project ref before doing anything) → Authentication → Users, delete the
   Auth users this script created. Cross-reference against the
   `auth_user_id` values printed in this script's own output, or re-run in
   dry-run mode afterward to see which `username@jsr.internal` accounts
   still resolve.
2. Run `docs/phase3-staging-schema/staging_rollback_reset.sql` to reset the
   schema (including `public.users`) to empty, or manually
   `delete from public.users where auth_user_id is not null` if you want to
   keep other staging data.
3. Re-run 01-07 (or just confirm the schema is already correct) and re-run
   this script from a clean state.

This script never touches old JSR (source) in any way, so there is nothing
to roll back there.

### Security rules — do not break these

- **Never** commit `.env.phase4.local` or print a service role key.
- **Never** log, write to a file, or store in any destination column the
  plaintext password read from source — it is used exactly once, in memory,
  as the `password` argument to `supabase.auth.admin.createUser()`.
- **Never** run this against any destination other than the intended
  staging project — the script's own identity guard refuses to proceed if
  `EXPECTED_SOURCE_PROJECT_REF`/`EXPECTED_DEST_PROJECT_REF` don't match, or
  if the destination resolves to old JSR or TAC's project, but this is a
  second line of defense, not a substitute for running preflight first and
  double-checking `.env.phase4.local` yourself.

## phase4-02-migrate-tables.ts

Migrates 16 application data tables from old JSR → destination in
dependency-safe tier order. Run only after `phase4-01` completes with
0 failures. Source is strictly read-only throughout.

**Tables migrated (16 total):**

| Tier | Tables |
|------|--------|
| 0 — no FK dependencies | `team_members`, `clients`, `sections`, `activity_log`, `general_expenses`, `daily_activities`, `revenue`, `project_expenses` |
| 1 — depends on Tier 0 / `users` | `employee_documents`, `expense_claims`, `salary_adjustments`, `push_subscriptions`, `invoices`, `rows` |
| 2 — depends on Tier 1 | `invoice_items`, `invoice_payments` |

**Tables intentionally NOT migrated here:**
`users` (Step 1), `expenses` / `expense_budgets` / `work_log` (legacy/unused),
`sites`, `app_settings`, `projects`, `saved_points`, `cars`, `field_trips`,
`trip_participants`, `attendance` (React-only / seed tables).

### How to run

```bash
# Dry run — validates schemas and FKs, prints plan, writes nothing
npx tsx scripts/phase4-02-migrate-tables.ts

# Execute — performs the inserts described in the dry-run output
npx tsx scripts/phase4-02-migrate-tables.ts --execute
```

### Expected output

**Dry run** prints:
1. Per-table schema validation (`[OK] tablename` for each of the 16 tables).
2. Per-table plan: source row count, rows to insert, rows already present (skip).
3. A summary table with columns: Table / Source / ToInsert / Inserted / Skipped / Failed.
4. `DRY RUN complete — no writes were made. Re-run with --execute to apply.`

**Execute** prints the same plan output, then progress lines as batches are
inserted, then a summary table with actual Inserted / Skipped / Failed counts.
Exits 0 on full success, 1 if any row failed.

### Idempotency / resuming

Safe to re-run any number of times, including after `Ctrl-C` or a partial
failure. Before writing any table, the script fetches all `id` values currently
in the destination table and skips any source row whose `id` already exists.
Re-running after a failure resumes from where it left off — no duplicates are
ever inserted, regardless of where the previous run stopped.

To resume after a partial failure, just re-run with `--execute`. The already-
migrated rows will be detected and skipped automatically.

### Rollback guidance

Staging is disposable. To undo a partial or complete run:

1. Run `docs/phase3-staging-schema/staging_rollback_reset.sql` in the
   Supabase SQL editor for the **destination** staging project. This drops
   and recreates all tables from scratch (schema only, no data).
2. Re-apply the staging schema patches (`01`–`07` SQL files).
3. Re-run `phase4-01-migrate-auth-users.ts --execute` (Step 1).
4. Re-run `phase4-02-migrate-tables.ts --execute` (this script, Step 2).

The source (old JSR) is never touched by any Phase 4 script — nothing to
roll back there.

### Pre-write validation

Before any rows are inserted the script runs two layers of validation and
aborts immediately on any failure:

1. **Schema check (upfront, all 16 tables):** Verifies every expected column
   exists on both source and destination using a zero-row HEAD query. A single
   missing column stops the entire script before any data moves.

2. **FK check (per table, just before writing):** Collects all non-null FK
   values from source rows and confirms they exist in the relevant parent table.
   In dry-run mode the check runs against source (data-quality sanity check).
   In execute mode it runs against destination after the parent tier has been
   migrated (confirms no orphaned rows would be inserted). FK risk detected →
   entire script stops immediately.

### Security rules — do not break these

- **Never** commit `.env.phase4.local` or any service role key to git.
- **Never** run this script against any destination other than the intended
  staging project — the identity guard rejects mismatches, old-JSR, and TAC
  refs at startup.
- This script never modifies source data, never creates Auth users, and never
  enables or modifies Row-Level Security on any table.
