import type { IncomingMessage } from "node:http";

import type { RequestAuth } from "../request-auth.ts";

/** Security: a bot's own shell must never approve or undo its own card, so a local request counts only from the desktop
 * app, or from a browser while every bot is idle. */
export function ownerReview(auth: RequestAuth, req: IncomingMessage, local: { desktopManaged: boolean; anyBotWorking(): boolean }): boolean {
  return auth.kind === "loopback"
    ? local.desktopManaged || (Boolean(req.headers.origin) && !local.anyBotWorking())
    : auth.scopes.includes("admin");
}
