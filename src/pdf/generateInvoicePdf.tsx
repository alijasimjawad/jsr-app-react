// src/pdf/generateInvoicePdf.ts
//
// Deterministic client-side PDF export for invoices. Dynamically imports
// @react-pdf/renderer + the InvoicePdfDocument so the ~1MB pdfkit bundle
// is NOT included in the main app chunk — the fetch only happens on the
// first user click of "Download PDF".
//
// Contract:
//   • Input: `InvoicePrintModel` (same object used by the HTML print
//     template — see src/lib/invoicePrintTemplate.ts). No duplication.
//   • Output: triggers a browser download of an A4 PDF whose filename
//     is derived from `model.invoice_number` and sanitized to
//     `[A-Za-z0-9._-]`. Falls back to `invoice.pdf`.
//   • Throws on failure. Callers should try/catch and surface an error
//     toast (see FinInvoices.tsx call sites).

import type { InvoicePrintModel } from '../lib/invoicePrintTemplate';

// Filename sanitizer — strips anything outside [A-Za-z0-9._-]. Keeps the
// invoice number readable while guaranteeing a browser-safe filename on
// every OS (some browsers replace `/` and `:` silently, but we don't
// want to depend on that behaviour).
function sanitizeFilename(base: string | null | undefined): string {
  const raw = (base || '').toString().trim();
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'invoice';
}

/**
 * Generate an invoice PDF via React-PDF and trigger a browser download.
 *
 * Uses dynamic imports so pdfkit is loaded lazily on first click. The
 * returned Promise resolves after the download link has been clicked
 * and the temporary anchor has been cleaned up.
 */
export async function generateInvoicePdf(model: InvoicePrintModel): Promise<void> {
  // Dynamic import — keeps @react-pdf/renderer out of the main bundle.
  // Both imports must resolve before we can call `pdf(...).toBlob()`.
  const [{ pdf }, { InvoicePdfDocument }] = await Promise.all([
    import('@react-pdf/renderer'),
    import('./InvoicePdfDocument'),
  ]);

  // Build the React element and render it to a Blob via pdfkit.
  const blob = await pdf(<InvoicePdfDocument model={model} />).toBlob();

  const filename = sanitizeFilename(model.invoice_number) + '.pdf';
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // The anchor must be attached for Firefox to honour the click.
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    // Release the object URL — the browser has already started the
    // download by the time we get here, so revoking is safe.
    URL.revokeObjectURL(url);
  }
}
