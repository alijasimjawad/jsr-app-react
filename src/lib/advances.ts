// src/lib/advances.ts
//
// Data layer for the Salary Advances (سلفة) feature.
// See docs/go-live/20_add_salary_advances.sql for the table/RLS design and
// the full write-up of the workflow this supports:
//   1. Admin opens an `advances` batch: total amount, assigned team leader,
//      target deduction month/year.
//   2. The team leader logs `advance_distributions` entries one at a time as
//      they hand out cash, until the batch's remaining balance hits zero.
//   3. Every recipient (including the leader) can see their own entries.
//   4. At payroll time: each recipient's net pay is reduced by what they
//      personally received for that month; the leader's net pay is
//      additionally reduced by whatever is left undistributed in their own
//      batches for that month. getMemberAdvanceDeductionForMonth() and
//      getLeaderUndistributedForMonth() below are the two functions
//      FinPayslips.tsx/FinReport.tsx call to compute that live.
//
// This repo doesn't have an established "CRUD lib" convention for finance
// tables (pages usually call supabase.from(...) directly) but advances needs
// its deduction math shared between the Advances page and the payroll pages,
// so it lives here instead of being duplicated inline.

import { supabase } from './supabase';

export interface Advance {
  id: string;
  team_leader_id: string;
  total_amount: number;
  month: number;
  year: number;
  reason: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AdvanceDistribution {
  id: string;
  advance_id: string;
  member_id: string;
  amount: number;
  entry_date: string;
  details: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AdvanceWithDistributions extends Advance {
  distributions: AdvanceDistribution[];
}

// ── Fetch ────────────────────────────────────────────────────────────────

// Admin: every batch. Team leader: RLS already restricts this to their own
// batches, so the same query works for both — just call it plainly.
export async function fetchAdvances(): Promise<Advance[]> {
  const { data, error } = await supabase
    .from('advances')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('fetchAdvances failed:', error.message, error);
    return [];
  }
  return (data as Advance[]) ?? [];
}

export async function fetchAdvancesWithDistributions(): Promise<AdvanceWithDistributions[]> {
  const advances = await fetchAdvances();
  if (advances.length === 0) return [];
  const ids = advances.map(a => a.id);
  const { data, error } = await supabase
    .from('advance_distributions')
    .select('*')
    .in('advance_id', ids)
    .order('entry_date', { ascending: false });
  if (error) console.error('fetchAdvancesWithDistributions (distributions) failed:', error.message, error);
  const dists = (data as AdvanceDistribution[]) ?? [];
  return advances.map(a => ({ ...a, distributions: dists.filter(d => d.advance_id === a.id) }));
}

// The signed-in member's own received distribution entries (any batch, any leader) —
// "how much did I get, when, for what". RLS restricts this to member_id = self anyway.
export async function fetchMyDistributions(memberId: string): Promise<AdvanceDistribution[]> {
  const { data, error } = await supabase
    .from('advance_distributions')
    .select('*')
    .eq('member_id', memberId)
    .order('entry_date', { ascending: false });
  if (error) {
    console.error('fetchMyDistributions failed:', error.message, error);
    return [];
  }
  return (data as AdvanceDistribution[]) ?? [];
}

export async function fetchDistributionsForAdvance(advanceId: string): Promise<AdvanceDistribution[]> {
  const { data, error } = await supabase
    .from('advance_distributions')
    .select('*')
    .eq('advance_id', advanceId)
    .order('entry_date', { ascending: false });
  if (error) {
    console.error('fetchDistributionsForAdvance failed:', error.message, error);
    return [];
  }
  return (data as AdvanceDistribution[]) ?? [];
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function createAdvance(payload: {
  team_leader_id: string;
  total_amount: number;
  month: number;
  year: number;
  reason?: string | null;
  created_by?: string | null;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advances').insert({
    team_leader_id: payload.team_leader_id,
    total_amount: payload.total_amount,
    month: payload.month,
    year: payload.year,
    reason: payload.reason ?? null,
    created_by: payload.created_by ?? null,
  });
  return { error: error ? error.message : null };
}

export async function updateAdvance(
  id: string,
  payload: Partial<Pick<Advance, 'total_amount' | 'month' | 'year' | 'reason' | 'team_leader_id'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advances').update(payload).eq('id', id);
  return { error: error ? error.message : null };
}

export async function deleteAdvance(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advances').delete().eq('id', id);
  return { error: error ? error.message : null };
}

// Remaining balance is computed client-side (total_amount - sum(distributions))
// rather than stored, so it's always live. Callers should re-fetch distributions
// for the batch right before calling this to avoid acting on a stale balance —
// the DB has no constraint stopping an over-distribution race between two tabs,
// this is a UI-level guard only, matching the RLS design note in the SQL file.
export function remainingBalance(advance: Advance, distributions: AdvanceDistribution[]): number {
  const distributed = distributions
    .filter(d => d.advance_id === advance.id)
    .reduce((sum, d) => sum + Number(d.amount), 0);
  return Number(advance.total_amount) - distributed;
}

export async function addDistribution(payload: {
  advance_id: string;
  member_id: string;
  amount: number;
  entry_date: string;
  details?: string | null;
  created_by: string;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advance_distributions').insert({
    advance_id: payload.advance_id,
    member_id: payload.member_id,
    amount: payload.amount,
    entry_date: payload.entry_date,
    details: payload.details ?? null,
    created_by: payload.created_by,
  });
  return { error: error ? error.message : null };
}

