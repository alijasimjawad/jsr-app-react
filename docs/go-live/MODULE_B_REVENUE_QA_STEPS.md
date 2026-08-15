# Module B — Revenue: Manual QA Test Steps

**Date written:** 2026-08-15  
**Env:** JSR React staging — `qaqxoakjnyivuegsopha`  
**Checklist ref:** `FULL_CRUD_QA_CHECKLIST.md` tests 4.1–4.11

---

## Prerequisites

- Module A (Network Scopes) complete — PASS
- Logged in as admin
- zain/ftk section is intentionally retired (`is_deleted = true`) — do NOT restore it; use IPT or MRC sections for Revenue tests that require an active section with rows
- Note any IDs of rows you insert during testing so you can delete them in cleanup

---

## Test Steps

### 4.1 — Load the Revenue page

1. Navigate to **Finance → Revenue**
2. Observe: table renders, no error banner

**Expected:** Migrated revenue rows visible. At minimum the 2 Phase 4 backfill rows (one for Jan 2026, one for Feb 2026) should appear. Columns present: project, section, site ID, amount, invoice date, status. Zain rows may be absent (zain/ftk retired — this is expected and correct).

---

### 4.2 — Filter by project

1. Open the project filter dropdown
2. Select **IPT** → confirm only IPT revenue rows shown
3. Select **MRC** → confirm only MRC rows shown
4. Clear filter → all rows return

**Expected:** Filter is precise; no cross-project row leakage. Zain not appearing when Zain is selected is acceptable if no active zain sections have revenue rows.

---

### 4.3 — Filter by month + year

1. Set month = **January**, year = **2026**
2. Confirm rows appear (Phase 4 backfill row for Jan 2026 should be visible)
3. Change to a month with no data (e.g. April 2025) → table empty or shows only correct rows

**Expected:** Only rows matching the selected period shown; switching months updates the view immediately.

---

### 4.4 — Add new revenue entry: project → section → site picker

1. Click **Add Revenue** (or equivalent)
2. Select project: **IPT**
3. Select section: **FTK** → section dropdown must populate
4. Open the site-ID picker → list of site IDs from ipt/ftk rows must appear
5. Select any site ID from the list
6. Fill in: amount = `1000`, invoice date = today, status = `pending`
7. Confirm the form loaded without any console error (no `rows.is_deleted` 400 error)

**Expected:** No errors. Section and site pickers both populate correctly. (P1-A fix covers this — verified.)

---

### 4.5 — Save new revenue entry

*(Continuing from 4.4)*

1. Click **Save** / **Confirm**
2. Row appears immediately in the Revenue table
3. Verify fields: project = IPT, section = FTK, site ID matches selection, amount = 1000, status = pending, added_by = your user name

**Expected:** Row inserted. All fields set. Note the row for cleanup in 4.8.

---

### 4.6 — Edit an existing revenue row

1. Find the row created in 4.5
2. Click **Edit**
3. Change amount to `1500`, status to `invoiced`
4. Save
5. Reload the page and confirm changes persisted

**Expected:** Correct row updated; change survives reload.

---

### 4.7 — Quick-edit amount inline *(if available)*

1. Find a revenue row in the table
2. Click directly on the amount cell (if inline editing is available)
3. Change the value and press Enter or click away

**Expected:** Amount updates without opening the full modal. Persists on reload.

*If no inline editing exists, mark this test N/A.*

---

### 4.8 — Delete a revenue row

1. Find the test row created in 4.5
2. Click **Delete**
3. Confirm the deletion dialog (if shown)
4. Row disappears from table

**Expected:** Row removed. Confirmation prompt shown before deletion. `revenue` count decreases.

---

### 4.9 — Sync from Network Scopes

1. Find the **Sync from Network Scopes** button (may be labelled "Import from Scopes" or similar)
2. Select project: **IPT**, section: **FTK**
3. Run the sync
4. Observe: new site IDs from ipt/ftk rows appear as pending revenue entries
5. Run sync again for the same section → confirm no duplicates created for already-synced `project_name + site_id` pairs

**Expected:** Only net-new site IDs are inserted. Existing `project + site_id` combinations are skipped (no duplicates).

*Do not test with Zain — zain/ftk is intentionally retired.*

---

### 4.10 — Revenue stage display

1. Find a revenue row linked to a section that has stage columns (e.g. mrc/ftk now has: Delivery, Installation, Integration Status, Clearance & Tools, Final ATP)
2. If no such rows exist: add a row to mrc/ftk via Network Scopes (test 2.6 procedure), then add a corresponding revenue entry for that site
3. On the Revenue page, observe the stage or pipeline column

**Expected:** Stage percentage derives correctly from `rows.data` values. Multipliers: Delivery = 15%, Installation = 50%, Integration = 70%, ATP = 85%, Final ATP = 100%.

*If no section has stage data populated yet, mark as deferred until mrc/ftk rows are added.*

---

### 4.11 — Export to XLSX

1. Apply a filter (e.g. project = IPT, month = August 2026)
2. Click **Export**
3. Open the downloaded XLSX file
4. Verify: all filtered rows present, column headers correct, site IDs preserved as strings (not auto-converted to numbers by Excel)

**Expected:** Clean download with correct data. No extra or missing columns.

---

## Cleanup

After completing all tests:
- Delete any revenue rows inserted during 4.5 (4.8 covers this if done in order)
- Delete any revenue rows inserted by the 4.9 sync that you don't want to keep — or leave them if they represent real data

---

## Notes

- zain/ftk (e8ee675d) is intentionally retired (`is_deleted = true`). Its 467 rows are preserved in the DB for historical reference. Revenue tests that previously required an active zain/ftk section (e.g. 4.9 sync) should use IPT or MRC instead.
- mrc/ftk (bda26ffb) now has 10 columns (5 original + 5 custom added during Module A QA). Zero rows currently. Suitable for adding test rows if needed for 4.10.
- P1-A fix (no `rows.is_deleted` 400 error) was verified in prior session and covers test 4.4.
