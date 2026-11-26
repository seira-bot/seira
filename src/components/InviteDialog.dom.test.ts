// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessGrant } from "../../shared/department-access";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Call = { path: string; init?: { method?: string; body?: string } };
const fixture = vi.hoisted(() => ({
  calls: [] as Call[],
  people: {} as Record<string, unknown>,
  members: [] as string[],
  grantError: null as string | null,
  bots: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: fixture.bots, config: null }, dispatch: () => {} }),
  api: async (path: string, init?: { method?: string; body?: string }) => {
    fixture.calls.push({ path, init });
    if (path === "/api/config" && init?.method === "PUT") {
      fixture.members = (JSON.parse(init.body!) as { signIn: { members: string[] } }).signIn.members;
      return {};
    }
    if (path === "/api/config") return { signIn: { admins: ["boss@acme.test"], members: fixture.members } };
    if (path === "/api/department-access" && init?.method === "PUT") {
      if (fixture.grantError) throw new Error(fixture.grantError);
      const { entry, access } = JSON.parse(init.body!) as { entry: string; access: unknown };
      if (access) fixture.people[entry] = access; else delete fixture.people[entry];
      return {};
    }
    if (path === "/api/department-access") return { available: true, people: fixture.people, unreadable: false };
    if (path === "/api/sidebar-sections") return { sections: ["Sales", "Finance"] };
    if (path === "/api/department-folders") return { departments: { Finance: { limited: true, folders: [] } } };
    if (path === "/api/settings/custom-domain") return { publicUrl: "https://team.acme.test" };
    return null;
  },
}));
const { InviteDialog } = await import("./InviteDialog");

let host: HTMLDivElement;
let root: Root;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const click = async (node: Element | null | undefined) => { await act(async () => { (node as HTMLElement).click(); }); await settle(); };
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
const dialog = () => document.body.querySelector<HTMLElement>("[data-invite-dialog]")!;
const kindLabel = (node: Element) => node.querySelector("[data-invite-kind]")?.textContent?.trim();
const radio = (label: string) => [...dialog().querySelectorAll("label")].find((node) => kindLabel(node) === label)?.querySelector("input") as HTMLInputElement;
const note = (text: string) => [...dialog().querySelectorAll("[role=note]")].filter((node) => node.textContent?.includes(text));
const item = (key: string) => dialog().querySelector<HTMLElement>(`[data-invite-item="${key}"]`)!;
const tick = (key: string) => click(item(key).querySelector("input"));
const level = (key: string) => item(key).querySelector<HTMLSelectElement>("select");
const button = (label: string) => [...dialog().querySelectorAll("button")].find((node) => node.textContent?.trim() === label)!;
const summary = () => dialog().querySelector("[data-invite-summary]")!.textContent;
const writes = () => fixture.calls.filter((call) => call.init?.method === "PUT").map((call) => call.path);
const body = (path: string) => JSON.parse(fixture.calls.find((call) => call.path === path && call.init?.method === "PUT")!.init!.body!);
const emailField = () => dialog().querySelector<HTMLInputElement>("input[dir=auto]")!;

const onClose = vi.fn();
const onDone = vi.fn();
async function show(props: Partial<Parameters<typeof InviteDialog>[0]> = {}) {
  await act(async () => { root.render(createElement(InviteDialog, { open: true, onClose, onDone, ...props })); });
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => ({ ok: false, json: async () => null }));
  fixture.calls = [];
  fixture.people = {};
  fixture.members = [];
  fixture.grantError = null;
  fixture.bots = [
    { id: "ani", name: "Ani", section: "Sales", onlyPeopleAdded: true },
    { id: "sup", name: "Support", section: "Finance" },
    { id: "gone", name: "Gone", hidden: true },
  ];
  onClose.mockClear();
  onDone.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  vi.unstubAllGlobals();
  act(() => root.unmount());
  host.remove();
});

