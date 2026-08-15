-- docs/go-live/14_revenue_is_orphaned.sql
--
-- Purpose: Add is_orphaned boolean column to public.revenue.
--
-- WHY: Revenue rows whose site has been deleted from Network Scopes need to be
--      flagged rather than deleted, so financial history is preserved.
--      is_orphaned = true means the linked site no longer exists in Network Scopes.
--      is_orphaned = false (default) means the site is active.
--
--      When a site is re-added with the same (project_name, site_id), the code
--      reactivates the row (is_orphaned → false) instead of inserting a duplicate,
--      preserving all accumulated financial data.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Idempotent — safe to re-run (IF NOT EXISTS guard).
-- Applied: 2026-08-15 via supabase db query --linked

ALTER TABLE public.revenue
  ADD COLUMN IF NOT EXISTS is_orphaned boolean NOT NULL DEFAULT false;

-- Verification
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'revenue'
  AND column_name  = 'is_orphaned';
-- Expected: one row, data_type='boolean', is_nullable='NO', column_default='false'
