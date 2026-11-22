// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fixture = vi.hoisted(() => ({ calls: [] as Array<{ path: string; init?: { method?: string; body?: string } }>, people: {} as Record<string, string[]>, members: [] as string[], fail: false }));
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, init });
    if (path === "/api/config" && init?.method === "PUT") {
      if (fixture.fail) throw new Error("config refused");
      fixture.members = (JSON.parse(init.body!) as { signIn: { members: string[] } }).signIn.members;
      return {};
    }
    if (path === "/api/config") return { signIn: { admins: ["boss@acme.test"], members: fixture.members } };
    if (path === "/api/department-access" && init?.method === "PUT") {
      const { entry, departments } = JSON.parse(init.body!) as { entry: string; departments: string[] | null };
      if (departments) fixture.people[entry] = departments; else delete fixture.people[entry];
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
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;
const writes = () => fixture.calls.filter((call) => call.init?.method === "PUT").map((call) => call.path);

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

describe("inviting a person to chosen departments", () => {
  it("saves who they see before it adds them to the sign-in list", async () => {
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Email or @domain"]')!, "ada@acme.test");
    await choose(host.querySelector<HTMLSelectElement>('select[aria-label="Who they can see"]')!, "chosen");
    const boxes = host.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    expect(boxes).toHaveLength(3);
    await click(boxes[1]!);
    expect(host.textContent).toContain("Bots in Sales can still read files outside their folders.");
    await click(button("Invite"));
    expect(writes()).toEqual(["/api/department-access", "/api/config"]);
    expect(JSON.parse(fixture.calls.find((call) => call.path === "/api/department-access" && call.init)!.init!.body!)).toEqual({ entry: "ada@acme.test", departments: ["Sales"] });
    expect(host.querySelector("[data-person-access]")?.textContent).toBe("Sales");
  });

  it("does not add the person when the choice cannot be saved first", async () => {
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Email or @domain"]')!, "ada@acme.test");
    await choose(host.querySelector<HTMLSelectElement>('select[aria-label="Who they can see"]')!, "chosen");
    await click(button("Invite"));
    expect(host.textContent).toContain("Choose at least one department.");
    expect(writes()).toEqual([]);
  });

  it("disables the choice for an admin and says why", async () => {
    await choose(host.querySelector<HTMLSelectElement>('select[aria-label="Role"]')!, "admin");
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="Who they can see"]')!.disabled).toBe(true);
    expect(host.textContent).toContain("Admins see the whole team.");
  });
});

describe("changing and removing a user's access", () => {
  beforeEach(async () => {
    fixture.members = ["ada@acme.test"];
    fixture.people = { "ada@acme.test": ["Sales"] };
    await click(button("Refresh"));
  });

  it("shows the departments of a user and saves a change", async () => {
    expect(host.querySelector("[data-person-access]")?.textContent).toBe("Sales");
    await click(button("Change access"));
    const editor = host.querySelector("[data-person-access-editor]")!;
    await choose(editor.querySelector<HTMLSelectElement>("select")!, "whole");
    await click([...editor.querySelectorAll("button")].find((node) => node.textContent === "Save")!);
    expect(fixture.people).toEqual({});
    expect(host.querySelector("[data-person-access]")?.textContent).toBe("Whole team");
  });

  it("takes the person off the sign-in list before it removes their departments", async () => {
    fixture.calls = [];
    await click([...host.querySelectorAll("button")].filter((node) => node.textContent === "Remove")[1]!);
    expect(writes()).toEqual(["/api/config", "/api/department-access"]);
    expect(fixture.people).toEqual({});
  });
});
