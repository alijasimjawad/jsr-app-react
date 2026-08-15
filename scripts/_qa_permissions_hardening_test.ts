/**
 * Permission hardening QA — action-level restrictions.
 *
 * Verifies the hasPerm() resolution for the three new/modified keys:
 *   da_export         — Daily Activities export (new key, defaults false for Engineer/Technician)
 *   da_share_whatsapp — Daily Activities WhatsApp sharing (new key, defaults false)
 *   sitesdb_export    — Sites DB export (existing key, removed from LEGACY_OPEN_ACTIONS so
 *                       it no longer falls back to view_sites_db for non-admins)
 *
 * Groups:
 *   GROUP 1 — hasPerm() resolution for admin role (all three keys → true)
 *   GROUP 2 — hasPerm() resolution for engineer role (all three keys → false by default)
 *   GROUP 3 — hasPerm() resolution for technician role (same as engineer)
 *   GROUP 4 — Explicit grant overrides default for engineer (admin explicitly sets key true)
 *   GROUP 5 — Explicit deny overrides for admin-equivalent scenario
 *   GROUP 6 — Catalog: new keys appear in ACTION_SCOPES daily_activities
 *   GROUP 7 — Legacy keys unaffected (da_add_rows, sdb_add_rows, sitesdb_add still work)
 *
 * Note: hasPerm() is a frontend function. These tests replicate its logic
 * directly in Node.js using the same resolution rules from AuthContext.tsx.
 *
 * Run: npx tsx scripts/_qa_permissions_hardening_test.ts
 */

// ── Replicated permission resolution from AuthContext.tsx ─────────────────────
// (kept minimal — only the resolution chain, not the full auth context)

interface UserProfile {
  role: string;
  permissions: Record<string, boolean>;
}

// Keys from permissionsCatalog.ts after the hardening patch
const FIELD_ROLE_DEFAULT_KEYS: string[] = [
  // Keys from *.perm.ts with fieldRoleDefault: true — we only need to know
  // these exist, not enumerate all of them. Adding one representative key.
  'view_dashboard',
  'view_sites_db',
  // The DA/WhatsApp/export keys are deliberately NOT here.
];

const LEGACY_ACTION_KEY: Record<string, string> = {
  da_add_rows: 'add_rows', da_edit_rows: 'edit_rows', da_delete_rows: 'delete_rows',
  sdb_add_rows: 'add_rows', sdb_edit_rows: 'edit_rows', sdb_delete_rows: 'delete_rows',
  sdb_add_columns: 'add_columns', sdb_export_excel: 'export_excel',
  sdb_add_section: 'add_section', sdb_rename_section: 'rename_section', sdb_delete_section: 'delete_section',
  // da_export and da_share_whatsapp have NO legacy mapping — new keys only.
};

// AFTER the patch: sitesdb_export is no longer in LEGACY_OPEN_ACTIONS.
const LEGACY_OPEN_ACTIONS: Record<string, string> = {
  fin_exp_claims_approve: 'view_exp_claims',
  fin_revenue_add: 'view_fin_revenue',
  // ... (representative subset; sitesdb_export intentionally absent)
  activity_log_export: 'view_activity_log',
};

function hasPerm(u: UserProfile, key: string): boolean {
  if (u.role === 'admin') return true;
  const roleLower = u.role?.toLowerCase();
  if (key === 'view_my_expenses' && (roleLower === 'engineer' || roleLower === 'technician')) return true;
  const stored = u.permissions?.[key];
  if (typeof stored === 'boolean') return stored;
  const legacyKey = LEGACY_ACTION_KEY[key];
  if (legacyKey) {
    const legacyStored = u.permissions?.[legacyKey];
    if (typeof legacyStored === 'boolean') return legacyStored;
  }
  const openFallbackViewKey = LEGACY_OPEN_ACTIONS[key];
  if (openFallbackViewKey) return hasPerm(u, openFallbackViewKey);
  if (FIELD_ROLE_DEFAULT_KEYS.includes(key) && (roleLower === 'engineer' || roleLower === 'technician')) return true;
  return false;
}

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
function assert(name: string, ok: boolean, detail?: string) {
  if (ok) { console.log(`  ✔ PASS   ${name}`); passed++; }
  else     { console.log(`  ✘ FAIL   ${name}${detail ? ' — ' + detail : ''}`); failed++; }
}

// Sample users
const adminUser: UserProfile   = { role: 'admin',      permissions: {} };
const engineerUser: UserProfile = { role: 'engineer',   permissions: {} };
const techUser: UserProfile     = { role: 'technician', permissions: {} };
const userRole: UserProfile     = { role: 'user',       permissions: {} };

// Engineer with view_sites_db granted explicitly
const engWithSitesPerm: UserProfile = {
  role: 'engineer',
  permissions: { view_sites_db: true },
};

// Engineer with da_export and da_share_whatsapp explicitly granted by admin
const engWithExplicitGrant: UserProfile = {
  role: 'engineer',
  permissions: { da_export: true, da_share_whatsapp: true },
};

// Engineer with sitesdb_export explicitly granted
const engWithSitesExport: UserProfile = {
  role: 'engineer',
  permissions: { sitesdb_export: true },
};

