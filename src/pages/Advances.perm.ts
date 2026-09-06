import type { PageDef } from '../lib/permissionsCatalog';

// Salary Advances (سلفة). One page, three views inside it depending on role:
//   - admin: create/manage advance batches for any team leader.
//   - the assigned team leader: log distribution entries against their own
//     open batches.
//   - every other team member: read-only list of what they've personally
//     received.
// All three cases are gated by RLS (see docs/go-live/20_add_salary_advances.sql)
// so a single `view_advances` permission is enough here — no ACTION_SCOPES
// split needed, same as most other self-service+admin finance pages.
//
// fieldRoleDefault: true so every team member (including Engineer/Technician)
// can see their own advances by default, without an admin having to grant it
// per user — matches the explicit requirement that every team member has
// their own login and can check their own advance history.
const def: PageDef = {
  key: 'view_advances',
  label: 'Advances',
  to: '/finance/advances',
  group: 'finance',
  order: 15,
  fieldRoleDefault: true,
};

export default def;
