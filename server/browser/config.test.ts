import { describe, expect, it } from "vitest";

import { browserEngineChoice, browserEngineConfigSchema, effectiveBrowserEngine } from "./config.ts";

describe("browser engine proxy configuration", () => {
  it("accepts an unauthenticated SOCKS5 endpoint", () => {
    expect(browserEngineConfigSchema.parse({ egress: { proxy: "socks5://127.0.0.1:1080" } }).egress?.proxy)
      .toBe("socks5://127.0.0.1:1080");
  });

  it("rejects credentials, other protocols, and invalid ports", () => {
    for (const proxy of ["http://127.0.0.1:8080", "socks5://user:pass@proxy.example:1080", "socks5://proxy.example:0", "socks5://proxy.example:65536", "socks5://..example:1080", "socks5://[:::]:1080"]) {
      expect(browserEngineConfigSchema.safeParse({ egress: { proxy } }).success, proxy).toBe(false);
    }
  });
});

describe("the engine that runs the bots' browsers", () => {
  const has = (chrome: boolean) => () => chrome;

  it("is Seira's own driver when nothing is chosen and this host has a Chrome for it", () => {
    expect(browserEngineChoice({})).toBeNull();
    expect(effectiveBrowserEngine({}, has(true))).toBe("chrome");
    expect(effectiveBrowserEngine({ browserEngine: { idleTimeoutMinutes: 5 } }, has(true))).toBe("chrome");
  });

  it("is agent-browser when nothing is chosen and this host has no Chrome for Seira's driver", () => {
    expect(effectiveBrowserEngine({}, has(false))).toBe("agent-browser");
  });

  it("is agent-browser when the person chose it, even where Seira's driver has a Chrome", () => {
    expect(effectiveBrowserEngine({ browserEngine: { engine: "agent-browser" } }, has(true))).toBe("agent-browser");
  });

  it("is Seira's own driver when the person chose it, without asking the host", () => {
    let asked = false;
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, () => { asked = true; return false; })).toBe("chrome");
    expect(asked).toBe(false);
  });

  it("is agent-browser when the host boxes its browsers, whatever is chosen or found", () => {
    expect(effectiveBrowserEngine({}, has(true), { boxed: true })).toBe("agent-browser");
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { boxed: true })).toBe("agent-browser");
    expect(effectiveBrowserEngine({ browserEngine: { engine: "chrome" } }, has(true), { boxed: false })).toBe("chrome");
  });
});
