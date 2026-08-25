-- docs/go-live/19_invoice_upgrade.sql
--
-- Purpose: Additive schema upgrade for the client-facing invoice redesign
--          (JSR Communications). Adds:
--            • public.purchase_orders          — client-issued POs
--            • public.company_settings         — single-row company profile
--                                                (for external documents)
--            • public.bank_accounts            — company bank accounts shown
--                                                on invoices
--            • public.revenue.po_id            — optional link from a Site's
--                                                agreed commercial value to
--                                                the authorizing PO
--            • public.invoices                 — po_id, milestone_label,
--                                                milestone_percent,
--                                                discount_amount, tax_amount
--            • public.invoice_payments         — method, bank_account_id
--
-- WHY: The current invoice model has no concept of a Purchase Order, no
--      milestone/partial billing metadata, no company profile or bank
--      accounts, no tax/discount columns, and no payment method. See the
--      Phase 1/2 audit for full context. All changes here are additive and
--      nullable so existing invoices, invoice_items, invoice_payments, and
--      revenue rows keep working with zero backfill.
--
-- MODEL: The relationship is deliberately kept minimal:
--
--    clients ──< purchase_orders ──< revenue (po_id nullable)
--                       │                      │
--                       └──< invoices ──< invoice_items (revenue_id nullable)
--                                              │
--                                              └── SUM(amount) is the billed
--                                                  commercial value against
--                                                  the Site (revenue.amount)
--                                                  and, via invoice.po_id,
--                                                  the PO (po_amount).
--
--      revenue.amount stays the SINGLE source of truth for the agreed
--      commercial value of a Site. purchase_orders.po_amount stays the
--      client-authorized PO ceiling. Neither derives from the other. No
--      purchase_order_items table is created — a revenue row already IS
--      the commercial line item for a Site.
--
-- SAFETY GUARANTEES:
--   • CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS + CREATE INDEX
--     IF NOT EXISTS — every statement is idempotent, safe to re-run.
--   • Every added column is NULLABLE or has a numeric default of 0. No
--     existing row is modified. No backfill required.
--   • RLS is enabled on the three new tables and policies are created
--     BEFORE any application read/write reaches them. Follows the same
--     pattern as docs/go-live/rls_hardening.sql (admin-only via
--     public.jsr_is_admin(), except company_settings SELECT which is
--     open to any authenticated user so the invoice-print view can render
--     without admin rights).
--   • Every FK uses ON DELETE SET NULL (or RESTRICT for client_id on
--     purchase_orders — deleting a client with open POs is not allowed).
--   • The single company_settings seed row uses WHERE NOT EXISTS so
--     re-running the file does not overwrite manual edits.
--   • NO invented business data: only the two branding constants
--     ('JSR Communications', 'Connecting the Future') are seeded, per the
--     Phase 2 approval. Address, phone, email, website, tax_id, and logo
--     are left NULL for admin to fill in via the Settings UI in Phase 3.
--     NO bank_accounts row is seeded — real bank data must be entered by
--     admin, never hard-coded in source control.
--
-- Scope:
--   DESTINATION ONLY: JSR React app — qaqxoakjnyivuegsopha
--   NEVER apply to source (old JSR production): tltbkjvrhqsxdspdfeqk
--   NEVER apply to TAC's live project: gauejhgitzcqjvzalshf
--
-- Not executed by me — file only, per standing instructions. Run this
-- yourself in the JSR React project's Supabase SQL Editor after confirming
-- the project ref in the dashboard URL.


-- ============================================================================
-- PART A: New tables
-- ============================================================================

-- ── purchase_orders ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  po_number      text        NOT NULL,
  client_id      uuid        NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  project_name   text,
  po_date        date,
  po_amount      numeric     NOT NULL DEFAULT 0,
  currency       text        NOT NULL DEFAULT 'IQD',
  status         text        NOT NULL DEFAULT 'Open',
  notes          text,
  attachment_url text,
  created_by     text,
  CONSTRAINT purchase_orders_client_po_number_unique UNIQUE (client_id, po_number)
);

