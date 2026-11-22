// A saved number of GB for bot memory must fit the machine (AC-09, AC-10).
import { describe, expect, it } from "vitest";

import { GIB, machineMemoryBytes, maxBotMemoryGb } from "../bot-memory-budget.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

async function send(body: unknown, method: string) {
  const replies: Array<{ status: number; body: unknown }> = [];
  const route = createConfigRoutes({} as unknown as ConfigRouteDeps);
  const auth: RequestAuth = { kind: "session", session: { id: "admin", scopes: ["admin", "client"] } as never, via: "bearer", scopes: ["admin", "client"] };
  await route({
    req: {}, res: {}, url: new URL("http://host/api/config"), path: "/api/config", method, auth,
    json: (_res: unknown, status: number, reply: unknown) => { replies.push({ status, body: reply }); },
    readBody: async () => body,
  } as unknown as Parameters<typeof route>[0]);
  return replies;
}

describe("the memory limit for bots in /api/config", () => {
  const machineGb = maxBotMemoryGb(machineMemoryBytes());

  it.each(["PATCH", "PUT"])("refuses 0.5 GB and more than the machine with %s", async (method) => {
    for (const botMemoryGb of [0.5, machineMemoryBytes() / GIB + 1]) {
      const replies = await send({ botMemoryGb }, method);
      expect(replies).toEqual([{ status: 400, body: { error: `Enter a number of GB from 1 to ${machineGb}.`, errorKey: "serverError.botMemory.range", errorParams: { max: machineGb } } }]);
    }
  });
});
