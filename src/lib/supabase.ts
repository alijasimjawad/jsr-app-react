import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * True only when both required Supabase env vars are present. App.tsx checks
 * this before mounting AuthProvider/routes and renders a safe "configuration
 * required" screen instead when it's false — so a missing/blank .env (e.g.
 * during environment separation between forks) never crashes with an
 * unclear error or silently tries to reach some other project's Supabase.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// Fall back to harmless placeholder values so createClient() never throws at
// module-evaluation time. This placeholder client is never used to make a
// real request: App.tsx gates all rendering on isSupabaseConfigured above.
export const supabase = createClient(
  supabaseUrl || 'https://not-configured.invalid',
  supabaseAnonKey || 'not-configured'
);