export async function updateDistribution(
  id: string,
  payload: Partial<Pick<AdvanceDistribution, 'amount' | 'entry_date' | 'details' | 'member_id'>>
): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advance_distributions').update(payload).eq('id', id);
  return { error: error ? error.message : null };
}

export async function deleteDistribution(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('advance_distributions').delete().eq('id', id);
  return { error: error ? error.message : null };
}

// ── Payroll integration helpers ─────────────────────────────────────────
// Used by FinPayslips.tsx/FinReport.tsx at payroll-calculation time. Both
// take the already-fetched, whole-org lists (fetched once per payroll page
// load) rather than querying per member, since payroll pages already iterate
// the full team for a given month/year.

// Sum of everything a given member personally received across ANY batch
// targeting this month/year — this is what gets subtracted from their net pay,
// whether or not they're also a team leader.
export function getMemberAdvanceDeductionForMonth(
  memberId: string,
  month: number,
  year: number,
  advances: Advance[],
  distributions: AdvanceDistribution[]
): number {
  const batchIdsForMonth = new Set(
    advances.filter(a => a.month === month && a.year === year).map(a => a.id)
  );
  return distributions
    .filter(d => d.member_id === memberId && batchIdsForMonth.has(d.advance_id))
    .reduce((sum, d) => sum + Number(d.amount), 0);
}

// Additional deduction applied only to a team leader: whatever is left
// undistributed, at payroll time, in their own batches targeting this
// month/year. No manual "close batch" step — this is computed live every
// time payroll runs, per the agreed design.
export function getLeaderUndistributedForMonth(
  leaderId: string,
  month: number,
  year: number,
  advances: Advance[],
  distributions: AdvanceDistribution[]
): number {
  const ownBatchesForMonth = advances.filter(
    a => a.team_leader_id === leaderId && a.month === month && a.year === year
  );
  return ownBatchesForMonth.reduce((sum, a) => {
    const distributed = distributions
      .filter(d => d.advance_id === a.id)
      .reduce((s, d) => s + Number(d.amount), 0);
    return sum + Math.max(0, Number(a.total_amount) - distributed);
  }, 0);
}

// Total advance deduction for a member's net pay in a given month — the sum
// of the two helpers above. This is the single number FinPayslips.tsx should
// subtract from netPay.
export function getTotalAdvanceDeductionForMonth(
  memberId: string,
  month: number,
  year: number,
  advances: Advance[],
  distributions: AdvanceDistribution[]
): number {
  return (
    getMemberAdvanceDeductionForMonth(memberId, month, year, advances, distributions) +
    getLeaderUndistributedForMonth(memberId, month, year, advances, distributions)
  );
}
