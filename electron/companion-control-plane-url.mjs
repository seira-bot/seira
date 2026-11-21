import { normalizeControlPlaneURL } from "./control-plane-client.mjs";
import { LIVE_SEIRA_SERVICES, SEIRA_HOSTS, seiraOrigin, seiraServiceLive } from "./seira-hosts.mjs";

export const DEFAULT_COMPANION_CONTROL_PLANE_URL = seiraServiceLive("accounts") ? seiraOrigin(SEIRA_HOSTS.accounts) : "";

/** Only an exact origin in SEIRA_CONTROL_PLANE_URL turns the phone account service on, so an OTP or bearer never reaches an accidental host; an invalid value leaves it off. */
export function resolveCompanionControlPlaneURL({
  isPackaged,
  environment = process.env,
} = {}) {
  if (Object.hasOwn(environment, "SEIRA_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.SEIRA_CONTROL_PLANE_URL);
  }
  return isPackaged ? DEFAULT_COMPANION_CONTROL_PLANE_URL : "";
}

/** The control plane of `login` and `serve --tunnel`: SEIRA_CONTROL_PLANE_URL when set (an invalid value gives ""), else Seira's own once the server tunnel service is live. `live` is for tests. */
export function resolveServerControlPlaneURL({ environment = process.env, live = LIVE_SEIRA_SERVICES } = {}) {
  if (Object.hasOwn(environment, "SEIRA_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.SEIRA_CONTROL_PLANE_URL);
  }
  return seiraServiceLive("serverTunnel", environment, live) ? seiraOrigin(SEIRA_HOSTS.accounts) : "";
}
