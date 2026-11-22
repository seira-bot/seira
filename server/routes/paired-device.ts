import type { IncomingMessage } from "node:http";

import type { RequestAuth } from "../request-auth.ts";
import { isPairedDeviceSession } from "../sessions.ts";

const DEVICE_ID = /^[\w-]{1,128}$/;

/** Security invariant: the paired-device limits come from the session's pairing record or the companion's verified
 * device. The companion header can add the limits to any request; it never removes them and never grants a right. */
export const fromPairedDevice = (req: IncomingMessage, auth: RequestAuth): boolean =>
  (auth.kind === "session" ? isPairedDeviceSession(auth.session) : Boolean(auth.companionDevice)) ||
  req.headers["x-seira-companion"] === "1";

/** The phone the companion speaks for. A session names none, whatever headers it sends. A plain loopback request
 * names one by header: a standalone server's companion holds no token to prove it. */
export function companionDeviceOf(req: IncomingMessage, auth: RequestAuth): string | undefined {
  if (auth.kind !== "loopback") return undefined;
  if (auth.companionDevice) return auth.companionDevice;
  if (req.headers["x-seira-companion"] !== "1") return undefined;
  const device = req.headers["x-seira-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? device : undefined;
}
