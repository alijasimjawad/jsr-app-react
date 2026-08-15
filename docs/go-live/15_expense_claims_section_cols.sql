-- docs/go-live/15_expense_claims_section_cols.sql
--
-- Purpose: Add section_id and section_label to public.expense_claims.
--
-- WHY: The MyExpenses.tsx form collects a section (FK to public.sections)
--      and its display label when an engineer submits an expense claim.
--      These two columns were present in the frontend payload but absent from
--      the DB, causing every new claim submission to fail with PGRST204
--      ("Could not find the 'section_id' column of 'expense_claims' in the
--      schema cache"). This is the P1 root cause.
--
-- Design decisions:
--   section_id   uuid FK → sections(id) ON DELETE SET NULL
--     Nullable — some claims may be submitted without a section (legacy data,
--     manual admin entry). ON DELETE SET NULL preserves the claim if a section
--     is ever retired; historical financial records must not be cascade-deleted.
--
--   section_label text (nullable, denormalised)
--     Stored alongside section_id so the admin view can display the label even
--     if the sections row is later renamed or retired. Denormalisation is
--     intentional for financial/audit records.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Idempotent — safe to re-run (IF NOT EXISTS guards on both statements).

-- ── Step 1: Add section_id (FK to sections, nullable, ON DELETE SET NULL) ────
ALTER TABLE public.expense_claims
  ADD COLUMN IF NOT EXISTS section_id uuid
    REFERENCES public.sections(id) ON DELETE SET NULL;

-- ── Step 2: Add section_label (denormalised text, nullable) ──────────────────
ALTER TABLE public.expense_claims
  ADD COLUMN IF NOT EXISTS section_label text;

-- ── Step 3: Post-apply verification ──────────────────────────────────────────
-- Run this block after applying the ALTER statements above.
-- Expected output: 2 rows (section_id + section_label), plus 1 FK row.

-- 3a. Column existence and types
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'expense_claims'
  AND column_name  IN ('section_id', 'section_label')
ORDER BY column_name;
-- Expected:
--   section_id    | uuid | YES | null
--   section_label | text | YES | null

-- 3b. FK constraint: section_id → sections(id), ON DELETE SET NULL
SELECT
  kcu.column_name,
  ccu.table_name  AS referenced_table,
  ccu.column_name AS referenced_column,
  rc.delete_rule
FROM information_schema.table_constraints      tc
JOIN information_schema.key_column_usage        kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
JOIN information_schema.referential_constraints rc  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name      = 'expense_claims'
  AND kcu.column_name    = 'section_id';
-- Expected:
--   section_id | sections | id | SET NULL
