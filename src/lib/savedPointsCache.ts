import { supabase } from './supabase';

export interface SavedPointMeta {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  is_active: boolean;
}

let _points: SavedPointMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureSavedPointsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    const { data, error } = await supabase
      .from('saved_points')
      .select('*')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) {
      // Leave _loaded=false so the next call retries instead of getting stuck
      // on a permanently-empty cache until a hard refresh.
      console.error('[savedPointsCache] load failed, will retry next call:', error);
      _inFlight = null;
      return;
    }
    _points = (data ?? []) as SavedPointMeta[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getSavedPoints(): SavedPointMeta[] { return _points; }
export function savedPointsLoaded(): boolean { return _loaded; }
export function invalidateSavedPoints(): void { _loaded = false; }

export function getSavedPoint(id: string | null | undefined): SavedPointMeta | undefined {
  if (!id) return undefined;
  return _points.find(p => p.id === id);
}
