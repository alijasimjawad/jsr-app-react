-- docs/go-live/17_fix_daily_activities_driver_fk.sql
--
-- Purpose: Correct daily_activities.driver_id FK target from users(id) → team_members(id).
--
-- WHY: The DailyActivities.tsx driver dropdown is populated from the
--      team_members table (loadTeamMembers() → select('id,...') from team_members).
--      When the user selects a driver, driverId = team_members.id.
--      SQL patch 16 incorrectly created the FK as:
--        daily_activities_driver_id_fkey → public.users(id)
--      But team_members.id and users.id are completely separate UUID sets
--      (0 overlap — confirmed 2026-08-15). Every save with a selected driver
--      fails with "violates foreign key constraint daily_activities_driver_id_fkey".
--
-- Safety guard: aborts if any existing driver_id value would violate the
--   new team_members FK (i.e. does not exist in team_members). If this check
--   fires, investigate and fix the data before re-running.
--   As of 2026-08-15, all daily_activities rows have driver_id = null, so the
--   guard always passes on current data.
--
-- Scope:
--   DESTINATION ONLY: JSR React staging — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + conditional ADD CONSTRAINT guard.
-- Applied: 2026-08-15 via supabase db query --linked

-- ── Step 1: Safety guard — abort if existing data would violate new FK ────────
DO $$
DECLARE
  bad_count integer;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM public.daily_activities da
  WHERE da.driver_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.team_members tm WHERE tm.id = da.driver_id
    );

  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'ABORT: % daily_activities row(s) have driver_id values not present in '
      'team_members. Fix the data before re-running this patch.',
      bad_count;
  END IF;
END $$;

-- ── Step 2: Drop the incorrect FK (users → team_members mismatch) ─────────────
ALTER TABLE public.daily_activities
  DROP CONSTRAINT IF EXISTS daily_activities_driver_id_fkey;

-- ── Step 3: Add the correct FK → team_members(id) ON DELETE SET NULL ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'daily_activities_driver_id_fkey'
      AND table_name = 'daily_activities'
      AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.daily_activities
      ADD CONSTRAINT daily_activities_driver_id_fkey
        FOREIGN KEY (driver_id)
        REFERENCES public.team_members(id)
        ON DELETE SET NULL;
  END IF;
END $$;

-- ── Step 4: Post-apply verification ──────────────────────────────────────────
-- Run after applying the above. Expected: 1 row.

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
  AND tc.table_name      = 'daily_activities'
  AND kcu.column_name    = 'driver_id';
-- Expected:
--   driver_id | team_members | id | SET NULL
