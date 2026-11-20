import { createControlPlaneClient, normalizeControlPlaneURL } from "./control-plane-client.mjs";
import { resolveServerControlPlaneURL } from "./companion-account-service.mjs";
import { createSeiraCloudSignIn } from "./seira-cloud-sign-in.mjs";
import { LIVE_SEIRA_SERVICES } from "./seira-hosts.mjs";

/** The control plane of desktop phone access: SEIRA_CONTROL_PLANE_URL when set, else Seira's own in a release once the server tunnel service is live. */
export function resolveDesktopControlPlaneURL({ isPackaged, environment = process.env, live = LIVE_SEIRA_SERVICES } = {}) {
  if (Object.hasOwn(environment, "SEIRA_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.SEIRA_CONTROL_PLANE_URL);
  }
  return isPackaged ? resolveServerControlPlaneURL({ environment, live }) : "";
}

export function createDesktopControlPlaneClient({ isPackaged, environment = process.env, origin, identity }) {
  const baseURL = resolveDesktopControlPlaneURL({ isPackaged, environment });
  if (!baseURL) return null;
  try {
    return createControlPlaneClient({ baseURL, cloudSignIn: createSeiraCloudSignIn({ origin, identity }) });
  } catch {
    return null;
  }
}
