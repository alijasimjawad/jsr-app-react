import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
// fieldRoleDefault: Engineer/Technician users see this by default until an
// admin explicitly turns it off for them in User Management. Admin always
// has access (and is the reviewer).
const def: PageDef = {
  key: 'view_site_surveys',
  label: 'Site Surveys',
  to: '/site-surveys',
  group: 'daily',
  order: 7,
  fieldRoleDefault: true,
};

export default def;
