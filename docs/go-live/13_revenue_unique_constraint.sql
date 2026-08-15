-- docs/go-live/13_revenue_unique_constraint.sql
--
-- Purpose: Add a partial unique index enforcing (project_name, site_id)
--          uniqueness on public.revenue, excluding NULL and blank site_ids.
--
-- WHY a partial unique INDEX rather than a full UNIQUE constraint:
--   Revenue rows manually entered without a site (site_id IS NULL or '') are valid
--   placeholders. PostgreSQL's NULL != NULL semantics would allow multiple NULLs
--   under a standard UNIQUE constraint, but empty strings '' would still conflict.
--   A partial index on (project_name, site_id) WHERE site_id IS NOT NULL AND site_id <> ''
--   cleanly excludes both cases and prevents duplicates only where they matter.
--
-- Safety protocol:
--   Step 1 runs a duplicate pre-check and RAISES EXCEPTION if any duplicates exist.
--   The constraint (Step 2) is only reached if Step 1 finds zero duplicates.
--   NEVER silently delete or merge duplicate rows — resolve them manually first.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Apply via the Supabase SQL editor. This file is idempotent (IF NOT EXISTS).

-- ── Step 1: Duplicate pre-check (read-only) ───────────────────────────────────
-- Aborts the entire transaction if any (project_name, site_id) duplicates exist.
-- Review the NOTICE output before proceeding to Step 2.
DO $$
DECLARE
  dup_count  integer;
  null_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT project_name, site_id
    FROM   public.revenue
    WHERE  site_id IS NOT NULL
      AND  site_id <> ''
    GROUP  BY project_name, site_id
    HAVING COUNT(*) > 1
  ) dups;

  SELECT COUNT(*) INTO null_count
  FROM public.revenue
  WHERE site_id IS NULL OR site_id = '';

  RAISE NOTICE '── Revenue uniqueness pre-check ────────────────────────────';
  RAISE NOTICE 'Duplicate (project_name, site_id) pairs: %', dup_count;
  RAISE NOTICE 'Rows with NULL or blank site_id:          %', null_count;
  RAISE NOTICE '(NULL/blank rows are excluded from the constraint and are safe)';

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      'ABORT: % duplicate (project_name, site_id) pair(s) found. '
      'Identify and resolve duplicates manually before creating the index. '
      'Query: SELECT project_name, site_id, COUNT(*) FROM public.revenue '
      'WHERE site_id IS NOT NULL AND site_id <> '''' '
      'GROUP BY project_name, site_id HAVING COUNT(*) > 1;',
      dup_count;
  END IF;

  RAISE NOTICE 'Pre-check PASSED — no duplicates found. Safe to create index.';
END $$;

-- ── Step 2: Create the partial unique index ───────────────────────────────────
-- IF NOT EXISTS makes this idempotent — safe to re-run if already applied.
CREATE UNIQUE INDEX IF NOT EXISTS revenue_proj_site_unique
  ON public.revenue (project_name, site_id)
  WHERE site_id IS NOT NULL
    AND site_id <> '';

-- ── Step 3: Post-create verification ─────────────────────────────────────────
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'revenue'
  AND indexname = 'revenue_proj_site_unique';
-- Expected: one row returned with a UNIQUE index definition.
-- If zero rows: index was not created (check Step 1 output for errors).
