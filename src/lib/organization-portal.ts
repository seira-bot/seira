import { SEIRA_HOSTS, seiraOrigin, seiraServiceLive } from "../../electron/seira-hosts.mjs";

export const DEFAULT_ADMIN_ORIGIN = seiraOrigin(SEIRA_HOSTS.admin);

/** Whether a work sign-in can start without the person typing an address. */
export const defaultPortalOffered = (): boolean => seiraServiceLive("admin");
