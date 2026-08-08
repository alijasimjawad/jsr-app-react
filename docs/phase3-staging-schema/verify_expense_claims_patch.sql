-- ============================================================================
-- Read-only verification for 10_patch_expense_claims_car_trip.sql
-- ============================================================================
-- Run this AFTER 10_patch_expense_claims_car_trip.sql to confirm every
-- column was added successfully. Makes zero writes — SELECT only.
-- Expected: 5 rows returned, one per added column.
-- ============================================================================

-- 1. Confirm all 5 new columns exist in information_schema
SELECT
  column_name,
  data_type,
  column_default,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'expense_claims'
  AND column_name  IN (
    'is_car_trip',
    'daily_activity_id',
    'car_id',
    'car_trip_distance_km',
    'car_trip_rate_iqd'
  )
ORDER BY column_name;

-- Expected output (5 rows):
--   car_id               | uuid    | (null)       | YES
--   car_trip_distance_km | numeric | (null)       | YES
--   car_trip_rate_iqd    | numeric | (null)       | YES
--   daily_activity_id    | uuid    | (null)       | YES
--   is_car_trip          | boolean | false        | YES

-- 2. Confirm existing row count is unchanged (no data loss)
SELECT count(*) AS total_expense_claims FROM public.expense_claims;

-- 3. Confirm FK constraints are present for the two FK columns
SELECT
  kcu.column_name,
  ccu.table_name  AS references_table,
  rc.delete_rule
FROM information_schema.table_constraints       tc
JOIN information_schema.key_column_usage        kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema    = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
 AND tc.table_schema    = ccu.table_schema
JOIN information_schema.referential_constraints rc
  ON tc.constraint_name = rc.constraint_name
 AND tc.constraint_schema = rc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema    = 'public'
  AND tc.table_name      = 'expense_claims'
  AND kcu.column_name    IN ('daily_activity_id', 'car_id')
ORDER BY kcu.column_name;

-- Expected output (2 rows):
--   car_id             | cars              | SET NULL
--   daily_activity_id  | daily_activities  | SET NULL
