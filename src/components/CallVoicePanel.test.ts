// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";
import { atlas } from "./call-test-support";

const fixture = vi.hoisted(() => ({ config: null as unknown, dispatch: vi.fn(), device: false }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: fixture.config as AppState["config"], bots: [] }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/local-voice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-voice")>()),
  localSystemVoiceActive: () => fixture.device,
  listLocalSystemVoices: () => [{ id: "v1", label: "Samantha" }],
}));

const { CallVoicePanel } = await import("./CallVoicePanel");
const { resetVoicePreview } = await import("@/lib/call-voice-preview");

const live = (provider: string) => ({ tts: { configured: true, ready: true, voice: "marin" }, live: { configured: true, provider, voice: "marin", readTypedReplies: true, idleMinutes: 5 } }) as unknown as AppState["config"];
const turns = (provider: string) => ({ tts: { configured: true, ready: true, voice: "marin", provider }, live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 } }) as unknown as AppState["config"];

let root: Root;
let host: HTMLDivElement;
const fetchMock = vi.fn();
const render = (mode: "live" | "turns", bot: Bot = atlas) => flushSync(() => root.render(createElement(CallVoicePanel, { bot, call: { mode } })));
const press = (element: Element | null) => flushSync(() => (element as HTMLElement).click());
const slider = () => host.querySelector<HTMLInputElement>("#call-voice-speed")!;
const radios = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const text = () => host.textContent ?? "";

function setSlider(value: number) {
  const input = slider();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  flushSync(() => input.dispatchEvent(new Event("pointerup", { bubbles: true })));
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.device = false;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ voices: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  resetVoicePreview();
  vi.unstubAllGlobals();
});

describe("CallVoicePanel speed", () => {
  it.each([
    ["live", live("openai"), 0.75, 1.5],
    ["live", live("azure"), 0.75, 1.5],
    ["live", live("elevenlabs"), 0.7, 1.2],
    ["live", live("fish"), 0.5, 2],
    ["turns", turns("openai"), 0.75, 1.5],
    ["turns", turns("elevenlabs"), 0.7, 1.2],
    ["turns", turns("xai"), 0.7, 1.5],
    ["turns", turns("fish"), 0.5, 2],
    ["turns", turns("gemini"), 0.75, 1.5],
    ["turns", turns("chatterbox"), 0.75, 1.5],
  ] as const)("shows a %s slider in the provider's range", (mode, config, min, max) => {
    fixture.config = config;
    render(mode);
    expect(slider().disabled).toBe(false);
    expect(Number(slider().min)).toBe(min);
    expect(Number(slider().max)).toBe(max);
  });

  it.each([
    ["gemini", "This voice service sets its own pace."],
    ["custom", "This call service sets its own pace."],
    ["codex", "Codex speaks at one pace."],
  ] as const)("shows the speed of a Live %s call as disabled, with one plain reason", (provider, reason) => {
    fixture.config = live(provider);
    render("live");
    expect(slider().disabled).toBe(true);
    expect(text()).toContain(reason);
    expect(host.querySelectorAll("#call-voice-speed-note")).toHaveLength(1);
  });

  it("saves the chosen speed on the called bot when the slider is released", () => {
    fixture.config = live("openai");
    render("live");
    setSlider(1.25);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "updateBot", botId: "atlas", patch: { callSpeed: 1.25 } });
  });

  it("clamps a saved speed to the provider range and resets to normal", () => {
    fixture.config = turns("elevenlabs");
    render("turns", { ...atlas, callSpeed: 1.8 });
    expect(slider().value).toBe("1.2");
    press(Array.from(host.querySelectorAll("button")).find((item) => item.textContent === "Normal speed") ?? null);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "atlas", patch: { callSpeed: 1 } });
  });

  it("says when a speed starts: next reply for Turns, next call for an agent voice", () => {
    fixture.config = turns("openai");
    render("turns");
    expect(text()).toContain("From the next reply.");
    fixture.config = live("elevenlabs");
    render("live");
    expect(text()).toContain("From the next call.");
  });
});

