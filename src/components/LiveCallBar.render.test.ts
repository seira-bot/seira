import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, initialState, StoreProvider, type AppState, type Bot } from "@/state/store";
import { endCall } from "@/lib/call";
import { configureLiveMedia, resetLiveMedia, startLiveCall } from "@/lib/live-call-media";
import { LiveCallBar } from "./LiveCallBar";
import { LiveKeySetup } from "./LiveKeySetup";

const bot: Bot = {
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
};

const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(StoreProvider, null, element));
const renderOnCloud = (element: ReturnType<typeof createElement>) => {
  const config = { cloudHome: true, live: { configured: true, voice: "marin", readTypedReplies: true, idleMinutes: 5 } } as AppState["config"];
  const value = { state: { ...initialState, config }, dispatch: vi.fn(), flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
  return renderToStaticMarkup(createElement(BotEditorStore, { value, children: element }));
};
const CLOUD_DISCLOSURE = `A Live call sends your voice to OpenAI, along with the chat&#x27;s recent messages, the bot&#x27;s answers and the details of any approval it asks for. The OpenAI key stays in the Cloud.`;

afterEach(() => {
  resetLiveMedia();
  endCall();
  vi.unstubAllGlobals();
});

describe("LiveCallBar", () => {
  it("renders nothing without a call", () => {
    expect(render(createElement(LiveCallBar, { bot }))).toBe("");
  });

  it.each([
    ["refused", "The app didn&#x27;t let this page use the microphone. Open it in your web browser to make the Live call.", "Open in browser", "Try again"],
    ["allowed", "Allow microphone access for this app in your computer&#x27;s privacy settings, then try again.", "Try again", "Open in browser"],
  ] as const)("shows a microphone the app %s with its one action", async (pageMic, text, action, other) => {
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}) } });
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: false, engine: "none", onDevice: false, reasonCode: "remote-server" } }) as DesktopCapabilities,
      pageMicrophone: async () => pageMic,
    });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toContain(text);
    expect(markup).toContain(`aria-label="${action}"`);
    expect(markup).not.toContain(`aria-label="${other}"`);
  });

  it("offers Open System Settings with a microphone this computer refused", async () => {
    const permOpenSettings = vi.fn(async () => {});
    vi.stubGlobal("window", { ogb: { speechStop: vi.fn(async () => {}), permOpenSettings } });
    configureLiveMedia({
      getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      capabilities: () => ({ dictation: { available: true, engine: "none", onDevice: false } }) as unknown as DesktopCapabilities,
      pageMicrophone: async () => undefined,
    });
    await startLiveCall({ botId: bot.id, threadId: bot.threadId });
    const markup = render(createElement(LiveCallBar, { bot }));
    expect(markup).toContain('data-open-system-settings="mic"');
    expect(markup).toContain("Open System Settings");
  });
});

describe("LiveKeySetup", () => {
  it("says what the key is for, in the app's language", () => {
    const markup = render(createElement(LiveKeySetup, { onSaved: vi.fn() }));
    expect(markup).toContain("Live calls use OpenAI GPT-Live");
    expect(markup).toContain(`A Live call sends your voice to OpenAI, along with the chat&#x27;s recent messages, the bot&#x27;s answers and the details of any approval it asks for. The OpenAI key stays on your computer.`);
    expect(markup).toContain('aria-label="OpenAI API key for Live calls"');
    expect(markup).toContain("Save and start the call");
    expect(render(createElement(LiveKeySetup, { onSaved: vi.fn(), compact: true }))).toContain(">Save<");
  });

  it("says the key stays on the Cloud when the chat is on the person's Cloud", () => {
    const markup = renderOnCloud(createElement(LiveKeySetup, { onSaved: vi.fn() }));
    expect(markup).toContain(CLOUD_DISCLOSURE);
    expect(markup).not.toContain("stays on your computer");
  });
});
