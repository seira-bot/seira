// Add a tier here only when seira-cloud can take a payment for it.
export const SEIRA_CLOUD_SALE_TIERS = Object.freeze([]);

export function seiraCloudSells() {
  return SEIRA_CLOUD_SALE_TIERS.length > 0;
}
