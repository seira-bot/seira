// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { ServerInstallEvent } from "@/types/ogb";
import { ServerInstallSheet } from "./ServerInstallSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
let emit: (event: ServerInstallEvent) => void = () => {};
const start = vi.fn(async (_request: unknown) => true);
const sendCode = vi.fn(async (_code: string) => true);
const accept = vi.fn(async () => true);
const install = vi.fn(async (_options: unknown) => true);
const cancel = vi.fn(async () => true);
const connected = vi.fn();

const set = (selector: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(selector)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const screenName = () => document.querySelector("[data-server-install]")?.getAttribute("data-server-install");

beforeEach(async () => {
  setLocale("en");
  vi.clearAllMocks();
  Object.assign(window, { ogb: { serverInstall: { info: async () => ({ agent: false }), pickKey: async () => ({ name: "id_ed25519" }), start, acceptHostKey: accept,
    rejectHostKey: vi.fn(async () => true), check: vi.fn(async () => true), install, sendCode, cancel,
    onEvent: (callback: (event: ServerInstallEvent) => void) => { emit = callback; return () => {}; } } } });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(ServerInstallSheet, { onBack: null, onConnected: connected })); });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const fill = async () => {
  await act(async () => { set("[data-install-address]", "203.0.113.9"); set("[data-install-password]", "hunter2"); set("[data-install-email]", "me@example.com"); });
  await act(async () => { document.querySelector<HTMLFormElement>("[data-server-install=form]")!.requestSubmit(); });
};

it("the form sends the sign-in once and clears its secret at once", async () => {
  expect(document.querySelector<HTMLInputElement>("[data-install-user]")!.value).toBe("root");
  await fill();
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0]![0]).toMatchObject({ address: "203.0.113.9", user: "root", method: "password", password: "hunter2", email: "me@example.com" });
  expect(document.body.innerHTML).not.toContain("hunter2");
  await act(async () => { cancel.mockClear(); document.querySelector<HTMLButtonElement>("[data-install-cancel]")!.click(); });
  expect(document.querySelector<HTMLInputElement>("[data-install-password]")!.value).toBe("");
});

it("an unknown server shows its fingerprint and waits for the person", async () => {
  await fill();
  await act(async () => { emit({ type: "hostKey", host: "203.0.113.9", port: 22, fingerprint: "SHA256:abc" }); });
  expect(screenName()).toBe("host-key");
  expect(document.querySelector("[data-install-fingerprint]")!.textContent).toBe("SHA256:abc");
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-install-accept]")!.click(); });
  expect(accept).toHaveBeenCalledTimes(1);
});

it("a check that needs a fix blocks Install until the person allows Docker, and Check again stays", async () => {
  await fill();
  await act(async () => { emit({ type: "checks", result: "fix", items: [{ id: "docker", level: "fix", sentence: "Docker is not installed." }, { id: "disk", level: "ok", sentence: "There is enough space." }] }); });
  const run = document.querySelector<HTMLButtonElement>("[data-install-run]")!;
  expect(run.disabled).toBe(true);
  await act(async () => { document.querySelector<HTMLInputElement>("[data-install-docker]")!.click(); });
  expect(run.disabled).toBe(false);
  await act(async () => { run.click(); });
  expect(install).toHaveBeenCalledWith({ installDocker: true });
  expect(document.querySelector("[data-install-recheck]")).not.toBeNull();
});

it("the emailed code is asked inline, sent once as eight digits and cleared", async () => {
  await fill();
  await act(async () => { emit({ type: "step", id: "download", state: "start", sentence: "Downloading" }); emit({ type: "askCode", email: "me@example.com" }); });
  expect(screenName()).toBe("install");
  await act(async () => { set("[data-install-code]", "1234 5678"); });
  await act(async () => { document.querySelector<HTMLFormElement>("[data-install-code-form]")!.requestSubmit(); });
  expect(sendCode).toHaveBeenCalledWith("12345678");
  expect(document.querySelector<HTMLInputElement>("[data-install-code]")!.value).toBe("");
});

it("a failure says what happened in plain words and Try again returns to an empty secret", async () => {
  await fill();
  await act(async () => { emit({ type: "failed", reason: "auth", step: null, sentence: null }); });
  expect(document.querySelector("[data-install-problem]")!.textContent).toBe("The server did not accept that sign-in.");
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-install-retry]")!.click(); });
  expect(document.querySelector<HTMLInputElement>("[data-install-password]")!.value).toBe("");
  expect(document.querySelector<HTMLInputElement>("[data-install-address]")!.value).toBe("203.0.113.9");
});

it("connected closes the sheet", async () => {
  await fill();
  await act(async () => { emit({ type: "connected" }); });
  expect(connected).toHaveBeenCalledTimes(1);
});

it("a repeat ask clears the code field and says the code did not work", async () => {
  await fill();
  await act(async () => { emit({ type: "askCode", email: "me@example.com" }); });
  expect(document.querySelector("[data-install-code-again]")).toBeNull();
  await act(async () => { set("[data-install-code]", "00000000"); });
  await act(async () => { emit({ type: "askCode", email: "me@example.com", again: true }); });
  expect(document.querySelector<HTMLInputElement>("[data-install-code]")!.value).toBe("");
  expect(document.querySelector("[data-install-code-again]")!.textContent).toBe("That code did not work. Check the newest email and try again.");
});

it("a changed identity from the app's own list offers a guarded recovery; one from the computer's list offers none", async () => {
  const forget = vi.fn(async () => true);
  (window as { ogb: { serverInstall: { forgetHost?: unknown } } }).ogb.serverInstall.forgetHost = forget;
  await fill();
  await act(async () => { emit({ type: "failed", reason: "hostKeyChanged", step: null, sentence: null, source: "saved" }); });
  expect(document.querySelector("[data-install-rebuilt-warning]")!.textContent).toBe("Only do this if you reinstalled or rebuilt this server. Otherwise someone may be between you and it.");
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-install-rebuilt]")!.click(); });
  expect(forget).toHaveBeenCalledTimes(1);
  await act(async () => { emit({ type: "failed", reason: "hostKeyChanged", step: null, sentence: null, source: "system" }); });
  expect(document.querySelector("[data-install-rebuilt]")).toBeNull();
  expect(document.querySelector("[data-install-system-list]")!.textContent).toBe("This computer's own list of known servers still has the old identity. Remove it there, then try again.");
});
