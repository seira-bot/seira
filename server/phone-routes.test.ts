import { describe, expect, it } from "vitest";

import { phoneRoutes, phoneRoutesFromEnv } from "./phone-routes.ts";

const TAILNET = "https://box.tail1234.ts.net";
const TUNNEL = `https://c-${"a".repeat(32)}.seira.run`;
const DOMAIN = "https://seira.example.com";

describe("phoneRoutes", () => {
  it("orders tailnet, own domain, then tunnel, and opens on the first route that is not a tailnet name", () => {
    const routes = phoneRoutes({ publicUrl: TUNNEL, tailnetOrigin: null, customDomain: DOMAIN, extra: [TAILNET] });
    expect(routes.endpoints).toEqual([
      { url: TAILNET, kind: "hosted", priority: 0 },
      { url: DOMAIN, kind: "hosted", priority: 1 },
      { url: TUNNEL, kind: "hosted", priority: 2 },
    ]);
    expect(routes.primary).toBe(DOMAIN);
  });

  it("opens on the tunnel when a tailnet name and a tunnel are the only routes", () => {
    const routes = phoneRoutes({ publicUrl: TUNNEL, tailnetOrigin: TAILNET, customDomain: null });
    expect(routes.endpoints.map((endpoint) => endpoint.url)).toEqual([TAILNET, TUNNEL]);
    expect(routes.primary).toBe(TUNNEL);
  });

  it("opens on the tailnet route when it is the only one", () => {
    const routes = phoneRoutes({ publicUrl: TAILNET, tailnetOrigin: TAILNET, customDomain: null });
    expect(routes.endpoints).toEqual([{ url: TAILNET, kind: "hosted", priority: 0 }]);
    expect(routes.primary).toBe(TAILNET);
  });

  it("removes a repeated route and drops anything that is not an https origin", () => {
    const routes = phoneRoutes({ publicUrl: `${DOMAIN}/`, tailnetOrigin: "http://100.64.0.2:8799", customDomain: DOMAIN, extra: ["not a url", "http://box.local", `${DOMAIN}/path`] });
    expect(routes.endpoints.map((endpoint) => endpoint.url)).toEqual([DOMAIN]);
  });

  it("returns no route and no primary when nothing is https", () => {
    expect(phoneRoutes({ publicUrl: "http://192.168.1.4:8799", tailnetOrigin: null, customDomain: null })).toEqual({ endpoints: [], primary: null });
  });

  it("carries at most 8 routes", () => {
    const extra = Array.from({ length: 12 }, (_, index) => `https://h${index}.example.com`);
    expect(phoneRoutes({ publicUrl: null, tailnetOrigin: null, customDomain: null, extra }).endpoints).toHaveLength(8);
  });
});

describe("phoneRoutesFromEnv", () => {
  it("splits SEIRA_PHONE_ROUTES on commas and ignores blanks", () => {
    expect(phoneRoutesFromEnv({ SEIRA_PHONE_ROUTES: ` ${TAILNET}, ,${DOMAIN}` })).toEqual([TAILNET, DOMAIN]);
    expect(phoneRoutesFromEnv({})).toEqual([]);
  });
});
