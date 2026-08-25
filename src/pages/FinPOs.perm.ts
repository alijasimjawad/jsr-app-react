import type { PageDef } from '../lib/permissionsCatalog';

// Auto-discovered by permissionsCatalog.ts — see that file for how this works.
const def: PageDef = {
  key: 'view_fin_purchase_orders',
  label: 'Purchase Orders',
  to: '/finance/purchase-orders',
  group: 'finance',
  order: 13,
};

export default def;
