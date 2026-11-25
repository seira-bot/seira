// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeoplePlanStatus } from "../../shared/people-plan";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UPGRADE = "https://upgrade.example/premium";
const base: PeoplePlanStatus = { applies: true, plan: "free", people: 3, limit: 5, full: false, joined: [], key: null, upgradeUrl: UPGRADE };
const longDate = (day: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeZone: "UTC" }).format(Date.parse(`${day}T00:00:00Z`));

const fixture = vi.hoisted(() => ({
  plan: null as unknown,
  calls: [] as Array<{ path: string; init?: { method?: string; body?: string } }>,
  keyResult: null as unknown,
  keyError: null as Error | null,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, init });
    if (path === "/api/people/plan/key") {
      if (fixture.keyError) throw fixture.keyError;
      return fixture.keyResult;
    }
    if (path === "/api/people/plan/remove") {
      fixture.plan = { ...(fixture.plan as PeoplePlanStatus), joined: [], people: 3 };
      return fixture.plan;
    }
    if (path === "/api/people/plan") return fixture.plan;
    if (path === "/api/config") return { signIn: { admins: ["boss@acme.test"], members: [] } };
    if (path === "/api/auth/sessions") return { sessions: [] };
    if (path === "/api/usage?groupBy=user") return { groups: [] };
    return null;
  },
}));
vi.mock("../lib/session", async (original) => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => ({ kind: "loopback" }) }));
const { PeoplePlan } = await import("./PeoplePlan");
const { PeopleSection } = await import("./PeopleSection");

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const render = async (node: ReturnType<typeof createElement>) => { await act(async () => { root.render(node); }); await settle(); };
const showPlan = (plan: PeoplePlanStatus | null, onChange = vi.fn()) => render(createElement(PeoplePlan, { plan, onChange }));
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await settle(); };
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;

beforeEach(() => {
  vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => null }));
  fixture.calls = [];
  fixture.keyError = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  host.remove();
});

describe("PeoplePlan", () => {
  it("AC-19: the free plan shows 3 of 5 people", async () => {
    await showPlan(base);
    expect(host.textContent).toContain("3 of 5 people");
  });

  it("AC-20: at 5 of 5 the Invite button is disabled, says why, and links to the upgrade page", async () => {
    fixture.plan = { ...base, people: 5, full: true };
    await render(createElement(PeopleSection, { startOpen: true }));
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Email or @domain"]')!, "new@acme.test");
    const invite = button("Invite") as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    const reason = host.querySelector(`#${invite.getAttribute("aria-describedby")}`)!;
    expect(reason.textContent).toContain("Your plan includes 5 people. Upgrade to add more.");
    expect(reason.querySelector("a")!.getAttribute("href")).toBe(UPGRADE);
  });

  it("AC-21: Premium shows unlimited people and the end date", async () => {
    await showPlan({ ...base, plan: "premium", people: 9, key: { state: "active", source: "settings", endsOn: "2027-06-30", daysLeft: 200 } });
    expect(host.textContent).toContain("Premium · unlimited people");
    expect(host.textContent).toContain(`Until ${longDate("2027-06-30")}`);
    expect(host.textContent).not.toContain("Renew");
  });

  it("AC-13: a key that ends within 30 days shows the end date and a Renew link", async () => {
    await showPlan({ ...base, plan: "premium", key: { state: "endingSoon", source: "settings", endsOn: "2027-01-10", daysLeft: 12 } });
    expect(host.textContent).toContain(`Premium ends on ${longDate("2027-01-10")}. Renew to keep unlimited people.`);
    const renew = [...host.querySelectorAll("a")].find((node) => node.textContent?.includes("Renew"))!;
    expect(renew.getAttribute("href")).toBe(UPGRADE);
  });

  it("AC-14: a key from the server setup is read-only and has no key input", async () => {
    await showPlan({ ...base, plan: "premium", key: { state: "active", source: "environment", endsOn: "2027-06-30", daysLeft: 200 } });
    expect(host.textContent).toContain("can't be changed here");
    expect(host.querySelector("input")).toBeNull();
  });

  it("shows an unlimited plan without a key field", async () => {
    await showPlan({ ...base, plan: "unlimited" });
    expect(host.textContent).toContain("Unlimited people");
    expect(host.querySelector("input")).toBeNull();
  });

  it("renders nothing when the plan is missing or does not apply", async () => {
    await showPlan(null);
    expect(host.innerHTML).toBe("");
    await showPlan({ ...base, applies: false });
    expect(host.innerHTML).toBe("");
  });

  it("shows a refused key as an alert", async () => {
    fixture.keyError = new Error("That key does not work.");
    await showPlan(base);
    await type(host.querySelector<HTMLInputElement>("input")!, "bad-key");
    await click(button("Save"));
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("That key does not work.");
    expect(host.querySelector<HTMLInputElement>("input")!.getAttribute("autocomplete")).toBe("off");
  });

  it("shows that a saved key is on, clears the field, and passes the new status up", async () => {
    const next: PeoplePlanStatus = { ...base, plan: "premium", key: { state: "active", source: "settings", endsOn: "2027-06-30", daysLeft: 200 } };
    fixture.keyResult = next;
    const onChange = vi.fn();
    await showPlan(base, onChange);
    await type(host.querySelector<HTMLInputElement>("input")!, "good-key");
    await click(button("Save"));
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Premium is on. Add as many people as you need.");
    expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
    expect(onChange).toHaveBeenCalledWith(next);
    expect(JSON.parse(fixture.calls[0]!.init!.body!)).toEqual({ key: "good-key" });
  });
});

describe("a person who joined through a domain", () => {
  it("shows the domain and removes the person through the plan", async () => {
    fixture.plan = { ...base, people: 4, joined: [{ email: "zoe@corp.test", via: "@corp.test", role: "member", lastSeenAt: null, devices: 1 }] };
    await render(createElement(PeopleSection, { startOpen: true }));
    expect(host.querySelector("[data-person-via]")!.textContent).toBe("Signed in through @corp.test");
    expect(host.textContent).toContain("zoe@corp.test");
    await click([...host.querySelectorAll("button")].filter((node) => node.textContent === "Remove")[1]!);
    const call = fixture.calls.find((entry) => entry.path === "/api/people/plan/remove")!;
    expect(call.init!.method).toBe("POST");
    expect(JSON.parse(call.init!.body!)).toEqual({ email: "zoe@corp.test" });
    expect(host.querySelector("[data-person-via]")).toBeNull();
  });
});
