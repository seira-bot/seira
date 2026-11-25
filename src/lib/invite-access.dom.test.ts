// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ admin: true as boolean | null, config: {} as unknown }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: fixture.config }, dispatch: () => {} }) }));
vi.mock("./use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

beforeEach(() => {
  fixture.admin = true;
  fixture.config = {};
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { ogb?: unknown }).ogb;
});

/** A fresh copy of the module, so each call reads the environment again. */
async function mayInvite(environment: unknown): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("fetch", async () => ({ ok: environment !== null, json: async () => environment }));
  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useMayInvite } = await import("./invite-access");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const Probe = () => createElement("span", null, String(useMayInvite()));
  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const text = host.textContent ?? "";
  await act(async () => root.unmount());
  host.remove();
  return text;
}

it("AC-23 turns on once the server says it signs in by email", async () => {
  expect(await mayInvite({ capabilities: { emailSignIn: true } })).toBe("true");
});

it("AC-23 stays off on a server without email sign-in, on a Team Cloud, and when the server does not answer", async () => {
  expect(await mayInvite({ capabilities: {} })).toBe("false");
  expect(await mayInvite({ capabilities: { emailSignIn: true, cloudTeam: true } })).toBe("false");
  expect(await mayInvite(null)).toBe("false");
});

it("AC-23 stays off in the desktop app", async () => {
  (window as unknown as { ogb: unknown }).ogb = {};
  expect(await mayInvite({ capabilities: { emailSignIn: true } })).toBe("false");
});
