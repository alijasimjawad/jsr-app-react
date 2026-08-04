# How to run the JSR production schema audit

This explains how to run `docs/jsr_production_schema_audit_readonly.sql`
yourself. Nothing in that file was executed by Claude — it only reads
database metadata and row counts, and it must be run manually by you,
directly in the Supabase dashboard, against JSR's real project.

## 1. Verify you're in the right project before running anything

JSR's real Supabase project reference is **`tltbkjvrhqsxdspdfeqk`**. This is
different from TAC's project (`gauejhgitzcqjvzalshf`), which is what
`jsr-app-react`'s own `.env` was pointed at until the Phase 2A cleanup.

Before running any part of the SQL file:

1. Log into <https://supabase.com/dashboard>.
2. Open the project switcher (top left) and select the JSR project.
3. Check the URL in your browser — it should read
   `https://supabase.com/dashboard/project/tltbkjvrhqsxdspdfeqk/...`.
   If the ref in the URL doesn't say `tltbkjvrhqsxdspdfeqk`, stop — you're in
   the wrong project.
4. As a second check, go to **Settings → General** in that project and
   confirm the "Reference ID" field also reads `tltbkjvrhqsxdspdfeqk`.

Do this every time you open a SQL Editor tab, since it's easy to still have
a different project open from earlier work.

## 2. How to verify the SQL is read-only before running it

Before pasting anything into the SQL Editor:

- Open `docs/jsr_production_schema_audit_readonly.sql` and search it
  (Cmd+F) for each of these words: `CREATE`, `ALTER`, `DROP`, `INSERT`,
  `UPDATE`, `DELETE`, `TRUNCATE`, `GRANT`, `REVOKE`. None of them should
  appear anywhere in the file outside of this sentence and the file's own
  comments describing what it avoids.
- Every executable statement in the file starts with `select`. That's the
  only statement type used anywhere.
- Supabase's SQL Editor also has its own safety prompt that warns before
  running statements it detects as destructive — if that warning appears
  for any section of this file, stop and don't run it; that would mean
  something unexpected is in the query and it's worth re-checking the file
  before proceeding.

## 3. How to run it

The Supabase SQL Editor only shows the result of the **last** statement when
you run several at once. The file is split into clearly numbered sections
(0, 1, 2, 3, 4, 5, 6, 7, 8, 9a, 9b, 10, 11a, 11b, 11c) for exactly this
reason — run them one at a time:

1. Go to **SQL Editor → New query** in the JSR project (confirmed in step 1).
2. Open `docs/jsr_production_schema_audit_readonly.sql` locally.
3. Copy just one numbered section (including its comment header) and paste
   it into the editor.
4. Click **Run**.
5. Read/export the result grid (see step 4 below) before moving to the next
   section.
6. Repeat for each section in order. Run **11a before 9b and 11b** — 11a
   tells you which of the 12 named tables actually exist in this project,
   which determines whether 9b needs any lines commented out first.

## 4. How to export or copy results back for analysis

For each section's result grid in the SQL Editor:

- Use the **Download CSV** button above the results table (or the copy
  icon, if you'd rather paste directly), and save each section's export
  with a name that matches its section number, e.g.
  `2_columns.csv`, `7_rls_status.csv`, `8_policies.csv`, `11b_named_tables.csv`.
- Save these exports to a local, **non-git** folder on your machine (for
  example a new folder on your Desktop, not inside `jsr-app-react`) — they
  contain live production schema and policy details and shouldn't end up
  committed to the repo.
- Once you have the exports (or even just pasted text/screenshots), bring
  them back to this conversation and they can be reviewed together against
  the Phase 2B comparison matrix.

## What this does NOT do

- Does not expose the anon key, service-role key, any password, or the
  VAPID keys — none of those are queried anywhere in the SQL file.
- Does not expose any `auth.users` email addresses or identities — section
  10 only returns a count.
- Does not change any table, column, constraint, index, policy, grant, or
  row of data. Every statement is a `select`.
- Does not touch `jsr-app-react`'s code, `.env`, or its own (currently
  unconfigured) Supabase connection — this audit is run manually by you, in
  the Supabase dashboard, against JSR's production project directly.
