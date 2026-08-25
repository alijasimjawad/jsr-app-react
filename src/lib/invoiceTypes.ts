// Types for the client-facing invoice redesign (JSR Communications).
// Kept in a dedicated module so Phase 3 UI work can import the shapes
// consistently without duplicating them across FinInvoices / FinPOs /
// FinSettings pages. Mirrors the schema added by
// docs/go-live/19_invoice_upgrade.sql. Existing interfaces inside
// FinInvoices.tsx are intentionally left untouched in Phase 2 — Phase 3
// will merge them here.

export interface PurchaseOrder {
  id: string;
  created_at: string;
  po_number: string;
  client_id: string;
  project_name: string | null;
  po_date: string | null;
  po_amount: number;
  currency: string;
  status: string;
  notes: string | null;
  attachment_url: string | null;
  created_by: string | null;
}

export interface CompanySettings {
  id: string;
  company_name: string;
  tagline: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  tax_id: string | null;
  logo_url: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface BankAccount {
  id: string;
  created_at: string;
  bank_name: string;
  account_name: string | null;
  account_number: string | null;
  iban: string | null;
  swift: string | null;
  currency: string;
  is_default: boolean;
  is_active: boolean;
  sort_order: number;
}

// Free-text at the DB level; the UI narrows it to this small set.
// Extend deliberately — do not add values without a matching UI change.
export type PaymentMethod = 'bank_transfer' | 'cash' | 'cheque' | null;

// Additive fields added to existing tables by 19_invoice_upgrade.sql.
// These are declared as separate `Partial` shapes so Phase 3 can spread
// them onto the existing Invoice / InvoicePayment / RevRow interfaces
// without a churn-heavy refactor in Phase 2. All fields are nullable /
// zero-defaulted at the DB level.
export interface InvoiceUpgradeFields {
  po_id: string | null;
  milestone_label: string | null;
  milestone_percent: number | null;
  discount_amount: number;
  tax_amount: number;
}

export interface InvoicePaymentUpgradeFields {
  method: PaymentMethod;
  bank_account_id: string | null;
}

export interface RevenueUpgradeFields {
  po_id: string | null;
}