describe("CallVoicePanel voice list", () => {
  it("shows a fixed list as cards", () => {
    fixture.config = turns("openai");
    render("turns");
    expect(host.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(radios().length).toBeGreaterThan(3);
    expect(radios().filter((item) => item.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("shows an account or library list as a search", () => {
    fixture.config = turns("elevenlabs");
    render("turns");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.querySelector('[aria-label="Voice"]')).not.toBeNull();
  });

  it("says the voice belongs to the agent for a Live agent provider", () => {
    fixture.config = live("elevenlabs");
    render("live");
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(text()).toMatch(/The voice comes from your agent at ElevenLabs/);
  });

  it("says Codex uses one voice, with no hint about the next call and no language", () => {
    fixture.config = live("codex");
    render("live");
    expect(text()).toContain("This call uses one voice.");
    expect(text()).not.toContain("Starts on the next call.");
    expect(host.querySelector("#call-voice-language")).toBeNull();
  });

  it("lists this computer's voices for the device voice", () => {
    fixture.device = true;
    fixture.config = turns("system");
    render("turns");
    expect(host.querySelector('select[aria-label="Voice on this computer"]')?.textContent).toContain("Samantha");
  });

  it("keeps the current voice for a Live call and says the new voice starts on the next call", () => {
    fixture.config = live("openai");
    render("live");
    expect(text()).toContain("Starts on the next call.");
    const other = radios().find((item) => item.getAttribute("aria-checked") === "false")!;
    press(other);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "atlas", patch: { liveVoice: expect.any(String) } });
  });

  it("says nothing about the next call for a Turns voice, which changes with the next reply", () => {
    fixture.config = turns("openai");
    render("turns");
    expect(text()).not.toContain("Starts on the next call.");
    press(radios().find((item) => item.getAttribute("aria-checked") === "false") ?? null);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "atlas", patch: { voice: expect.any(String) } });
  });
});

describe("CallVoicePanel samples", () => {
  const sampleButtons = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Play a sample"]'));

  it("plays one sample at the chosen speed and shows Stop on it", async () => {
    fetchMock.mockImplementation(async () => new Response(new Blob(["x"]), { status: 200 }));
    vi.stubGlobal("Audio", class { src = ""; playbackRate = 1; preservesPitch = false; onended = null; onerror = null; play = () => new Promise<void>(() => {}); pause() {} });
    URL.createObjectURL = () => "blob:x";
    URL.revokeObjectURL = () => undefined;
    fixture.config = live("openai");
    render("live", { ...atlas, callSpeed: 1.25 });
    press(sampleButtons()[0] ?? null);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/call/voice-preview", expect.anything()));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ provider: "openai", speed: 1.25, text: "Hi, this is how I sound on a call." });
    await vi.waitFor(() => expect(host.querySelectorAll('button[aria-label="Stop the sample"]')).toHaveLength(1));
  });

  it("hides the play button of a voice the provider cannot sample", async () => {
    fetchMock.mockImplementation(async () => new Response("", { status: 404 }));
    fixture.config = live("openai");
    render("live");
    const before = sampleButtons().length;
    press(sampleButtons()[0] ?? null);
    await vi.waitFor(() => expect(sampleButtons().length).toBe(before - 1));
  });
});

describe("CallVoicePanel language", () => {
  it("saves the chosen language on the bot", () => {
    fixture.config = turns("elevenlabs");
    render("turns");
    const select = host.querySelector<HTMLSelectElement>("#call-voice-language")!;
    expect(select.value).toBe("auto");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "id");
    flushSync(() => select.dispatchEvent(new Event("change", { bubbles: true })));
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "atlas", patch: { callLanguage: "id" } });
  });

  it("shows the provider and the mode on the chip", () => {
    fixture.config = live("openai");
    render("live");
    expect(text()).toContain("OpenAI · Live");
  });
});
