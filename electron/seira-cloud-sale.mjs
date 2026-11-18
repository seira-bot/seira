// One switch: does Seira's own Cloud sell a plan? The upstream Cloud is never sold in this app.
// Add a tier here only when seira-cloud can take a payment for it. The window side adds its own
// check in src/lib/cloud-sale.ts, which also reads SEIRA_CLOUD_PLANS in src/lib/seira-cloud.ts.
export const SEIRA_CLOUD_SALE_TIERS = Object.freeze([]);

export function seiraCloudSells() {
  return SEIRA_CLOUD_SALE_TIERS.length > 0;
}
