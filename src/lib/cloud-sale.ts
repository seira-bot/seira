import { buyOfferAllowed, type CloudPlanView } from "@/lib/cloud-plan";
import { SEIRA_CLOUD_PLANS } from "@/lib/seira-cloud";

/** True only when Seira's own Cloud sells a plan. While it sells nothing, no screen sells, promotes or starts a Cloud
 * purchase; sign-in and management for an account that already has a Cloud stay. */
export const cloudSells = (): boolean => SEIRA_CLOUD_PLANS.length > 0;

/** `buyOfferAllowed`, and Seira's Cloud has a plan to sell. */
export const cloudOfferAllowed = (view: CloudPlanView): boolean => cloudSells() && buyOfferAllowed(view);
