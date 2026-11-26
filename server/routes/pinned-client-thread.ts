import type { IncomingMessage } from "node:http";

import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { fromPairedDevice } from "./paired-device.ts";
import { PublicError } from "../public-error.ts";

export function pinnedClientThreadGuard(store: Pick<Store, "tasks">) {
  return (auth: RequestAuth, req: IncomingMessage) => {
    const requirePinnedClientThread = (botId: string, threadId: unknown): void => {
      if (threadId === undefined &&
        (auth.kind === "session" || fromPairedDevice(req, auth)) &&
        store.tasks(botId).length > 1) {
        throw new PublicError("This bot has more than one thread. Update the Seira app on this device, then choose a thread and try again.", 409);
      }
    };
    return requirePinnedClientThread;
  };
}
