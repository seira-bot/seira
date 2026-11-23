// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { LinkedServer } from "./LinkedServersSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; method: string; body?: unknown };
const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  links: [] as unknown[],
  refuse: new Map<string, string>(),
  loadFails: false,
}));

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: [{ id: "ops", name: "Ops" }, { id: "scribe", name: "Scribe" }, { id: "ada", name: "Ada" }] } }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    fixture.calls.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const refused = fixture.refuse.get(`${method} ${path}`);
    if (refused) throw new Error(refused);
    if (method === "GET") {
      if (fixture.loadFails) throw new Error("");
      return { servers: fixture.links };
    }
    if (path === "/api/linked-servers/invites") return { invite: "seira-link:abc123", expiresAt: Date.now() + 15 * 60_000 };
    return { ok: true };
  },
}));

const { LinkedServersSection, inviteMinutes } = await import("./LinkedServersSection");

const link = (over: Partial<LinkedServer> = {}): LinkedServer => ({
  id: "0123456789abcdef", name: "Studio Seira", state: "online", exposed: ["ops"], cap: "edits",
  bots: [{ id: "far1", name: "Planner" }, { id: "far2", name: "Painter" }], ...over,
});

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element | undefined) => { await act(async () => { (node as HTMLElement).click(); }); await settle(); };
const type = async (field: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
const writes = (): Call[] => fixture.calls.filter((call) => call.method !== "GET");
const text = () => document.body.textContent ?? "";

async function open(links: LinkedServer[] = [link()]) {
  fixture.links = links;
  await act(async () => { root.render(createElement(LinkedServersSection)); });
  await settle();
}

beforeEach(() => {
  setLocale("en");
  fixture.calls = [];
  fixture.links = [];
  fixture.refuse = new Map();
  fixture.loadFails = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the list of links", () => {
  it("shows the name, the state, the bots it may use, the approval limit and the other side's bots", async () => {
    await open();
    expect(text()).toContain("Studio Seira");
    expect(text()).toContain("Connected");
    expect(text()).toContain("The other side can use: Ops");
    expect(text()).toContain("Most it may do without asking: Edit without asking");
    const theirs = host.querySelector("[data-linked-theirs]")!;
    expect(theirs.tagName).toBe("DETAILS");
    expect(theirs.querySelector("summary")!.textContent).toBe("Bots on the other side you can use: 2");
    expect(theirs.textContent).toContain("Planner");
  });

  it("says what the other side can use when nothing is chosen, and drops a bot that is gone", async () => {
    await open([link({ exposed: ["gone"] })]);
    expect(text()).toContain("The other side can use none of your bots");
  });

  it("gives an empty list one sentence and the two actions", async () => {
    await open([]);
    expect(host.querySelector("[data-settings-empty]")!.textContent).toBe("No links yet. Make an invite for another Seira, or join with an invite you were given.");
    expect(button("Make an invite")).toBeDefined();
    expect(button("Join with an invite")).toBeDefined();
  });

  it("explains an ended link and disables Change for it", async () => {
    await open([link({ state: "ended" })]);
    expect(text()).toContain("The other side ended this link. Remove it to make a new one.");
    expect(button("Change")!.disabled).toBe(true);
    expect(button("Change")!.title).toContain("ended this link");
  });

  it("shows the reason and a retry when the list does not load", async () => {
    fixture.loadFails = true;
    await open();
    expect(host.querySelector("[role=alert]")!.textContent).toContain("Something went wrong. Try again.");
    fixture.loadFails = false;
    await click(button("Try again"));
    expect(text()).toContain("Studio Seira");
  });
});

describe("making an invite", () => {
  it("shows the invite with a copy control and says it works once and for a short time", async () => {
    await open([]);
    await click(button("Make an invite"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/invites", method: "POST", body: {} }]);
    expect(host.querySelector("[data-linked-invite-text]")!.textContent).toBe("seira-link:abc123");
    expect(text()).toContain("It works once and stops working in 15 min.");
    expect(button("Copy")).toBeDefined();
    await click(button("Done"));
    expect(host.querySelector("[data-linked-invite]")).toBeNull();
  });

  it("shows the plain text of a refused invite and no invite", async () => {
    fixture.refuse.set("POST /api/linked-servers/invites", "Give this place a secure public address first.");
    await open([]);
    await click(button("Make an invite"));
    expect(host.querySelector("[role=alert]")!.textContent).toBe("Give this place a secure public address first.");
    expect(host.querySelector("[data-linked-invite]")).toBeNull();
  });

  it("counts the minutes left, at least one", () => {
    expect(inviteMinutes(1_000_000 + 15 * 60_000, 1_000_000)).toBe(15);
    expect(inviteMinutes(1_000_000 + 5_000, 1_000_000)).toBe(1);
  });
});

describe("joining with an invite", () => {
  it("sends the pasted text, closes the form and lists the new link", async () => {
    await open([]);
    await click(button("Join with an invite"));
    expect(button("Join")!.disabled).toBe(true);
    await type(host.querySelector("textarea")!, "  seira-link:xyz  ");
    fixture.links = [link()];
    await click(button("Join"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/join", method: "POST", body: { invite: "seira-link:xyz" } }]);
    expect(host.querySelector("[data-linked-join]")).toBeNull();
    expect(text()).toContain("Studio Seira");
  });

  it("keeps the form and the text, and shows the reason, when the invite is refused", async () => {
    fixture.refuse.set("POST /api/linked-servers/join", "That invite is not valid any more. Ask for a new one.");
    await open([]);
    await click(button("Join with an invite"));
    await type(host.querySelector("textarea")!, "seira-link:old");
    await click(button("Join"));
    expect(host.querySelector("[data-linked-join] [role=alert]")!.textContent).toBe("That invite is not valid any more. Ask for a new one.");
    expect(host.querySelector("textarea")!.value).toBe("seira-link:old");
    expect(button("Join")!.disabled).toBe(false);
  });

  it("closes the form on Cancel without a request", async () => {
    await open([]);
    await click(button("Join with an invite"));
    await click(button("Cancel"));
    expect(host.querySelector("[data-linked-join]")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("changing a link", () => {
  it("saves the chosen bots and the approval limit", async () => {
    await open();
    await click(button("Change"));
    const boxes = [...host.querySelectorAll<HTMLInputElement>("[data-linked-edit] input[type=checkbox]")];
    expect(boxes.map((box) => box.checked)).toEqual([true, false, false]);
    await click(boxes[2]);
    await click(boxes[0]);
    await choose(host.querySelector<HTMLSelectElement>("[data-linked-edit] select")!, "ask");
    expect(host.querySelector("[data-linked-cap-note]")!.textContent).toBe("A person here approves every command and every file change. This is the most that work from the other side may do here without a person here approving it.");
    await click(button("Save"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/0123456789abcdef", method: "PATCH", body: { exposed: ["ada"], cap: "ask" } }]);
    expect(host.querySelector("[data-linked-edit]")).toBeNull();
  });

  it("warns in plain words that the highest limit runs commands without asking", async () => {
    await open();
    await click(button("Change"));
    await choose(host.querySelector<HTMLSelectElement>("[data-linked-edit] select")!, "auto");
    expect(host.querySelector("[data-linked-cap-note]")!.textContent).toContain("An automatic review lets routine commands run");
  });

  it("leaves out a bot that no longer exists, so the save is not refused for it", async () => {
    await open([link({ exposed: ["ops", "gone"] })]);
    await click(button("Change"));
    await click(button("Save"));
    expect((writes()[0]!.body as { exposed: string[] }).exposed).toEqual(["ops"]);
  });

  it("keeps the editor open with the server's reason when the change is refused", async () => {
    fixture.refuse.set("PATCH /api/linked-servers/0123456789abcdef", "One of those bots is not on this place.");
    await open();
    await click(button("Change"));
    await click(button("Save"));
    expect(host.querySelector("[data-linked-edit] [role=alert]")!.textContent).toBe("One of those bots is not on this place.");
    expect(host.querySelector("[data-linked-edit]")).not.toBeNull();
  });

  it("closes the editor on Cancel without a request", async () => {
    await open();
    await click(button("Change"));
    await click(button("Cancel"));
    expect(host.querySelector("[data-linked-edit]")).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe("removing a link", () => {
  it("says what stops, and removes it only after the confirm", async () => {
    await open();
    await click(button("Remove…"));
    const dialog = document.body.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Remove the link to Studio Seira?");
    expect(dialog.textContent).toContain("Work that this link started stops now, and the other side can no longer use your bots.");
    expect(writes()).toEqual([]);
    fixture.links = [];
    await click(button("Remove link"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/0123456789abcdef", method: "DELETE", body: undefined }]);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(text()).toContain("No links yet.");
  });

  it("closes on Cancel and removes nothing", async () => {
    await open();
    await click(button("Remove…"));
    await click(document.body.querySelector("[role=dialog] button[data-autofocus]")!);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("keeps the dialog open with the reason when the removal is refused", async () => {
    fixture.refuse.set("DELETE /api/linked-servers/0123456789abcdef", "That link is not here.");
    await open();
    await click(button("Remove…"));
    await click(button("Remove link"));
    expect(document.body.querySelector("[role=dialog] [role=alert]")!.textContent).toBe("That link is not here.");
  });
});