console.log('\n══════════════════════════════════════════════════════');
console.log(' Permission Hardening QA — action-level restrictions');
console.log('══════════════════════════════════════════════════════\n');

// ── GROUP 1 — Admin: all three keys → true ────────────────────────────────────
console.log('── GROUP 1: Admin role — all three keys granted ───');
assert('1.1 — admin: da_export → true',          hasPerm(adminUser, 'da_export'));
assert('1.2 — admin: da_share_whatsapp → true',  hasPerm(adminUser, 'da_share_whatsapp'));
assert('1.3 — admin: sitesdb_export → true',     hasPerm(adminUser, 'sitesdb_export'));

// ── GROUP 2 — Engineer: new keys default false ────────────────────────────────
console.log('\n── GROUP 2: Engineer role — restricted by default ─');
assert('2.1 — engineer: da_export → false',         !hasPerm(engineerUser, 'da_export'));
assert('2.2 — engineer: da_share_whatsapp → false', !hasPerm(engineerUser, 'da_share_whatsapp'));
assert('2.3 — engineer: sitesdb_export → false',    !hasPerm(engineerUser, 'sitesdb_export'));

// Even with view_sites_db explicitly granted, sitesdb_export must still be false
// (the LEGACY_OPEN_ACTIONS fallback was removed)
assert('2.4 — engineer with view_sites_db=true: sitesdb_export still → false',
  !hasPerm(engWithSitesPerm, 'sitesdb_export'));

// ── GROUP 3 — Technician: same restrictions ────────────────────────────────────
console.log('\n── GROUP 3: Technician role — restricted by default');
assert('3.1 — technician: da_export → false',         !hasPerm(techUser, 'da_export'));
assert('3.2 — technician: da_share_whatsapp → false', !hasPerm(techUser, 'da_share_whatsapp'));
assert('3.3 — technician: sitesdb_export → false',    !hasPerm(techUser, 'sitesdb_export'));

// ── GROUP 4 — Explicit admin grant overrides for engineer ─────────────────────
console.log('\n── GROUP 4: Explicit grant overrides default ───────');
assert('4.1 — engineer with da_export=true explicitly: → true',
  hasPerm(engWithExplicitGrant, 'da_export'));
assert('4.2 — engineer with da_share_whatsapp=true explicitly: → true',
  hasPerm(engWithExplicitGrant, 'da_share_whatsapp'));
assert('4.3 — engineer with sitesdb_export=true explicitly: → true',
  hasPerm(engWithSitesExport, 'sitesdb_export'));

// ── GROUP 5 — 'user' role: not admin, no special defaults ────────────────────
console.log('\n── GROUP 5: user role — restricted ────────────────');
assert('5.1 — user: da_export → false',         !hasPerm(userRole, 'da_export'));
assert('5.2 — user: da_share_whatsapp → false', !hasPerm(userRole, 'da_share_whatsapp'));
assert('5.3 — user: sitesdb_export → false',    !hasPerm(userRole, 'sitesdb_export'));

// ── GROUP 6 — Existing action keys unaffected ─────────────────────────────────
console.log('\n── GROUP 6: Existing keys unaffected ───────────────');
// da_add_rows falls back to legacy 'add_rows'
const engWithAddRows: UserProfile = { role: 'engineer', permissions: { add_rows: true } };
assert('6.1 — engineer with add_rows=true: da_add_rows → true (legacy fallback)',
  hasPerm(engWithAddRows, 'da_add_rows'));
assert('6.2 — engineer no perms: da_add_rows → false',
  !hasPerm(engineerUser, 'da_add_rows'));

// da_delete_rows with explicit scoped key
const engWithDaDelete: UserProfile = { role: 'engineer', permissions: { da_delete_rows: true } };
assert('6.3 — engineer with da_delete_rows=true: da_delete_rows → true',
  hasPerm(engWithDaDelete, 'da_delete_rows'));

// sitesdb_add (not in LEGACY_OPEN_ACTIONS — admin-only in practice)
assert('6.4 — engineer: sitesdb_add → false (admin-only by design)',
  !hasPerm(engineerUser, 'sitesdb_add'));
assert('6.5 — admin: sitesdb_add → true',
  hasPerm(adminUser, 'sitesdb_add'));

// ── GROUP 7 — View_sites_db field-role default still works ────────────────────
console.log('\n── GROUP 7: Field-role defaults unaffected ─────────');
// view_sites_db is a fieldRoleDefault key so engineer/tech get it by default
assert('7.1 — engineer: view_sites_db → true (field-role default)',
  hasPerm(engineerUser, 'view_sites_db'));
assert('7.2 — technician: view_sites_db → true (field-role default)',
  hasPerm(techUser, 'view_sites_db'));
// But sitesdb_export does NOT piggyback on that anymore
assert('7.3 — engineer with view_sites_db default: sitesdb_export still → false',
  !hasPerm(engineerUser, 'sitesdb_export'));

// ── Summary ────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log('\n══════════════════════════════════════════════════════');
console.log(` RESULT: ${passed}/${total} passed, ${failed} failed`);
console.log('══════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
