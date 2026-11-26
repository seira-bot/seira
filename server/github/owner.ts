import { personKey } from "../person-key.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { GithubStoreData } from "./store.ts";

export const LOCAL_OWNER_KEY = "local";

/** Who is asking: a signed-in person by email, the desktop owner and the owner's paired devices as "local".
 * Null for a service caller, a guest and a client-only session. */
export function requesterKey(auth: RequestAuth): string | null {
  if (auth.kind === "session" && auth.session.email) return personKey(auth.session);
  return ownerOrAdmin(auth) ? LOCAL_OWNER_KEY : null;
}

export function requesterLabel(auth: RequestAuth, profileName?: string): string {
  if (auth.kind === "session" && auth.session.email) return auth.session.email.split("@")[0]!.trim() || "the owner";
  return profileName?.trim() || "the owner";
}

export function isConnectionOwner(auth: RequestAuth, store: Pick<GithubStoreData, "ownerKey">): boolean {
  const key = requesterKey(auth);
  return key !== null && key === store.ownerKey && ownerOrAdmin(auth);
}

export function canConnect(auth: RequestAuth, store: Pick<GithubStoreData, "ownerKey">): boolean {
  return store.ownerKey === undefined ? ownerOrAdmin(auth) : isConnectionOwner(auth, store);
}