-- ── company_settings (single-row) ───────────────────────────────────────────
-- Not enforced as strictly single-row by a partial unique index because the
-- application already treats the first row as authoritative; a check
-- constraint here would add friction for future settings profiles (e.g. a
-- second legal entity) without preventing bad data today.
CREATE TABLE IF NOT EXISTS public.company_settings (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name   text        NOT NULL,
  tagline        text,
  address_line1  text,
  address_line2  text,
  city           text,
  country        text,
  phone          text,
  email          text,
  website        text,
  tax_id         text,
  logo_url       text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     text
);

-- ── bank_accounts ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  bank_name      text        NOT NULL,
  account_name   text,
  account_number text,
  iban           text,
  swift          text,
  currency       text        NOT NULL DEFAULT 'IQD',
  is_default     boolean     NOT NULL DEFAULT false,
  is_active      boolean     NOT NULL DEFAULT true,
  sort_order     integer     NOT NULL DEFAULT 0
);


-- ============================================================================
-- PART B: Additive columns on existing tables
-- ============================================================================

-- revenue: optional link to the authorizing PO. Nullable so all existing
-- revenue rows survive unchanged; admin can attach a PO at any time.
ALTER TABLE public.revenue
  ADD COLUMN IF NOT EXISTS po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

-- invoices: PO link + milestone metadata + optional commercial adjustments.
-- discount_amount / tax_amount default to 0 so the app can keep computing
-- invoices.total_amount = SUM(items.amount) − discount + tax without any
-- migration-time backfill. NO tax rate table, NO auto tax logic — these are
-- plain optional numerics for future use per the Phase 2 approval.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS po_id             uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS milestone_label   text,
  ADD COLUMN IF NOT EXISTS milestone_percent numeric,
  ADD COLUMN IF NOT EXISTS discount_amount   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount        numeric NOT NULL DEFAULT 0;

-- invoice_payments: optional payment method + optional bank account link.
-- method is free text (Phase 2 spec: "Do not create an over-complex payment/
-- accounting module yet") — the UI can constrain it to a small set of
-- values; not enforced as an enum at the DB level for flexibility.
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS method          text,
  ADD COLUMN IF NOT EXISTS bank_account_id uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL;


-- ============================================================================
-- PART C: Indexes on the new FK columns
-- ============================================================================
-- Partial indexes because po_id / bank_account_id are nullable and most rows
-- will be NULL until admins start linking things up — a full index would
-- pay for every unlinked row.

CREATE INDEX IF NOT EXISTS purchase_orders_client_id_idx
  ON public.purchase_orders (client_id);

CREATE INDEX IF NOT EXISTS revenue_po_id_idx
  ON public.revenue (po_id) WHERE po_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_po_id_idx
  ON public.invoices (po_id) WHERE po_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoice_payments_bank_account_id_idx
  ON public.invoice_payments (bank_account_id) WHERE bank_account_id IS NOT NULL;


-- ============================================================================
-- PART D: Enable RLS on the three new tables
-- ============================================================================

ALTER TABLE public.purchase_orders  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts    ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- PART E: Policies
-- Follows docs/go-live/rls_hardening.sql conventions. Uses DROP POLICY IF
-- EXISTS so the file is fully idempotent.
-- ============================================================================

-- ── purchase_orders — admin only (mirrors invoices / clients) ───────────────
DROP POLICY IF EXISTS "purchase_orders_select_admin" ON public.purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_insert_admin" ON public.purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_update_admin" ON public.purchase_orders;
DROP POLICY IF EXISTS "purchase_orders_delete_admin" ON public.purchase_orders;

CREATE POLICY "purchase_orders_select_admin" ON public.purchase_orders
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "purchase_orders_insert_admin" ON public.purchase_orders
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "purchase_orders_update_admin" ON public.purchase_orders
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "purchase_orders_delete_admin" ON public.purchase_orders
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());

