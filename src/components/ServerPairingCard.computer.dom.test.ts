// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const asked = vi.hoisted(() => [] as unknown[]);
vi.mock("@/state/store", () => ({
  api: async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/auth/pairing" && init?.method === "POST") asked.push(JSON.parse(init.body ?? "{}"));
    return path === "/api/auth/pairing"
      ? { code: "ABCD-EFGH-IJKL", expiresAt: Date.now() + 600_000, url: "http://macmini.tail1234.ts.net:8799/pair#code=ABCD-EFGH-IJKL" }
      : path === "/api/config" ? {} : { sessions: [], current: null };
  },
}));
vi.mock("../lib/session", async (original) => ({
  ...await original<typeof import("../lib/session")>(),
  readSessionState: async () => ({ kind: "loopback" }),
}));
const { ServerPairingCard, computerLink } = await import("./ServerPairingCard");

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  asked.length = 0;
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

async function openDialog(forComputer: boolean, choice = forComputer ? "Pair a computer" : "Pair a phone") {
  flushSync(() => root.render(createElement(ServerPairingCard, { simple: true, reveal: false, forComputer, address: forComputer ? "http://macmini.tail1234.ts.net:8799" : null })));
  const button = await vi.waitFor(() => {
    const found = [...host.querySelectorAll("button")].find((b) => b.textContent === choice);
    expect(found).toBeDefined();
    return found!;
  });
  const label = button.textContent;
  const rowText = host.textContent ?? "";
  button.click();
  const dialog = await vi.waitFor(() => {
    const found = document.querySelector("[data-pair-dialog='code']");
    expect(found).not.toBeNull();
    return found!;
  });
  return {
    label, rowText, dialog, title: dialog.getAttribute("aria-label"), text: dialog.querySelector("[data-pair-instructions]")?.textContent ?? "",
    qr: dialog.querySelector("[data-pair-qr]") !== null, all: dialog.textContent ?? "",
    buttons: [...dialog.querySelectorAll("button")].filter((b) => b.textContent).map((b) => ({ text: b.textContent, primary: b.classList.contains("ui-button-primary") })),
  };
}

it("shows another computer the address with the code, and makes Copy link the main button", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const computer = await openDialog(true);
  expect(computer.label).toBe("Pair a computer");
  expect(computer.rowText).toContain("Pair another computer");
  expect(computer.rowText).not.toMatch(/phone/i);
  expect(computer.title).toBe("Pair another computer");
  expect(computer.text).toBe("On your other computer, open Connect to a server in Seira and paste the link you copy here. Or type this address and code there.");
  expect(computer.dialog.querySelector("[data-pairing-address]")?.textContent).toBe("http://macmini.tail1234.ts.net:8799");
  expect(computer.dialog.querySelector("[data-pairing-code]")?.textContent).toBe("ABCD-EFGH-IJKL");
  expect(computer.qr).toBe(false);
  expect(computer.all).not.toMatch(/phone|scan/i);
  expect(computer.buttons).toEqual([{ text: "Done", primary: false }, { text: "Copy link", primary: true }]);
  computer.dialog.querySelector<HTMLButtonElement>("[data-copy-link]")!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("http://macmini.tail1234.ts.net:8799/pair#code=ABCD-EFGH-IJKL"));
});

it("asks for a computer's code only from the computer dialog, so every other code keeps the phone limits", async () => {
  await openDialog(true);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ device: "computer" });
  flushSync(() => root.unmount());
  root = createRoot(host);
  asked.length = 0;
  await openDialog(false);
  expect(asked).toHaveLength(1);
  expect(asked[0]).not.toHaveProperty("device");
});

it("lets the phone page pair a computer too, with the computer's code, address and wording", async () => {
  const fromPhonePage = await openDialog(false, "Pair a computer");
  expect(asked).toEqual([expect.objectContaining({ device: "computer" })]);
  expect(fromPhonePage.title).toBe("Pair another computer");
  expect(fromPhonePage.dialog.querySelector("[data-pairing-address]")?.textContent).toBe("http://macmini.tail1234.ts.net:8799");
  expect(fromPhonePage.qr).toBe(false);
  expect(fromPhonePage.all).not.toMatch(/phone|scan/i);
  expect(fromPhonePage.buttons).toEqual([{ text: "Done", primary: false }, { text: "Copy link", primary: true }]);
  flushSync(() => root.unmount());
  root = createRoot(host);
  asked.length = 0;
  const phone = await openDialog(false);
  expect(asked[0]).not.toHaveProperty("device");
  expect(phone.qr).toBe(true);
});

it("makes the link from the shared address when the server gave none", () => {
  expect(computerLink({ url: null, code: "ABCD-EFGH-IJKL" }, "https://macmini.tail1234.ts.net")).toEqual({ link: "https://macmini.tail1234.ts.net/pair#code=ABCD-EFGH-IJKL", address: "https://macmini.tail1234.ts.net" });
  expect(computerLink({ url: null, code: "ABCD-EFGH-IJKL" }, null)).toBeNull();
});

it("keeps the phone wording for phones", async () => {
  const phone = await openDialog(false);
  expect(phone.label).toBe("Pair a phone");
  expect(phone.text).toContain("on your phone");
  expect(phone.qr).toBe(true);
  expect(phone.dialog.querySelector("[data-pairing-address]")).toBeNull();
  expect(phone.buttons).toEqual([{ text: "Copy link", primary: false }, { text: "Done", primary: true }]);
});
