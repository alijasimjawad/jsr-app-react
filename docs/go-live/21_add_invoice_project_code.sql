-- 21_add_invoice_project_code.sql
-- Adds an optional free-text "Project Code" field to invoices, shown right
-- under the Project field on the invoice form and printed/PDF output.
--
-- Run this in the Supabase SQL Editor for the JSR project
-- (qaqxoakjnyivuegsopha) before saving an invoice with a Project Code —
-- otherwise the save will fail because the column doesn't exist yet.

alter table public.invoices
  add column if not exists project_code text;
