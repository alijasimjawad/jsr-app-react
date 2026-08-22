import { supabase } from './supabase';

export interface SectionMeta {
  id: string;
  project_name: string;
  section_name: string;
  section_label: string;
  columns: string[];
  custom_columns: string[];
  is_custom: boolean;
  is_deleted: boolean;
  created_at: string;
}

let _sections: SectionMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureSectionsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    let { data, error } = await supabase
      .from('sections')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      // Leave _loaded=false so the next call retries instead of getting stuck
      // on a permanently-empty cache until a hard refresh.
      console.error('[sectionsCache] load failed, will retry next call:', error);
      _inFlight = null;
      return;
    }
    // A transient auth/session hiccup right after a fresh sign-in (token
    // still propagating) can make PostgREST return a successful response
    // with zero rows instead of an actual error — indistinguishable from a
    // genuinely empty table here. public.sections is never actually empty
    // in this app, so treat a first-try empty result as suspicious and
    // retry once inline before trusting it and setting _loaded=true; a
    // flag flip to true with an empty list would otherwise permanently
    // hide Network Scopes sections until a hard refresh.
    if (!data || data.length === 0) {
      const retry = await supabase
        .from('sections')
        .select('*')
        .order('created_at', { ascending: true });
      if (retry.error) {
        console.error('[sectionsCache] retry failed, will retry next call:', retry.error);
        _inFlight = null;
        return;
      }
      data = retry.data;
    }
    _sections = (data ?? []) as SectionMeta[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getSections(): SectionMeta[] { return _sections; }
export function sectionsLoaded(): boolean { return _loaded; }
export function invalidateSections(): void { _loaded = false; }
