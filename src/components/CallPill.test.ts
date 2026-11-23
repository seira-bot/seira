// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import { activeCall, atlas, turnsConfig } from "./call-test-support";

const fixture = vi.hoisted(() => ({ config: null as unknown, dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config as AppState["config"], bots: [] }, dispatch: fixture.dispatch }) };
});
const calls = vi.hoisted(() => ({ endCall: vi.fn() }));
vi.mock("@/lib/call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/call")>()), endCall: calls.endCall }));

const { CallPill } = await import("./CallPill");
const { resetVoicePreview } = await import("@/lib/call-voice-preview");

let root: Root;
let host: HTMLDivElement;
const onOpen = vi.fn();
const render = (call = activeCall()) => flushSync(() => root.render(createElement(CallPill, { bot: atlas, call, onOpen })));
const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const press = (element: Element | null) => flushSync(() => (element as HTMLElement).click());
const escape = () => flushSync(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });

beforeEach(() => {
  fixture.config = turnsConfig("openai");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  onOpen.mockClear();
  calls.endCall.mockClear();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  resetVoicePreview();
});

describe("CallPill", () => {
  it("shows the face, the name, the call time and state, and the four controls", () => {
    render(activeCall({ startedAt: Date.now() - 65_000 }));
    const group = host.querySelector('[role="group"]')!;
    expect(group.getAttribute("aria-label")).toBe("Call with Atlas");
    expect(group.textContent).toContain("Atlas");
    expect(group.textContent).toMatch(/1:0\d · /);
    for (const label of ["Call voice", "Captions", "Mute", "Hang up"]) expect(button(label), label).not.toBeNull();
  });

  it("shows only Call voice and Hang up while the call is still ringing", () => {
    render(activeCall({ stage: "calling", startedAt: null }));
    expect(group()?.textContent).toContain("Calling…");
    expect(button("Captions")).toBeNull();
    expect(button("Mute")).toBeNull();
    expect(button("Call voice")).not.toBeNull();
    expect(button("Hang up")).not.toBeNull();
  });

  it("opens the full call view from the face and the name", () => {
    render();
    press(button("Open call with Atlas"));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("hangs up the call", () => {
    render();
    press(button("Hang up"));
    expect(calls.endCall).toHaveBeenCalledWith("atlas");
  });

  it("shows the last four caption lines with the speaker, newest last", () => {
    const captions = ["one", "two", "three", "four", "five"].map((text, index) => ({ id: index, who: index % 2 ? "bot" as const : "you" as const, text }));
    render(activeCall({ captions }));
    press(button("Captions"));
    const lines = Array.from(host.querySelectorAll('[role="log"] li')).map((item) => item.textContent);
    expect(lines).toEqual(["Atlastwo", "Youthree", "Atlasfour", "Youfive"]);
  });

  it("says what captions are for while there are none", () => {
    render();
    press(button("Captions"));
    expect(host.textContent).toContain("Captions show up here as you talk.");
  });

  it("closes the popover on Escape and puts the focus back on its button", () => {
    render();
    const captions = button("Captions")!;
    press(captions);
    expect(captions.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    escape();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(captions);
    expect(calls.endCall).not.toHaveBeenCalled();
  });

  it("opens one popover at a time", () => {
    render();
    press(button("Captions"));
    press(button("Call voice"));
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Call voice");
  });

  it("names the mute and hang-up chords on a Live call and blocks a second hang-up while it ends", () => {
    render(activeCall({ mode: "live", presence: "ending" }));
    expect(button("Mute")?.getAttribute("aria-keyshortcuts")).toMatch(/Shift\+M$/);
    expect(button("Hang up")?.getAttribute("aria-keyshortcuts")).toMatch(/Shift\+H$/);
    expect(button("Hang up")?.disabled).toBe(true);
  });

  it("uses 32px round buttons", () => {
    render();
    expect(button("Hang up")?.className).toContain("size-8");
    expect(button("Hang up")?.className).toContain("rounded-full");
  });
});

function group() {
  return host.querySelector('[role="group"]');
}
