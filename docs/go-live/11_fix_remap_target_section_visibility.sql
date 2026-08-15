-- docs/go-live/11_fix_remap_target_section_visibility.sql
--
-- !! SUPERSEDED — DO NOT APPLY !!
--
-- This patch was written to restore zain/ftk (e8ee675d) to is_deleted=false.
-- It is no longer needed and must NOT be applied.
--
-- Reason:
--   The zain/ftk section (e8ee675d) was intentionally retired by the business
--   owner (Ali Jasim) on 2026-08-15 during Module A QA. This is a deliberate
--   business decision, not an accidental deletion. The section's 467 linked rows
--   are preserved in the database for historical/reference purposes.
--
-- Final state (correct, do not change):
--   sections.id          = e8ee675d-3990-402a-aeb5-0ddbfc66c53a
--   sections.is_deleted  = true   ← intentional, permanent
--   rows linked to it    = 467    ← preserved, NOT hard-deleted
--
-- Scope:
--   This file is retained for audit trail only.
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to JSR React staging: qaqxoakjnyivuegsopha

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
