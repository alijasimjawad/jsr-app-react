// Centralized branding & configuration for JSR Network Tracker.
//
// Every JSR-specific string (app name, tagline, email domain, invoice
// prefix, localStorage key prefix, logos, etc.) should be imported from
// here instead of hardcoded inline. This keeps future rebrands (or a
// third company fork) to a single-file change.
//
// NOTE: logoLight/logoStandard still point at the placeholder TAC logo
// assets copied over from the original repo. Swap these imports for the
// real JSR logo files once they're provided — do not replace the PNGs
// themselves until then.
import logoLightPlaceholder from '../assets/tac-logo-light.png';
import logoPlaceholder from '../assets/tac-logo.png';

export const BRAND = {
  appName: 'JSR Network Tracker',
  shortName: 'JSR',
  tagline: 'Network Operations Management System',
  authEmailDomain: 'jsr.internal',
  invoicePrefix: 'JSR',
  storageKeyPrefix: 'jsr',
  copyrightLine: `© ${new Date().getFullYear()} JSR Network Tracker. All rights reserved.`,
  logoLight: logoLightPlaceholder,
  logoStandard: logoPlaceholder,
} as const;

/** Builds the fake internal auth email used for Supabase username/password login. */
export function buildAuthEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${BRAND.authEmailDomain}`;
}

/** Builds a namespaced localStorage key, e.g. storageKey('lang') -> 'jsr_lang'. */
export function storageKey(suffix: string): string {
  return `${BRAND.storageKeyPrefix}_${suffix}`;
}
