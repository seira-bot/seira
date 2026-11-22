// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import { activeCall, atlas, turnsConfig } from "./call-test-support";

const fixture = vi.hoisted(() => ({ config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config as AppState["config"], bots: [] }, dispatch: vi.fn() }) };
});
const calls = vi.hoisted(() => ({ endCall: vi.fn() }));
vi.mock("@/lib/call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/call")>()), endCall: calls.endCall }));

const { CallFullView } = await import("./CallFullView");
const { beginCallSession, callSession, resetCallSession } = await import("@/lib/call-session");

let root: Root;
let host: HTMLDivElement;
const render = (call = activeCall()) => flushSync(() => root.render(createElement(CallFullView, { bot: atlas, call })));
const control = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === label) ?? null;
const press = (element: Element | null) => flushSync(() => (element as HTMLElement).click());
const escape = () => flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

beforeEach(() => {
  fixture.config = turnsConfig("openai");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  calls.endCall.mockClear();
  beginCallSession("atlas");
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  resetCallSession();
});

describe("CallFullView", () => {
  it("shows the name and the calling state with the pulse rings", () => {
    render(activeCall({ stage: "calling", startedAt: null }));
    expect(host.textContent).toContain("Atlas");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Calling…");
    expect(host.querySelectorAll(".call-ring")).toHaveLength(3);
  });

  it("shows the call time and state once connected, and stops the rings", () => {
    render(activeCall({ startedAt: Date.now() - 5_000 }));
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/^0:0\d · /);
    expect(host.querySelectorAll(".call-ring")).toHaveLength(0);
  });

  it("puts a halo on the face while the bot speaks", () => {
    render(activeCall({ presence: "speaking" }));
    expect(host.querySelector(".call-halo")).not.toBeNull();
    render(activeCall({ presence: "listening" }));
    expect(host.querySelector(".call-halo")).toBeNull();
  });

  it("offers Mute, Captions, Call voice, Minimize and Hang up as labelled 44px round buttons", () => {
    render();
    for (const label of ["Mute", "Captions", "Call voice", "Minimize", "Hang up"]) {
      const item = control(label);
      expect(item, label).not.toBeNull();
      const disc = item!.querySelector("span");
      expect(disc?.className).toContain("size-11");
      expect(disc?.className).toContain("rounded-full");
    }
  });

  it("minimizes the call", () => {
    render();
    press(control("Minimize"));
    expect(callSession().minimized).toBe(true);
  });

  it("hangs up on Escape", () => {
    render();
    escape();
    expect(calls.endCall).toHaveBeenCalledWith("atlas");
  });

  it("closes an open popover on Escape and keeps the call", () => {
    render();
    const captions = control("Captions")!;
    press(captions);
    expect(host.querySelector('[role="dialog"][aria-label="Captions"]')).not.toBeNull();
    escape();
    expect(host.querySelector('[role="dialog"][aria-label="Captions"]')).toBeNull();
    expect(document.activeElement).toBe(captions);
    expect(calls.endCall).not.toHaveBeenCalled();
    escape();
    expect(calls.endCall).toHaveBeenCalledOnce();
  });

  it("shows the microphone note with a retry button on a Turns call", () => {
    render(activeCall({ note: "No microphone found." }));
    expect(host.textContent).toContain("No microphone found.");
    expect(control("Try microphone again")).not.toBeNull();
  });

  it("names the chords on a Live call and disables hang up while it ends", () => {
    render(activeCall({ mode: "live", presence: "ending" }));
    expect(control("Mute")?.getAttribute("aria-keyshortcuts")).toMatch(/Shift\+M$/);
    expect(control("Hang up")?.getAttribute("aria-keyshortcuts")).toMatch(/Shift\+H$/);
    expect(control("Hang up")?.disabled).toBe(true);
  });

  it("hides Mute and Captions while the call is ringing", () => {
    render(activeCall({ stage: "calling", startedAt: null }));
    expect(control("Mute")).toBeNull();
    expect(control("Captions")).toBeNull();
    expect(control("Call voice")).not.toBeNull();
  });
});
