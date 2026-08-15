# Phase 4.5 — Full Delta Sync Audit

**Script:** `scripts/phase4-06-audit-delta-sync.ts`  
**Status:** READ-ONLY audit — no writes, no schema changes, no RLS changes  
**Purpose:** Identify every row that is missing, extra, or changed between old JSR production and new JSR React staging before go-live delta sync.

---

## Background

The original Phase 4 migration ran on **2026-08-04**. Since then, old JSR production has continued receiving live business data. This audit compares the current state of both databases so the delta sync script (Phase 4.6, not yet built) can apply only the rows that need INSERT or UPDATE — nothing more.

### Known Migration History (preserved in audit comparisons)

| Fact | Detail |
|------|--------|
| 10 sections excluded | UNIQUE(project_name, section_name) collisions — intentionally absent from dest, not counted as missing |
| 2 section_id remaps | `rows.section_id`: 55f63cb0→e8ee675d (467 rows), b393a48e→3d88c00c (4 rows) — not counted as changed |
| Revenue 5-col backfill | phase4-04 backfilled `section_name`, `invoice_date`, `status`, `notes`, `added_by` for all originally-migrated revenue rows |
| 2 post-migration revenue inserts | phase4-05 inserted `afae4065` and `50f353e4` (created 2026-08-05) — both should exist in source and dest |
| `users.password` | intentionally NULL in destination — never fetched or compared |
| `users.auth_user_id` | destination-only React Auth column — never compared |
| `team_members.username` | destination-only column (source had none) — never compared |
| `expense_claims` car-trip cols | 5 destination-only columns (`is_car_trip`, `daily_activity_id`, `car_id`, `car_trip_distance_km`, `car_trip_rate_iqd`) — never compared |

---

## Scope

### Tables Audited (17 total)

| Tier | Tables |
|------|--------|
| **Tier 0** — no FK deps | `users`, `team_members`, `clients`, `sections`, `activity_log`, `general_expenses`, `daily_activities`, `revenue`, `project_expenses` |
| **Tier 1** — FK → Tier 0 | `employee_documents`, `expense_claims`, `salary_adjustments`, `push_subscriptions`, `invoices`, `rows` |
| **Tier 2** — FK → Tier 1 | `invoice_items`, `invoice_payments` |

### Tables Explicitly Out of Scope

| Table | Reason |
|-------|--------|
| `expenses` | Legacy — superseded by `project_expenses` / `expense_claims`; not used by React app |
| `expense_budgets` | Legacy — not used by React app |
| `work_log` | Legacy — no FK constraints in staging schema; not used by React app |
| `sites`, `app_settings`, `projects`, `saved_points` | React-only / seed tables — no source equivalent in old JSR |
| `cars`, `field_trips`, `trip_participants`, `attendance` | React-only — no source equivalent |

The audit script checks row counts for the legacy tables as an informational note.

---

## How to Run

```bash
# From the repo root:
source .env.phase4.local        # loads service-role keys for both projects
npx tsx scripts/phase4-06-audit-delta-sync.ts
```

No flags required. The script is always read-only — there is no `--execute` mode.

### Prerequisites

- `.env.phase4.local` must be present at the repo root with all four vars set:
  - `SOURCE_SUPABASE_URL` — old JSR production project URL
  - `SOURCE_SUPABASE_SERVICE_ROLE_KEY` — old JSR service-role key
  - `DEST_SUPABASE_URL` — JSR React staging project URL
  - `DEST_SUPABASE_SERVICE_ROLE_KEY` — JSR React staging service-role key
- `npx tsx` (ships with Node ≥18; `@supabase/supabase-js` already in devDependencies)

### Output

The script produces:
1. **Console** — human-readable summary table (counts per table) + per-table detail for all tables with deltas or warnings.
2. **`scripts/delta-sync-report.json`** — machine-readable JSON with full ID lists for every missing, extra, or changed row. Contains business IDs only — no passwords, no service-role keys.

> `delta-sync-report.json` is gitignored. Do not commit it.

---

## Reading the Summary Table

| Column | Meaning |
|--------|---------|
| **Source** | Row count in old JSR production |
| **Dest** | Row count in JSR React staging |
| **Excl** | Source rows in the known `skipSourceIds` set — intentionally absent from dest |
| **Missing** | Source rows not in dest (excluding excluded) — require INSERT in sync |
| **Changed** | IDs present in both but with ≥1 column value difference — require UPDATE in sync |
| **Extra** | Dest rows not in source at all — may be seed data, staging test rows, or React-only rows |
| **Action** | `+N INSERT`, `~N UPDATE`, or `NO ACTION` |

### Interpretation Notes

- **Missing** rows with `created_at > 2026-08-04` are marked `← post-migration new row` in the detail section — these are production rows created after the original migration.
- **Missing** rows with no `created_at` label were either missed during migration or belong to tables without a timestamp column.
- **Changed** rows indicate the source has been updated since migration. The delta sync will UPDATE the destination to match source values for the compared columns only.
- **Extra** rows in destination are **not deleted** during the sync — they may represent legitimate staging data or React-only functionality.

---

## FK Dependency Detection

For each table with FK constraints, the audit checks whether the parent row already exists in the destination for every missing source row. If a parent is also missing, a warning is printed:

```
⚠  FK member_id→team_members: N of M missing rows have a parent not yet in dest — must insert team_members first
```

This confirms the sync must follow the **Tier 0 → Tier 1 → Tier 2** order to avoid FK violations.

---

## Proposed Dependency-Safe Sync Order

```
Tier 0: users, team_members, clients, sections, activity_log,
        general_expenses, daily_activities, revenue, project_expenses

Tier 1: employee_documents, expense_claims, salary_adjustments,
        push_subscriptions, invoices, rows

Tier 2: invoice_items, invoice_payments
```

Within each tier, tables can be synced in any order. Tiers must be sequential.

---

## Columns Compared Per Table

Only columns that represent production business data are compared. Destination-only columns (React Auth columns, React-specific schema extensions) are excluded.

| Table | Excluded from comparison | Reason |
|-------|--------------------------|--------|
| `users` | `password`, `auth_user_id`, `phone`, `national_id`, `date_of_birth`, `address`, `emergency_contact_name`, `emergency_contact_phone`, `start_date`, `notes`, `profile_photo_url` | password=NULL in dest by design; auth_user_id and 9 profile cols are dest-only |
| `team_members` | `username` | Destination-only column; source had no `username` field |
| `expense_claims` | `is_car_trip`, `daily_activity_id`, `car_id`, `car_trip_distance_km`, `car_trip_rate_iqd` | Destination-only schema extension for car-trip feature |

---

## Next Step

After reviewing the audit results, the delta sync writer (`phase4-07-delta-sync.ts` — not yet built) will:

1. Read the `delta-sync-report.json` produced by this audit.
2. For each table in tier order: INSERT missing rows, UPDATE changed rows.
3. Apply the known `sections` remaps when inserting `rows`.
4. Skip the 10 excluded section IDs.
5. Never write to the source database.
6. Never enable RLS, never modify schema.

**Do not build or execute the sync writer until the audit results have been reviewed and approved.**

---

## Audit Run History

| Date | Commit | Total Missing | Total Changed | Notes |
|------|--------|--------------|--------------|-------|
| — | — | — | — | Initial audit script created; not yet run |
| 2026-08-15 | bef2de3 | 88 | 32 | First audit run; 47 extra in dest (staging data) |
| 2026-08-15 | ac9b29f | — | — | Phase 4.7 delta sync applied (87 INSERT, 31 UPDATE); 16/16 tables verified PASS |
