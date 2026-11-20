import { describe, expect, it } from "vitest";

import { brokerClient } from "./app-trigger-broker.ts";

describe("brokerClient poll", () => {
  it("sends the poller id in the header the deployed service reads and in the current one", async () => {
    const seen: Headers[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ events: [], cursor: 0 });
    }) as typeof fetch;
    await brokerClient(() => ({ url: "https://broker.example", token: "t" }), fetchImpl).poll({ after: 0, waitS: 0, poller: "poller-main-0001" });
    expect(seen[0]?.get("x-seira-poller")).toBe("poller-main-0001");
    expect(seen[0]?.get("x-omb-poller")).toBe("poller-main-0001");
  });
});
