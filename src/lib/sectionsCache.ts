import { supabase } from './supabase';
import { storageKey } from '../config/brand';

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

const SECTIONS_STORAGE_KEY = storageKey('sections_cache_v1');

let _sections: SectionMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

// Seed from last session's localStorage snapshot immediately at import time
// — same rationale as projectsCache.ts: lets the Sidebar render the
// previously-known section list on first paint instead of a brief empty
// gap, while the real fetch below still runs to correct it. _loaded stays
// false: this is a display seed only, not a substitute for a verified load.
try {
  const cached = localStorage.getItem(SECTIONS_STORAGE_KEY);
  if (cached) _sections = JSON.parse(cached) as SectionMeta[];
} catch {
  // Corrupt/unavailable localStorage — ignore, falls back to normal load.
}

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
    try {
      localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(_sections));
    } catch {
      // Storage full/unavailable — non-fatal, just skip the seed for next time.
    }
  })();
  return _inFlight;
}

export function getSections(): SectionMeta[] { return _sections; }
export function sectionsLoaded(): boolean { return _loaded; }
export function invalidateSections(): void { _loaded = false; }
