import { supabase } from './supabase';

export interface ProjectMeta {
  id: string;
  key: string;
  display_name: string;
  has_sections: boolean;
  sort_order: number;
  is_active: boolean;
}

let _projects: ProjectMeta[] = [];
let _loaded = false;
let _inFlight: Promise<void> | null = null;

export async function ensureProjectsLoaded(): Promise<void> {
  if (_loaded) return;
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    let { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (error) {
      // Leave _loaded=false so the next call retries instead of getting stuck
      // on a permanently-empty cache until a hard refresh.
      console.error('[projectsCache] load failed, will retry next call:', error);
      _inFlight = null;
      return;
    }
    // A transient auth/session hiccup right after a fresh sign-in (token
    // still propagating) can make PostgREST return a successful response
    // with zero rows instead of an actual error — indistinguishable from a
    // genuinely empty table here. public.projects is never actually empty
    // in this app, so treat a first-try empty result as suspicious and
    // retry once inline before trusting it and setting _loaded=true; a
    // caller-side flag flip to true with an empty list would otherwise
    // permanently hide Network Scopes until a hard refresh (see
    // NetworkScopesTree's projectsReady check in Sidebar.tsx).
    if (!data || data.length === 0) {
      const retry = await supabase
        .from('projects')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true });
      if (retry.error) {
        console.error('[projectsCache] retry failed, will retry next call:', retry.error);
        _inFlight = null;
        return;
      }
      data = retry.data;
    }
    _projects = (data ?? []) as ProjectMeta[];
    _loaded = true;
    _inFlight = null;
  })();
  return _inFlight;
}

export function getProjects(): ProjectMeta[] { return _projects; }
export function projectsLoaded(): boolean { return _loaded; }
export function invalidateProjects(): void { _loaded = false; }

/** Display names in sort order, e.g. ['Zain Project', 'Nokia Project', ...]. */
export function getProjectNames(): string[] {
  return _projects.map(p => p.display_name);
}

/** Project keys in sort order, e.g. ['zain', 'nokia', ...]. */
export function getProjectKeys(): string[] {
  return _projects.map(p => p.key);
}

/** Look up the DB key (e.g. 'zain') for a display name (e.g. 'Zain Project'). */
export function getProjectKey(displayName: string): string | undefined {
  return _projects.find(p => p.display_name === displayName)?.key;
}

/** Look up the display name for a DB key. */
export function getProjectDisplayName(key: string): string | undefined {
  return _projects.find(p => p.key === key)?.display_name;
}

/** Whether this project has a Section dropdown (i.e. rows in public.sections). */
export function projectHasSections(displayName: string): boolean {
  return _projects.find(p => p.display_name === displayName)?.has_sections ?? false;
}

/** key -> display_name map, e.g. { zain: 'Zain Project', ... }. */
export function getProjectKeyToNameMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of _projects) map[p.key] = p.display_name;
  return map;
}

/** display_name -> key map, e.g. { 'Zain Project': 'zain', ... }. */
export function getProjectNameToKeyMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of _projects) map[p.display_name] = p.key;
  return map;
}
