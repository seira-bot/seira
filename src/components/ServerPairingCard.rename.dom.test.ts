// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const server = vi.hoisted(() => ({
  list: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ path: string; method: string; body?: string }>,
  reject: false as false | number,
}));
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/config") return { computerName: "Studio" };
    if (path === "/api/auth/sessions" && !init?.method) return { sessions: server.list, current: "b" };
    server.calls.push({ path, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
    if (server.reject) throw Object.assign(new Error("refused"), { status: server.reject });
    const label = JSON.parse(init?.body ?? "{}").label as string;
    server.list = server.list.map((device) => (path.endsWith(`/${device.id}`) ? { ...device, label } : device));
    return { ok: true };
  },
}));
vi.mock("../lib/session", async (original) => ({
  ...await original<typeof import("../lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" }),
}));
const { ServerPairingCard } = await import("./ServerPairingCard");

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  setLocale("en");
  server.calls = [];
  server.reject = false;
  server.list = [
    { id: "a", label: "Ada's phone", scopes: ["client"], lastSeenAt: 0, expiresAt: 1 },
    { id: "b", label: "Chrome on Linux", scopes: ["admin", "client"], lastSeenAt: 0, expiresAt: 1 },
  ];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root.render(createElement(ServerPairingCard)));
  await vi.waitFor(() => expect(host.querySelectorAll("[data-paired-device]")).toHaveLength(2));
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

const row = (id: string) => host.querySelector<HTMLElement>(`[data-paired-device="${id}"]`)!;
const input = (id: string) => row(id).querySelector<HTMLInputElement>("input")!;
const renameCalls = () => server.calls.filter((call) => call.method === "PATCH");

async function open(id: string) {
  flushSync(() => row(id).querySelector<HTMLButtonElement>("[data-device-rename]")!.click());
  await vi.waitFor(() => expect(input(id)).not.toBeNull());
}

function type(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { set.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("offers Rename on every row, also this browser's", () => {
  expect(row("a").querySelector("[data-device-rename]")).not.toBeNull();
  expect(row("b").querySelector("[data-device-rename]")).not.toBeNull();
  expect(row("b").textContent).not.toContain("Remove");
});

it("saves the typed name on Enter and shows it in the row", async () => {
  await open("a");
  type(input("a"), "Ada kitchen phone");
  flushSync(() => row("a").querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(row("a").textContent).toContain("Ada kitchen phone"));
  expect(renameCalls()).toEqual([{ path: "/api/auth/sessions/a", method: "PATCH", body: JSON.stringify({ label: "Ada kitchen phone" }) }]);
  expect(row("a").querySelector("form")).toBeNull();
});

it("saves the typed name with the Save button", async () => {
  await open("b");
  type(input("b"), "Desk laptop");
  flushSync(() => row("b").querySelector<HTMLButtonElement>("[data-server-rename-save]")!.click());
  await vi.waitFor(() => expect(row("b").textContent).toContain("Desk laptop"));
  expect(renameCalls()).toHaveLength(1);
});

it("sends nothing when the name did not change", async () => {
  await open("a");
  flushSync(() => row("a").querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(row("a").querySelector("form")).toBeNull());
  expect(renameCalls()).toHaveLength(0);
});

it("limits the name to 80 characters", async () => {
  await open("a");
  expect(input("a").maxLength).toBe(80);
});

it("leaves on Escape and on Cancel without a request", async () => {
  await open("a");
  type(input("a"), "Something else");
  flushSync(() => input("a").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(row("a").querySelector("form")).toBeNull();
  await open("a");
  const cancel = [...row("a").querySelectorAll("button")].find((button) => button.textContent === "Cancel")!;
  flushSync(() => cancel.click());
  expect(row("a").querySelector("form")).toBeNull();
  expect(renameCalls()).toHaveLength(0);
  expect(row("a").textContent).toContain("Ada's phone");
});

it("keeps the form open and shows an error line when the request fails", async () => {
  server.reject = 500;
  await open("a");
  type(input("a"), "Ada kitchen phone");
  flushSync(() => row("a").querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(row("a").querySelector('[role="alert"]')).not.toBeNull());
  expect(row("a").querySelector("form")).not.toBeNull();
  expect(input("a").value).toBe("Ada kitchen phone");
  expect(row("a").textContent).toContain("Ada's phone");
});

it("shows the name error when the server refuses the name with 400", async () => {
  server.reject = 400;
  await open("a");
  type(input("a"), "Ada kitchen phone");
  flushSync(() => row("a").querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(row("a").querySelector('[role="alert"]')).not.toBeNull());
  expect(row("a").querySelector('[role="alert"]')!.textContent).toBe("Use a name of 1 to 80 characters.");
  expect(row("a").querySelector("form")).not.toBeNull();
  expect(input("a").value).toBe("Ada kitchen phone");
});

it("shows the generic error for a failure that is not a refused name", async () => {
  server.reject = 500;
  await open("a");
  type(input("a"), "Ada kitchen phone");
  flushSync(() => row("a").querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(row("a").querySelector('[role="alert"]')).not.toBeNull());
  expect(row("a").querySelector('[role="alert"]')!.textContent).not.toBe("Use a name of 1 to 80 characters.");
});

it("closes the form and reloads the list when another admin removed the device (404)", async () => {
  await open("a");
  type(input("a"), "Ada kitchen phone");
  server.list = server.list.filter((device) => device.id !== "a");
  server.reject = 404;
  flushSync(() => row("a")!.querySelector("form")!.requestSubmit());
  await vi.waitFor(() => expect(host.querySelector('[data-paired-device="a"]')).toBeNull());
  expect(host.querySelectorAll("[data-paired-device]")).toHaveLength(1);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
