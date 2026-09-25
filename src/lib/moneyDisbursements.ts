// src/lib/moneyDisbursements.ts
//
// Data layer for the "Money Out" feature — a standalone, admin-only log of
// every disbursement out of the company: salaries, team advances, operating
// spend, anything else. Not linked to invoices/revenue/payroll, and not a
// cost-categorization report like General Expenses / Project Expenses —
// this is a custody/accountability log answering "who gave this money out,
// and who/what did it go to." See docs/go-live/23_add_money_disbursements.sql
// for the table/RLS design, and src/lib/partnerCapital.ts for the sibling
// feature this one is modeled after (same admin-only access pattern).

import { supabase } from './supabase';

export interface MoneyDisbursement {
  id: string;
  disbursement_date: string;
  given_by: string;
  given_to: string;
  category: string | null;
  amount: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string | null;
}

export const MONEY_OUT_CATS = [
  'Salaries',
  'Team Advances',
  'Company Expenses',
  'Rent',
  'Office',
  'Utilities',
  'Communication',
  'Other',
];

// ── Fetch ────────────────────────────────────────────────────────────────

export async function fetchMoneyDisbursements(): Promise<MoneyDisbursement[]> {
  const { data, error } = await supabase
    .from('money_disbursements')
    .select('*')
    .order('disbursement_date', { ascending: false });
  if (error) {
    console.error('fetchMoneyDisbursements failed:', error.message, error);
    return [];
  }
  return (data as MoneyDisbursement[]) ?? [];
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function createMoneyDisbursement(payload: {
  disbursement_date: string;
  given_by: string;
  given_to: string;
  category?: string | null;
  amount: number;
  notes?: string | null;
  created_by: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from('money_disbursements')
    .insert({
      disbursement_date: payload.disbursement_date,
      given_by: payload.given_by,
      given_to: payload.given_to,
      category: payload.category ?? null,
      amount: payload.amount,
      notes: payload.notes ?? null,
      created_by: payload.created_by,
    })
    .select('id')
    .single();
  return { id: data ? (data as { id: string }).id : null, error: error ? error.message : null };
}

export async function updateMoneyDisbursement(
  id: string,
  payload: Partial<Pick<MoneyDisbursement, 'disbursement_date' | 'given_by' | 'given_to' | 'category' | 'amount' | 'notes'>>,
  updatedBy: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('money_disbursements')
    .update({ ...payload, updated_by: updatedBy, updated_at: new Date().toISOString() })
    .eq('id', id);
  return { error: error ? error.message : null };
}

export async function deleteMoneyDisbursement(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('money_disbursements').delete().eq('id', id);
  return { error: error ? error.message : null };
}

// ── Derived ──────────────────────────────────────────────────────────────

export function totalOut(entries: MoneyDisbursement[]): number {
  return entries.reduce((sum, e) => sum + Number(e.amount), 0);
}
