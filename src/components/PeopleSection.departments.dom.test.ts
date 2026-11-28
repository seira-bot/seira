// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: { method?: string; body?: string } }>, people: {} as Record<string, unknown>, members: [] as string[], fail: false }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: [{ id: "ani", name: "Ani", section: "Sales" }], config: null }, dispatch: () => {} }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, init });
    if (path === "/api/config" && init?.method === "PUT") {
      if (fixture.fail) throw new Error("config refused");
      fixture.members = (JSON.parse(init.body!) as { signIn: { members: string[] } }).signIn.members;
      return {};
    }
    if (path === "/api/config") return { signIn: { admins: ["boss@acme.test"], members: fixture.members } };
    if (path === "/api/department-access" && init?.method === "PUT") {
      const { entry, access } = JSON.parse(init.body!) as { entry: string; access: unknown };
      if (access) fixture.people[entry] = access; else delete fixture.people[entry];
      return {};
    }
    if (path === "/api/department-access") return { available: true, people: fixture.people, unreadable: false };
    if (path === "/api/sidebar-sections") return { sections: ["Sales", "Finance"] };
    if (path === "/api/department-folders") return { departments: { Finance: { limited: true, folders: [] } }, enforcement: "box", setHere: true };
    if (path === "/api/auth/sessions") return { sessions: [] };
    if (path === "/api/usage?groupBy=user") return { groups: [] };
    return null;
  },
}));
vi.mock("../lib/session", async (original) => ({ ...await original<typeof import("../lib/session")>(), readSessionState: async () => ({ kind: "loopback" }) }));
const { PeopleSection } = await import("./PeopleSection");

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element) => { await act(async () => { (node as HTMLElement).click(); }); await settle(); };
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (label: string, within: ParentNode = host) => [...within.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
const dialog = () => document.body.querySelector<HTMLElement>("[data-invite-dialog]")!;
const radio = (label: string) => [...dialog().querySelectorAll("label")].find((node) => node.querySelector("[data-invite-kind]")?.textContent?.trim() === label)!.querySelector("input")!;
const writes = () => fixture.calls.filter((call) => call.init?.method === "PUT").map((call) => call.path);
const access = () => [...host.querySelectorAll("[data-person-access]")].map((node) => node.textContent)[1];

beforeEach(async () => {
  vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => null }));
  fixture.calls = [];
  fixture.people = {};
  fixture.members = [];
  fixture.fail = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(PeopleSection, { startOpen: true })); });
  await settle();
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  host.remove();
});

describe("the people list", () => {
  it("holds the Invite and Refresh buttons in one row that a plan limit can switch off", () => {
    const row = host.querySelector("[data-people-actions]")!;
    expect([...row.querySelectorAll("button")].map((node) => node.textContent?.trim() || node.getAttribute("aria-label"))).toEqual(["Invite", "Refresh"]);
    expect(host.querySelector("form, input")).toBeNull();
  });

  it("AC-01 opens the dialog, saves the access before the sign-in list, and lists the new access", async () => {
    await click(button("Invite"));
    await type(dialog().querySelector<HTMLInputElement>("input[dir=auto]")!, "ada@acme.test");
    await click(radio("Chosen departments"));
    await click(dialog().querySelector('[data-invite-item="Sales"] input')!);
    await click(button("Invite", dialog()));
    expect(writes()).toEqual(["/api/department-access", "/api/config"]);
    expect(JSON.parse(fixture.calls.find((call) => call.path === "/api/department-access" && call.init)!.init!.body!)).toEqual({ entry: "ada@acme.test", access: { departments: [{ name: "Sales", level: "chat" }], bots: [] } });
    await click(button("Done", dialog()));
    expect(document.body.querySelector("[data-invite-dialog]")).toBeNull();
    expect(access()).toBe("Sales · Can chat");
  });
});

describe("changing and removing a user's access", () => {
  beforeEach(async () => {
    fixture.members = ["ada@acme.test"];
    fixture.people = { "ada@acme.test": { departments: [{ name: "Sales", level: "chat" }], bots: [{ id: "ani", level: "view" }] } };
    await click(button("Refresh"));
  });

  it("AC-22 shows the departments and bots of a user with their levels and saves a change", async () => {
    expect(access()).toBe("Sales · Can chat, Ani · Can view");
    await click(button("Change access"));
    expect(dialog().querySelector("h2")!.textContent).toBe("Change access");
    await click(radio("Whole team"));
    await click(button("Save", dialog()));
    expect(fixture.people).toEqual({});
    expect(access()).toBe("Whole team");
  });

  it("takes the person off the sign-in list before it removes their access", async () => {
    fixture.calls = [];
    await click([...host.querySelectorAll("button")].filter((node) => node.textContent === "Remove")[1]!);
    expect(writes()).toEqual(["/api/config", "/api/department-access"]);
    expect(fixture.people).toEqual({});
  });
});
