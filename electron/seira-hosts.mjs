const ZONE = "seira.bot";
const TUNNEL_ZONE = "seira.run";

/** Every Seira host. A name here is not a promise that a service answers: see LIVE_SEIRA_SERVICES. */
export const SEIRA_HOSTS = Object.freeze({
  site: ZONE,
  cloud: `cloud.${ZONE}`,
  apps: `apps.${ZONE}`,
  updates: `updates.${ZONE}`,
  admin: `admin.${ZONE}`,
  accounts: `accounts.${ZONE}`,
  device: `device.${ZONE}`,
  stats: `stats.${ZONE}`,
  pages: `page.${ZONE}`,
  companion: `si.${ZONE}`,
  push: `push.${ZONE}`,
  tunnel: TUNNEL_ZONE,
  // The staging Cloud is a Fly app; its name is the app name there.
  cloudStaging: "omb-cloud-staging.fly.dev",
  relayPattern: /^relay[1-9][0-9]?\.seira\.bot$/,
  relayNodePattern: /^(relay[1-9][0-9]?)\.seira\.bot$/,
});

export const seiraOrigin = (host) => `https://${host}`;

/** Services that answer for every user today. Add a name here in the release that follows the service going live. */
export const LIVE_SEIRA_SERVICES = Object.freeze(["site", "cloud", "apps", "updates", "serverTunnel"]);

/** The environment variable that names a service of one's own, for self-hosting and development. */
export const SEIRA_SERVICE_OVERRIDE_ENV = Object.freeze({
  cloud: "SEIRA_CLOUD_ORIGIN",
  apps: "SEIRA_COMPOSIO_BROKER_URL",
  updates: "SEIRA_UPDATES_ORIGIN",
  accounts: "SEIRA_CONTROL_PLANE_URL",
  serverTunnel: "SEIRA_CONTROL_PLANE_URL",
  push: "SEIRA_PUSH_RELAY_URL",
});

/** True when the service is in the live list (`live`, for tests), or the environment names an address for it. */
export function seiraServiceLive(name, env = {}, live = LIVE_SEIRA_SERVICES) {
  if (live.includes(name)) return true;
  const variable = SEIRA_SERVICE_OVERRIDE_ENV[name];
  return Boolean(variable) && typeof env?.[variable] === "string" && env[variable].trim() !== "";
}
