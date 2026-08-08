/**
 * Extracts a human-readable message from a caught value of unknown type.
 *
 * Why this exists: Supabase's PostgrestError (and similar error shapes
 * returned by supabase-js) is a plain object with a `.message` field — it
 * does NOT extend the built-in `Error` class. The common
 * `e instanceof Error ? e.message : String(e)` catch pattern used across
 * this codebase silently falls through to `String(e)` for those objects,
 * which produces the literal string "[object Object]" instead of the real
 * database error (e.g. "column revenue.invoice_date does not exist").
 *
 * Use this helper in place of that pattern everywhere a Supabase call (or
 * anything else that might throw a non-Error object) is caught.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return String(e);
}
