-- docs/go-live/12_optional_atomic_import_rpc.sql
--
-- Optional enhancement: atomic section-row replacement via a Postgres RPC.
-- The current client-side fix uses a safe INSERT-first-then-DELETE pattern that
-- prevents data loss if INSERT fails. However, if INSERT succeeds and DELETE fails,
-- both old and new rows will exist (duplicates). This RPC wraps the operation in a
-- single Postgres transaction to eliminate that residual risk.
--
-- DO NOT execute this automatically. Apply via the Supabase SQL editor after review.
-- Requires the calling Supabase client to have EXECUTE permission on the function
-- (service-role or appropriate role). The React app would then call:
--   supabase.rpc('replace_section_rows', { p_section_id: '...', p_rows: [...] })
--
-- Status: OPTIONAL — the INSERT-first-then-DELETE client pattern already
-- provides acceptable safety for go-live. This RPC is a post-go-live enhancement.
--
-- Destination only: JSR React staging (qaqxoakjnyivuegsopha)
-- Never apply to old JSR production.

CREATE OR REPLACE FUNCTION public.replace_section_rows(
  p_section_id UUID,
  p_rows       JSONB   -- array of {data: {...}, row_order: N}
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Delete all existing rows for the section
  DELETE FROM public.rows WHERE section_id = p_section_id;

  -- Insert all new rows
  INSERT INTO public.rows (section_id, data, row_order)
  SELECT
    p_section_id,
    (r->>'data')::jsonb,
    (r->>'row_order')::int
  FROM jsonb_array_elements(p_rows) AS r;
END;
$$;

-- Grant execute to authenticated and service_role
GRANT EXECUTE ON FUNCTION public.replace_section_rows(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.replace_section_rows(UUID, JSONB) TO service_role;

-- Verification
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name = 'replace_section_rows';
-- Expected: 1 row with routine_name = replace_section_rows, routine_type = FUNCTION
