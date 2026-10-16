-- docs/go-live/25_expense_claims_resubmit_rejected.sql
--
-- Purpose: Let a field user (technician etc.) edit and RESUBMIT their own
--          REJECTED expense claim.
--
-- Bug: "Edit & Resubmit" on a rejected claim reported success but the claim
--      stayed Rejected. Cause: rls_hardening.sql's
--      "expense_claims_update_own_pending" policy only allows non-admins to
--      update rows whose current status = 'pending', so an UPDATE on a
--      rejected row matched ZERO rows — Postgres/RLS returns no error for
--      that, so the app showed "resubmitted successfully" while nothing
--      changed.
--
-- Fix: widen the policy's USING clause to status IN ('pending','rejected').
--      WITH CHECK is unchanged (status must be 'pending' after the update),
--      so a user still can't self-approve or leave a claim rejected/approved
--      via the API. Approved claims remain locked for non-admins.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Idempotent (DROP POLICY IF EXISTS + CREATE). File only — run it yourself
-- in the JSR React project's Supabase SQL Editor.

drop policy if exists "expense_claims_update_own_pending" on public.expense_claims;

create policy "expense_claims_update_own_pending" on public.expense_claims
  for update to authenticated
  using (
    member_id = public.jsr_current_team_member_id()
    and status in ('pending', 'rejected')
    and not public.jsr_is_admin()
  )
  with check (
    member_id = public.jsr_current_team_member_id()
    and status = 'pending'
  );

-- Verification: expect 1 row, cmd = UPDATE.
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'expense_claims'
  and policyname = 'expense_claims_update_own_pending';