describe("the invite dialog", () => {
  it("AC-17 offers the whole team, chosen departments and chosen bots, with the whole team picked", async () => {
    await show();
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone");
    expect(dialog().querySelector("legend")!.textContent).toBe("Access");
    expect([...dialog().querySelectorAll<HTMLInputElement>('fieldset input[type="radio"]')].map((node) => kindLabel(node.closest("label")!))).toEqual(["Whole team", "Chosen departments", "Chosen bots"]);
    expect(radio("Whole team").checked).toBe(true);
    expect(summary()).toBe("They can use every bot shared with the team.");
    expect(document.activeElement).toBe(emailField());
  });

  it("AC-18 shows a level for each ticked department, Can chat first", async () => {
    await show();
    await click(radio("Chosen departments"));
    expect([...dialog().querySelectorAll("[data-invite-item]")].map((node) => node.getAttribute("data-invite-item"))).toEqual(["general", "Sales", "Finance"]);
    expect(level("Sales")).toBeNull();
    await tick("Sales");
    const select = level("Sales")!;
    expect(select.getAttribute("aria-label")).toBe("Access level for Sales");
    expect(select.value).toBe("chat");
    expect([...select.options].map((option) => option.textContent)).toEqual(["Can chat", "Can view"]);
    expect(level("Finance")).toBeNull();
  });

  it("AC-18 shows a level for each ticked bot, and leaves out a hidden bot", async () => {
    await show();
    await click(radio("Chosen bots"));
    expect(item("gone")).toBeNull();
    expect(item("ani").textContent).toContain("Sales");
    await tick("ani");
    expect(level("ani")!.value).toBe("chat");
    expect(level("sup")).toBeNull();
    expect(dialog().querySelector("input[aria-label='Find a bot']")).toBeNull();
  });

  it("says in each access option what happens to bots added later", async () => {
    await show();
    const hint = (label: string) => radio(label).closest("label")!.querySelector("span.block + span.block")?.textContent;
    expect(hint("Whole team")).toBeUndefined();
    expect(hint("Chosen departments")).toBe("Bots added to these departments later are included.");
    expect(hint("Chosen bots")).toBe("Bots added later are not included.");
  });

  it("lists the visible bots under each department, and puts the bots in the order of the departments", async () => {
    fixture.bots = [
      { id: "sup", name: "Support", section: "Finance" },
      { id: "ani", name: "Ani", section: "Sales" },
      { id: "zed", name: "Zed" },
      { id: "bo", name: "Bo", section: "Sales" },
      { id: "gone", name: "Gone", section: "Sales", hidden: true },
    ];
    await show();
    await click(radio("Chosen departments"));
    expect(item("Sales").textContent).toBe("SalesAni, Bo");
    expect(item("Finance").textContent).toBe("FinanceSupport");
    expect(item("general").textContent).toBe("GeneralZed");
    await click(radio("Chosen bots"));
    expect([...dialog().querySelectorAll("[data-invite-item]")].map((node) => node.getAttribute("data-invite-item"))).toEqual(["zed", "ani", "bo", "sup"]);
  });

  it("shows no list under a department without bots", async () => {
    await show();
    await click(radio("Chosen departments"));
    expect(item("general").textContent).toBe("General");
  });

  it("AC-18 offers a filter once there are more than eight bots", async () => {
    fixture.bots = Array.from({ length: 9 }, (_, index) => ({ id: `b${index}`, name: index === 4 ? "Zed" : `Bot ${index}` }));
    await show();
    await click(radio("Chosen bots"));
    await type(dialog().querySelector<HTMLInputElement>("input[aria-label='Find a bot']")!, "zed");
    expect(dialog().querySelectorAll("[data-invite-item]")).toHaveLength(1);
  });

  it("AC-19 turns the access off for an admin and says why", async () => {
    await show();
    await click(radio("Chosen departments"));
    await click(button("Admin"));
    expect(button("Admin").getAttribute("aria-pressed")).toBe("true");
    expect(dialog().querySelector("fieldset")!.disabled).toBe(true);
    expect(summary()).toBe("Admins see the whole team.");
    await click(button("User"));
    expect(dialog().querySelector("fieldset")!.disabled).toBe(false);
    expect(radio("Chosen departments").checked).toBe(true);
  });

  it("says what the person will see, and asks for a pick when nothing is ticked", async () => {
    await show();
    await click(radio("Chosen departments"));
    expect(summary()).toBe("Pick at least one department.");
    await tick("Sales");
    await tick("Finance");
    await choose(level("Finance")!, "view");
    expect(summary()).toBe("They can chat with the bots in Sales. They can see the bots in Finance but cannot send messages.");
    await click(radio("Chosen bots"));
    expect(summary()).toBe("Pick at least one bot.");
    await tick("ani");
    expect(summary()).toBe("They can chat with Ani.");
    await tick("sup");
    await choose(level("sup")!, "view");
    expect(summary()).toBe("They can chat with Ani. They can see Support but cannot send messages.");
  });

  it("warns once about folders and about General, and says a bot shared with some people adds this person to them", async () => {
    await show();
    await click(radio("Chosen departments"));
    await tick("Sales");
    await tick("Finance");
    expect(note("can open files")).toHaveLength(1);
    expect(note("can open files")[0]!.textContent).toBe("Bots in Sales can open files outside their own folders, so this person may see that content in answers.");
    await tick("general");
    expect(note("can open files")).toHaveLength(1);
    expect(note("can open files")[0]!.textContent).toContain("Bots in General and Sales can open files");
    expect(dialog().textContent).not.toContain("Finance can open");
    expect(dialog().textContent).toContain("Bots in General, Chief of Staff too");
    await click(radio("Chosen bots"));
    await tick("sup");
    expect(note("can open files")).toHaveLength(0);
    expect(dialog().textContent).not.toContain("Inviting adds this person");
    await tick("ani");
    expect(dialog().textContent).toContain("Inviting adds this person to the people who can use Ani.");
    expect(note("can open files")).toHaveLength(1);
    expect(note("can open files")[0]!.textContent).toContain("Bots in Sales can open files");
  });

  it("shows the note for a self-hosted bot shared with some people, and confirms it in the request", async () => {
    fixture.bots = [{ id: "ani", name: "Ani", section: "Sales", visibility: { people: ["ana@acme.test"] } }, { id: "sup", name: "Support", section: "Finance", visibility: "everyone" }];
    await show();
    await type(emailField(), "Ada@Acme.test");
    await click(radio("Chosen bots"));
    await tick("sup");
    expect(dialog().textContent).not.toContain("Inviting adds this person");
    await tick("ani");
    expect(note("Inviting adds this person to the people who can use Ani.")).toHaveLength(1);
    await click(button("Invite"));
    expect(body("/api/department-access")).toEqual({ entry: "ada@acme.test", access: { departments: [], bots: [{ id: "ani", level: "chat" }, { id: "sup", level: "chat" }] }, admitBots: true });
  });

  it("asks for each address when a domain meets a bot shared with some people, and sends nothing", async () => {
    fixture.bots = [{ id: "ani", name: "Ani", section: "Sales", visibility: { people: ["ana@acme.test"] } }];
    await show();
    await type(emailField(), "@acme.test");
    await click(radio("Chosen bots"));
    await tick("ani");
    expect(note("To give access to Ani, invite each person by their own address.")).toHaveLength(1);
    expect(dialog().textContent).not.toContain("Inviting adds this person");
    await click(button("Invite"));
    expect(writes()).toEqual([]);
    expect(dialog().querySelector("[role=alert]")!.textContent).toBe("To give access to Ani, invite each person by their own address.");
  });

  it("AC-01 saves the access before it adds the person to the sign-in list, then shows the link", async () => {
    await show();
    await type(emailField(), "Ada@Acme.test");
    await click(radio("Chosen bots"));
    await tick("ani");
    await choose(level("ani")!, "view");
    await click(button("Invite"));
    expect(writes()).toEqual(["/api/department-access", "/api/config"]);
    expect(body("/api/department-access")).toEqual({ entry: "ada@acme.test", access: { departments: [], bots: [{ id: "ani", level: "view" }] }, admitBots: true });
    expect(body("/api/config")).toEqual({ signIn: { admins: ["boss@acme.test"], members: ["ada@acme.test"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite ready");
    expect(dialog().querySelector("code")!.textContent).toBe("https://team.acme.test/pair?email=ada%40acme.test");
    expect(dialog().textContent).toContain("Send this link to them yourself, by chat or email. They sign in with a code sent to their address.");
    expect(dialog().textContent).not.toContain("only the owner of that address");
    expect(summary()).toBe("They can see Ani but cannot send messages.");
    expect(onDone).not.toHaveBeenCalled();
    await click(button("Done"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("AC-01 sends chosen departments with their levels, in the order of the list", async () => {
    await show();
    await type(emailField(), "ada@acme.test");
    await click(radio("Chosen departments"));
    await tick("Finance");
    await tick("general");
    await choose(level("Finance")!, "view");
    await click(button("Invite"));
    expect(body("/api/department-access").access).toEqual({ departments: [{ name: "", level: "chat" }, { name: "Finance", level: "view" }], bots: [] });
  });

  it("adds an admin or a whole-team user without any access change", async () => {
    await show();
    await type(emailField(), "boss2@acme.test");
    await click(button("Admin"));
    await click(button("Invite"));
    expect(writes()).toEqual(["/api/config"]);
    expect(body("/api/config")).toEqual({ signIn: { admins: ["boss@acme.test", "boss2@acme.test"], members: [] } });
  });

  it("AC-01 removes an older access of a person who is now invited to the whole team, before the sign-in list", async () => {
    fixture.people = { "ada@acme.test": { departments: [{ name: "Sales", level: "chat" }], bots: [] } };
    await show();
    await type(emailField(), "ada@acme.test");
    await click(button("Invite"));
    expect(writes()).toEqual(["/api/department-access", "/api/config"]);
    expect(body("/api/department-access")).toEqual({ entry: "ada@acme.test", access: null });
  });

  it("starts with nothing saved when the address or the pick is missing, and says what to fix", async () => {
    await show();
    await click(button("Invite"));
    expect(dialog().querySelector("[role=alert]")!.textContent).toBe("Enter an email address, or @domain for everyone at that domain.");
    await type(emailField(), "ada@acme.test");
    await click(radio("Chosen bots"));
    await click(button("Invite"));
    expect(dialog().querySelector("[role=alert]")!.textContent).toBe("Pick at least one bot.");
    expect(writes()).toEqual([]);
  });

  it("does not add the person when the access cannot be saved, and shows the server's sentence", async () => {
    fixture.grantError = "That bot does not exist.";
    await show();
    await type(emailField(), "ada@acme.test");
    await click(radio("Chosen bots"));
    await tick("ani");
    await click(button("Invite"));
    expect(dialog().querySelector("[role=alert]")!.textContent).toBe("That bot does not exist.");
    expect(writes()).toEqual(["/api/department-access"]);
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone");
  });

  it("AC-20 opens with the department of the menu ticked", async () => {
    await show({ preset: { departments: ["Sales"] } });
    expect(radio("Chosen departments").checked).toBe(true);
    expect(item("Sales").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect(item("Finance").querySelector<HTMLInputElement>("input")!.checked).toBe(false);
    expect(summary()).toBe("They can chat with the bots in Sales.");
  });

  it("AC-21 opens with the bot of the menu ticked", async () => {
    await show({ preset: { bots: ["sup"] } });
    expect(radio("Chosen bots").checked).toBe(true);
    expect(item("sup").querySelector<HTMLInputElement>("input")!.checked).toBe(true);
    expect(summary()).toBe("They can chat with Support.");
  });

  it("puts the name of a single department or bot in the title", async () => {
    await show({ preset: { departments: ["Sales"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone to Sales");
    await show({ preset: { departments: [""] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone to General");
    await show({ preset: { bots: ["sup"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone to Support");
    await show({ preset: { departments: ["Sales", "Finance"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone");
    await show({ preset: { bots: ["ani", "sup"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite someone");
    await show({ edit: { entry: "ada@acme.test", grant: { departments: [], bots: [{ id: "ani", level: "view" }] } }, preset: { bots: ["ani"] } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Change access");
  });

  it("keeps the plain title after the invite is ready", async () => {
    await show({ preset: { departments: ["Sales"] } });
    await type(emailField(), "ada@acme.test");
    await click(button("Invite"));
    expect(dialog().querySelector("h2")!.textContent).toBe("Invite ready");
  });

  describe("scrolling to the preset", () => {
    const scroll = vi.fn();
    beforeEach(() => {
      scroll.mockClear();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    });
    afterEach(() => { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView; });

    it("brings the first ticked row into view once", async () => {
      await show({ preset: { departments: ["Finance", "Sales"] } });
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.contexts[0]).toBe(item("Sales"));
      expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
      await tick("Finance");
      expect(scroll).toHaveBeenCalledTimes(1);
    });

    it("does nothing without a preset", async () => {
      await show();
      await click(radio("Chosen departments"));
      expect(scroll).not.toHaveBeenCalled();
    });
  });

  it("Escape closes it", async () => {
    await show();
    await act(async () => { dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("changing a person's access", () => {
  const grant: AccessGrant = { departments: [], bots: [{ id: "ani", level: "view" }] };

  it("opens on the chosen kind with its levels, and saves only the access", async () => {
    await show({ edit: { entry: "ada@acme.test", grant } });
    expect(dialog().querySelector("h2")!.textContent).toBe("Change access");
    expect(dialog().textContent).toContain("ada@acme.test");
    expect(dialog().querySelector("[data-invite-role]")).toBeNull();
    expect(radio("Chosen bots").checked).toBe(true);
    expect(level("ani")!.value).toBe("view");
    await choose(level("ani")!, "chat");
    await click(button("Save"));
    expect(writes()).toEqual(["/api/department-access"]);
    expect(body("/api/department-access")).toEqual({ entry: "ada@acme.test", access: { departments: [], bots: [{ id: "ani", level: "chat" }] }, admitBots: true });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives the whole team back", async () => {
    await show({ edit: { entry: "ada@acme.test", grant } });
    await click(radio("Whole team"));
    await click(button("Save"));
    expect(body("/api/department-access")).toEqual({ entry: "ada@acme.test", access: null });
  });

  it("opens on departments for a person who has both, and says what saving keeps", async () => {
    await show({ edit: { entry: "@acme.test", grant: { departments: [{ name: "Sales", level: "chat" }], bots: [{ id: "ani", level: "view" }] } } });
    expect(dialog().textContent).toContain("everyone at acme.test");
    expect(radio("Chosen departments").checked).toBe(true);
    expect(dialog().textContent).toContain("This person has both departments and bots.");
  });
});
