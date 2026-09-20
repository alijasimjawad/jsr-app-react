// src/lib/partnerCapital.ts
//
// Data layer for the "Partner Capital" feature — a standalone, admin-only
// ledger of how much money each company partner has put into the company.
// See docs/go-live/22_add_partner_capital.sql for the table/RLS design.
//
// Partners ARE the existing admin accounts (public.users where role =
// 'admin') — there's no separate partners table. Every entry attributes an
// amount to one such user and records who added/last-edited it.

import { supabase } from './supabase';

export interface PartnerCapitalEntry {
  id: string;
  partner_id: string;
  amount: number;
  entry_date: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

export interface PartnerLite {
  id: string;
  full_name: string;
  username: string;
}

// ── Fetch ────────────────────────────────────────────────────────────────

// Every admin-role user — these are the selectable "partners".
export async function fetchPartners(): Promise<PartnerLite[]> {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, username')
    .eq('role', 'admin')
    .order('full_name');
  if (error) {
    console.error('fetchPartners failed:', error.message, error);
    return [];
  }
  return (data as PartnerLite[]) ?? [];
}

export async function fetchPartnerCapitalEntries(): Promise<PartnerCapitalEntry[]> {
  const { data, error } = await supabase
    .from('partner_capital_entries')
    .select('*')
    .order('entry_date', { ascending: false });
  if (error) {
    console.error('fetchPartnerCapitalEntries failed:', error.message, error);
    return [];
  }
  return (data as PartnerCapitalEntry[]) ?? [];
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function createPartnerCapitalEntry(payload: {
  partner_id: string;
  amount: number;
  entry_date: string;
  note?: string | null;
  created_by: string;
}): Promise<{ error: string | null }> {
  const { error } = await supabase.from('partner_capital_entries').insert({
    partner_id: payload.partner_id,
    amount: payload.amount,
    entry_date: payload.entry_date,
    note: payload.note ?? null,
    created_by: payload.created_by,
  });
  return { error: error ? error.message : null };
}

export async function updatePartnerCapitalEntry(
  id: string,
  payload: Partial<Pick<PartnerCapitalEntry, 'partner_id' | 'amount' | 'entry_date' | 'note'>>,
  updatedBy: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('partner_capital_entries')
    .update({ ...payload, updated_by: updatedBy, updated_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error ? error.message : null };
}

export async function deletePartnerCapitalEntry(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('partner_capital_entries').delete().eq('id', id);
  return { error: error ? error.message : null };
}

// ── Derived ──────────────────────────────────────────────────────────────

export function totalForPartner(entries: PartnerCapitalEntry[], partnerId: string): number {
  return entries
    .filter(e => e.partner_id === partnerId)
    .reduce((sum, e) => sum + Number(e.amount), 0);
}

export function grandTotal(entries: PartnerCapitalEntry[]): number {
  return entries.reduce((sum, e) => sum + Number(e.amount), 0);
}
