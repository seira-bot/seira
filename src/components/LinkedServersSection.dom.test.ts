// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { LinkedServer } from "./LinkedServersSection";
import type { A2aLink } from "./LinkedA2aForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; method: string; body?: unknown };
const fixture = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  links: [] as unknown[],
  refuse: new Map<string, string>(),
  answers: new Map<string, unknown>(),
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
    const answered = fixture.answers.get(`${method} ${path}`);
    if (answered) return answered;
    if (path === "/api/linked-servers/invites") return { invite: "seira-link:abc123", expiresAt: Date.now() + 15 * 60_000 };
    return { ok: true };
  },
}));

const { LinkedServersSection, inviteMinutes } = await import("./LinkedServersSection");

const link = (over: Partial<LinkedServer> = {}): LinkedServer => ({
  id: "0123456789abcdef", name: "Studio Seira", state: "online", exposed: ["ops"], cap: "edits",
  bots: [{ id: "far1", name: "Planner" }, { id: "far2", name: "Painter" }], ...over,
});

const agent = (over: Partial<A2aLink> = {}): A2aLink => ({
  id: "a2a0123456789abc", kind: "a2a", name: "Planner Agent", state: "online", exposed: ["ops"], cap: "ask",
  bots: [{ id: "far1", name: "Roadmap" }], createdAt: 1, outbound: null,
  inbound: { urls: [{ bot: "ops", url: "https://seira.example.test/a2a/ops" }] }, problem: null, ...over,
});

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element | undefined) => { await act(async () => { (node as HTMLElement).click(); }); await settle(); };
const type = async (field: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(field, value);
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

async function open(links: Array<LinkedServer | A2aLink> = [link()]) {
  fixture.links = links;
  await act(async () => { root.render(createElement(LinkedServersSection)); });
  await settle();
}

beforeEach(() => {
  setLocale("en");
  fixture.calls = [];
  fixture.links = [];
  fixture.refuse = new Map();
  fixture.answers = new Map();
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

  it("names Seira Relay for a link that goes through it, and keeps the plain texts for any other", async () => {
    let shown = 0;
    const show = async (one: LinkedServer) => {
      fixture.links = [one];
      await act(async () => { root.render(createElement(LinkedServersSection, { key: ++shown })); });
      await settle();
    };
    await show(link({ route: "relay" }));
    expect(text()).toContain("Connected through Seira Relay");
    await show(link({ route: "relay", state: "offline" }));
    expect(text()).toContain("The other side can’t be reached right now. It may be off, or it may have removed this link.");
    await show(link({ route: "relay", state: "ended" }));
    expect(text()).toContain("The other side ended this link. Remove it to make a new one.");
    expect(text()).not.toContain("Seira Relay");
    await show(link({ route: "https", state: "offline" }));
    expect(text()).toContain("The other side can’t be reached right now");
    expect(text()).not.toContain("It may be off");
    await show(link({ route: "https" }));
    expect(text()).toContain("Connected");
    expect(text()).not.toContain("Seira Relay");
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

  it("adds a note when the invite goes through Seira Relay, and only then", async () => {
    fixture.answers.set("POST /api/linked-servers/invites", { invite: "seira-link:abc123", expiresAt: Date.now() + 15 * 60_000, route: "relay" });
    await open([]);
    await click(button("Make an invite"));
    const note = host.querySelector("[data-linked-invite-relay]")!;
    expect(note.textContent).toBe("This invite goes through Seira Relay. The relay can’t read the work, the results or the files. It can see when the two sides talk and how much. The other Seira needs the newest version to use this invite.");
    await click(button("Done"));

    fixture.answers.set("POST /api/linked-servers/invites", { invite: "seira-link:abc123", expiresAt: Date.now() + 15 * 60_000, route: "https" });
    await click(button("Make an invite"));
    expect(host.querySelector("[data-linked-invite]")).not.toBeNull();
    expect(host.querySelector("[data-linked-invite-relay]")).toBeNull();
    await click(button("Done"));

    fixture.answers.delete("POST /api/linked-servers/invites");
    await click(button("Make an invite"));
    expect(host.querySelector("[data-linked-invite]")).not.toBeNull();
    expect(host.querySelector("[data-linked-invite-relay]")).toBeNull();
    expect(text()).not.toContain("Seira Relay");
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

describe("adding an A2A agent", () => {
  const form = () => host.querySelector<HTMLFormElement>("[data-linked-a2a-form]")!;
  const inputs = () => [...form().querySelectorAll<HTMLInputElement>("input")];
  const fill = async (name: string) => { await type(inputs()[0]!, name); };

  it("opens a form that cannot be sent without a name, a way to connect and an address, and says why", async () => {
    await open([]);
    await click(button("Add an A2A agent"));
    expect(button("Add agent")!.disabled).toBe(true);
    expect(host.querySelector("[data-linked-a2a-why]")!.textContent).toBe("Enter a name for the agent.");
    await fill("Planner Agent");
    expect(host.querySelector("[data-linked-a2a-why]")!.textContent).toBe("Enter the address of the agent.");
    await click(inputs()[1]);
    expect(button("Add agent")!.disabled).toBe(true);
    expect(button("Add agent")!.title).toBe("Turn on at least one way to connect.");
    expect(host.querySelector("[data-linked-a2a-why]")!.textContent).toBe("Turn on at least one way to connect.");
    await click(inputs()[1]);
    await click(inputs().find((box) => box.type === "checkbox" && box !== inputs()[1])!);
    expect(button("Add agent")!.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("sends only the fields that the server accepts, for an agent that this Seira calls", async () => {
    await open([]);
    await click(button("Add an A2A agent"));
    await fill("  Planner Agent ");
    const [, , address, token] = inputs();
    await type(address!, " https://agent.example.test/a2a ");
    await type(token!, "far-secret");
    fixture.links = [agent({ inbound: null, outbound: { url: "https://agent.example.test/a2a", hasToken: true } })];
    fixture.answers.set("POST /api/linked-servers/a2a", { server: fixture.links[0], urls: [] });
    await click(button("Add agent"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/a2a", method: "POST", body: { name: "Planner Agent", inbound: false, url: "https://agent.example.test/a2a", token: "far-secret" } }]);
    expect(host.querySelector("[data-linked-a2a-form]")).toBeNull();
    expect(host.querySelector("[data-linked-a2a-issued]")).toBeNull();
    expect(text()).toContain("This Seira calls the agent at https://agent.example.test/a2a");
  });

  it("leaves out the address and the token when this Seira does not call the agent", async () => {
    await open([]);
    await click(button("Add an A2A agent"));
    await fill("Planner Agent");
    await type(inputs()[2]!, "https://agent.example.test/a2a");
    await click(inputs()[1]);
    await click(inputs()[2]);
    fixture.answers.set("POST /api/linked-servers/a2a", { server: agent(), token: "t0ken", urls: [] });
    await click(button("Add agent"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/a2a", method: "POST", body: { name: "Planner Agent", inbound: true } }]);
  });

  it("shows the token once with its addresses, and drops it after Done", async () => {
    await open([]);
    await click(button("Add an A2A agent"));
    await fill("Planner Agent");
    await click(inputs()[1]);
    await click(inputs()[2]);
    fixture.answers.set("POST /api/linked-servers/a2a", { server: agent(), token: "t0ken-value", urls: [{ bot: "ops", url: "https://seira.example.test/a2a/ops" }] });
    await click(button("Add agent"));
    const box = host.querySelector("[data-linked-a2a-issued]")!;
    expect(box.querySelector("[data-linked-a2a-token]")!.textContent).toBe("t0ken-value");
    expect(box.textContent).toContain("Copy this token now. It shows only once, and you cannot see it again.");
    expect(box.textContent).toContain("Ops");
    expect(box.textContent).toContain("https://seira.example.test/a2a/ops");
    expect(box.querySelectorAll("button").length).toBe(3);
    await click(button("Done"));
    expect(host.querySelector("[data-linked-a2a-issued]")).toBeNull();
    expect(text()).not.toContain("t0ken-value");
  });

  it("tells the admin to choose bots when no address exists yet", async () => {
    await open([]);
    await click(button("Add an A2A agent"));
    await fill("Planner Agent");
    await click(inputs()[1]);
    await click(inputs()[2]);
    fixture.answers.set("POST /api/linked-servers/a2a", { server: agent({ exposed: [], inbound: { urls: [] } }), token: "t0ken", urls: [] });
    await click(button("Add agent"));
    expect(host.querySelector("[data-linked-a2a-issued]")!.textContent).toContain("Choose the bots that the agent may use. Each chosen bot then shows its address here.");
  });

  it("keeps the form and shows the server's sentence when the agent is refused", async () => {
    fixture.refuse.set("POST /api/linked-servers/a2a", "Check the name, the address and the token of the A2A agent.");
    await open([]);
    await click(button("Add an A2A agent"));
    await fill("Planner Agent");
    await type(inputs()[2]!, "http://agent.example.test");
    await click(button("Add agent"));
    expect(host.querySelector("[data-linked-a2a-form] [role=alert]")!.textContent).toBe("Check the name, the address and the token of the A2A agent.");
    expect(inputs()[0]!.value).toBe("Planner Agent");
    expect(button("Add agent")!.disabled).toBe(false);
  });
});

describe("an A2A agent in the list", () => {
  it("shows its kind, its problem, the bots it may use, the cap and its addresses", async () => {
    await open([agent({ state: "offline", problem: "The A2A agent could not be reached. Check the address.", outbound: { url: "https://agent.example.test/a2a", hasToken: false } })]);
    expect(host.querySelector("[data-linked-kind]")!.textContent).toBe("A2A agent");
    expect(host.querySelector("[data-linked-problem]")!.textContent).toBe("The A2A agent could not be reached. Check the address.");
    expect(text()).toContain("This Seira can’t reach the agent right now");
    expect(text()).toContain("The agent can use: Ops");
    expect(text()).toContain("Most it may do without asking: Ask first");
    expect(text()).toContain("This Seira calls the agent at https://agent.example.test/a2a");
    const addresses = host.querySelector("[data-linked-inbound]")!;
    expect(addresses.tagName).toBe("DETAILS");
    expect(addresses.querySelector("summary")!.textContent).toBe("Addresses for the agent: 1");
    expect(addresses.textContent).toContain("https://seira.example.test/a2a/ops");
    expect(button("New token…")).toBeDefined();
  });

  it("keeps a Seira link free of the agent parts", async () => {
    await open([link()]);
    expect(host.querySelector("[data-linked-kind]")).toBeNull();
    expect(button("New token…")).toBeUndefined();
  });

  it("offers no new token for an agent that this Seira only calls", async () => {
    await open([agent({ inbound: null, outbound: { url: "https://agent.example.test/a2a", hasToken: true } })]);
    expect(button("New token…")).toBeUndefined();
  });

  it("changes the bots and the limit of an agent in the same editor", async () => {
    await open([agent()]);
    await click(button("Change"));
    await click(host.querySelectorAll<HTMLInputElement>("[data-linked-edit] input[type=checkbox]")[1]);
    await click(button("Save"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/a2a0123456789abc", method: "PATCH", body: { exposed: ["ops", "scribe"], cap: "ask" } }]);
  });

  it("makes a new token only after the confirm, and shows it once", async () => {
    await open([agent()]);
    await click(button("New token…"));
    const dialog = document.body.querySelector("[role=dialog]")!;
    expect(dialog.textContent).toContain("Make a new token for Planner Agent?");
    expect(dialog.textContent).toContain("The old token stops working at once.");
    expect(writes()).toEqual([]);
    fixture.answers.set("POST /api/linked-servers/a2a0123456789abc/token", { server: agent(), token: "fresh-token", urls: [{ bot: "ops", url: "https://seira.example.test/a2a/ops" }] });
    await click(button("Make new token"));
    expect(writes()).toEqual([{ path: "/api/linked-servers/a2a0123456789abc/token", method: "POST", body: {} }]);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(host.querySelector("[data-linked-a2a-token]")!.textContent).toBe("fresh-token");
    await click(button("Done"));
    expect(text()).not.toContain("fresh-token");
  });

  it("closes the new-token dialog on Cancel without a request", async () => {
    await open([agent()]);
    await click(button("New token…"));
    await click(document.body.querySelector("[role=dialog] button[data-autofocus]")!);
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
    expect(writes()).toEqual([]);
  });

  it("shows the server's sentence in the dialog when the new token is refused", async () => {
    fixture.refuse.set("POST /api/linked-servers/a2a0123456789abc/token", "That link is not here.");
    await open([agent()]);
    await click(button("New token…"));
    await click(button("Make new token"));
    expect(document.body.querySelector("[role=dialog] [role=alert]")!.textContent).toBe("That link is not here.");
    expect(host.querySelector("[data-linked-a2a-issued]")).toBeNull();
  });
});
