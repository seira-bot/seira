import type { IncomingMessage } from "node:http";

import type { RequestAuth } from "../request-auth.ts";

export const fromPairedDevice = (req: IncomingMessage, auth: RequestAuth): boolean =>
  req.headers["x-seira-companion"] === "1" || (auth.kind === "loopback" && Boolean(auth.companionDevice));
