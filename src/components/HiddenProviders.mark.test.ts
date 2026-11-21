import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: { instances: [] }, refreshInstances: vi.fn() }),
}));

const { HiddenProviderRows } = await import("./HiddenProviders");
const OPENAI_BLOSSOM = 'd="M239.184 106.203';

describe("a hidden provider's mark", () => {
  it("is the mark the provider shows when shown", () => {
    const html = renderToStaticMarkup(createElement(HiddenProviderRows, {
      hidden: [{ instanceId: "openai", driverKind: "openai-compat", displayName: "OpenAI", icon: { kind: "preset", preset: "openai" } }],
    }));
    expect(html).toContain(OPENAI_BLOSSOM);
    expect(html).not.toContain("lucide-server");
  });

  it("falls back to the engine's own mark when the server sends none", () => {
    const html = renderToStaticMarkup(createElement(HiddenProviderRows, { hidden: [{ instanceId: "compat", driverKind: "openai-compat", displayName: "Server" }] }));
    expect(html).toContain("lucide-server");
  });
});