-- ── company_settings — admin write, authenticated read ─────────────────────
-- The invoice print view needs the company header/logo without needing
-- admin rights, so SELECT is open to any authenticated user. Nothing on
-- this row is authentication-sensitive (name, address, phone, email,
-- website, tax id, logo URL).
DROP POLICY IF EXISTS "company_settings_select_authenticated" ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_insert_admin"         ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_update_admin"         ON public.company_settings;
DROP POLICY IF EXISTS "company_settings_delete_admin"         ON public.company_settings;

CREATE POLICY "company_settings_select_authenticated" ON public.company_settings
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "company_settings_insert_admin" ON public.company_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "company_settings_update_admin" ON public.company_settings
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "company_settings_delete_admin" ON public.company_settings
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());

-- ── bank_accounts — admin only (account numbers / IBAN are sensitive) ──────
-- The invoice print view is currently reached only by admins, so admin-only
-- SELECT is sufficient today. If a non-admin invoice print flow is added
-- later, this policy will need to be revisited.
DROP POLICY IF EXISTS "bank_accounts_select_admin" ON public.bank_accounts;
DROP POLICY IF EXISTS "bank_accounts_insert_admin" ON public.bank_accounts;
DROP POLICY IF EXISTS "bank_accounts_update_admin" ON public.bank_accounts;
DROP POLICY IF EXISTS "bank_accounts_delete_admin" ON public.bank_accounts;

CREATE POLICY "bank_accounts_select_admin" ON public.bank_accounts
  FOR SELECT TO authenticated
  USING (public.jsr_is_admin());

CREATE POLICY "bank_accounts_insert_admin" ON public.bank_accounts
  FOR INSERT TO authenticated
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "bank_accounts_update_admin" ON public.bank_accounts
  FOR UPDATE TO authenticated
  USING (public.jsr_is_admin())
  WITH CHECK (public.jsr_is_admin());

CREATE POLICY "bank_accounts_delete_admin" ON public.bank_accounts
  FOR DELETE TO authenticated
  USING (public.jsr_is_admin());


-- ============================================================================
-- PART F: Seed the single company_settings row
-- ============================================================================
-- Only branding decisions the user explicitly stated are seeded here
-- (company_name, tagline). All contact/legal fields stay NULL so admin
-- fills them in via the Settings UI in Phase 3. WHERE NOT EXISTS guards
-- against overwriting manual edits on re-run.

INSERT INTO public.company_settings (company_name, tagline)
SELECT 'JSR Communications', 'Connecting the Future'
WHERE NOT EXISTS (SELECT 1 FROM public.company_settings);


-- ============================================================================
-- PART G: Post-apply verification (read-only)
-- ============================================================================
-- Expected results:
--   • purchase_orders / company_settings / bank_accounts exist, rls = true.
--   • revenue has po_id; invoices has po_id, milestone_label,
--     milestone_percent, discount_amount, tax_amount; invoice_payments has
--     method, bank_account_id.
--   • Exactly one row in company_settings after first run.

SELECT tablename, rowsecurity
FROM   pg_tables
WHERE  schemaname = 'public'
  AND  tablename IN ('purchase_orders', 'company_settings', 'bank_accounts')
ORDER  BY tablename;

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM   information_schema.columns
WHERE  table_schema = 'public'
  AND (
        (table_name = 'revenue'          AND column_name = 'po_id')
     OR (table_name = 'invoices'         AND column_name IN ('po_id','milestone_label','milestone_percent','discount_amount','tax_amount'))
     OR (table_name = 'invoice_payments' AND column_name IN ('method','bank_account_id'))
  )
ORDER  BY table_name, column_name;

SELECT COUNT(*) AS company_settings_row_count,
       (SELECT company_name FROM public.company_settings LIMIT 1) AS seeded_company_name,
       (SELECT tagline      FROM public.company_settings LIMIT 1) AS seeded_tagline
FROM   public.company_settings;
