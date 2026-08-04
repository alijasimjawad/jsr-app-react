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
