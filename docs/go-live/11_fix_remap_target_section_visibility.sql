-- docs/go-live/11_fix_remap_target_section_visibility.sql
--
-- Purpose: Restore visibility of the zain/ftk section (e8ee675d) in JSR React
-- staging. This section is the FK target for 467 `rows` that were remapped from
-- the source section 55f63cb0 (zain/ftk soft-deleted dup) during Phase 4 migration.
-- It was accidentally soft-deleted during staging cleanup, making those 467 rows
-- invisible in Network Scopes.
--
-- Background:
--   Phase 4 migration (phase4-02) remapped rows whose section_id was
--   55f63cb0 (zain/ftk, soft-deleted dup) to e8ee675d (zain/ftk, active).
--   After migration, the staging database was cleaned up and e8ee675d was
--   accidentally marked is_deleted=true. This hides all 467 remapped rows
--   from Network Scopes queries that filter out deleted sections.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Apply via the Supabase SQL editor on the JSR React staging project.
-- This patch is idempotent — safe to re-run.

-- ── Step 1: Read-only check — confirm current state before patching ────────────
SELECT
  id,
  project_name,
  section_name,
  section_label,
  is_deleted,
  (
    SELECT COUNT(*)
    FROM rows
    WHERE section_id = 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'
  ) AS dependent_row_count
FROM sections
WHERE id = 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a';
-- Expected before patch:
--   is_deleted = true
--   dependent_row_count = 467 (approximately — more if new rows were synced)

-- ── Step 2: Idempotent patch ───────────────────────────────────────────────────
-- Guard clauses (project_name, section_name, is_deleted=true) ensure the UPDATE
-- is a no-op if already applied or if the row doesn't match expectations.
UPDATE public.sections
SET    is_deleted = false
WHERE  id           = 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'
  AND  project_name = 'zain'
  AND  section_name = 'ftk'
  AND  is_deleted   = true;
-- Expected: UPDATE 1
-- If UPDATE 0: section was already visible (is_deleted already false) — no action needed.

-- ── Step 3: Post-patch verification ───────────────────────────────────────────
SELECT
  id,
  project_name,
  section_name,
  section_label,
  is_deleted,
  (
    SELECT COUNT(*)
    FROM rows
    WHERE section_id = 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a'
  ) AS dependent_row_count
FROM sections
WHERE id = 'e8ee675d-3990-402a-aeb5-0ddbfc66c53a';
-- Expected after patch:
--   is_deleted = false
--   dependent_row_count = same as before (rows unchanged)
--   The zain/ftk section and all its rows will now be visible in Network Scopes.
