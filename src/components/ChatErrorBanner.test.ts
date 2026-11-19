// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTeamPeople } from "@/state/team-people";
import { StoreProvider, useStore } from "@/state/store";
import { ChatErrorBanner, ChatNotice } from "./ChatErrorBanner";

const source = (name: string) => readFileSync(resolve(process.cwd(), "src", name), "utf8");

describe("ChatErrorBanner", () => {
  it("renders nothing when there is no error", () => {
    expect(renderToStaticMarkup(createElement(ChatErrorBanner, { message: null, onDismiss: () => undefined }))).toBe("");
  });

  it("announces the error and offers a dismiss control", () => {
    const onDismiss = vi.fn();
    const markup = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "Clipboard has no image", onDismiss }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Clipboard has no image");
    expect(markup).toContain('aria-label="Dismiss"');
    expect(markup).toContain('type="button"');
    expect(markup).toContain("border-danger/30");
  });

  it("shows Seira sad beside the error", () => {
    expect(renderToStaticMarkup(createElement(ChatErrorBanner, { message: "Clipboard has no image", onDismiss: () => undefined }))).toContain('data-seira-state="sad"');
  });

  it("reads a machine's words as one plain line and keeps them under Details", () => {
    const markup = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "502 Bad Gateway", onDismiss: () => undefined }));
    expect(markup).toContain("Something went wrong on the other end. Try again.");
    expect(markup).toContain("<details");
    expect(markup).toContain(">Details</summary>");
    expect(markup).toContain("502 Bad Gateway");
  });

  it("tells a team's member who can do it instead of the server's refusal, which stays under Details", () => {
    const refusal = 'forbidden: this session may change how a bot looks, not "name" (needs the admin scope)';
    const banner = () => renderToStaticMarkup(createElement(ChatErrorBanner, { message: refusal, onDismiss: () => undefined }));
    expect(banner(), "off a team as before").not.toContain("<details");
    try {
      setTeamPeople({ people: [], me: null, admin: false, needsYou: [] });
      expect(banner()).toContain("<p>Only the owner or an admin can do that.</p>");
      expect(banner()).toContain("<details");
      setTeamPeople({ people: [], me: null, admin: true, needsYou: [] });
      expect(banner(), "an admin reads what the server said").not.toContain("<details");
    } finally { setTeamPeople(null); }
  });

  it("shows a sentence as it is, with nothing to expand", () => {
    const markup = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "Clipboard has no image", onDismiss: () => undefined }));
    expect(markup).not.toContain("<details");
  });

  it("wraps a long message instead of widening the banner", () => {
    const markup = renderToStaticMarkup(createElement(ChatErrorBanner, { message: "Failed to fetch", onDismiss: () => undefined }));
    expect(markup).toContain('class="min-w-0 flex-1 break-words"');
  });

  it("is the banner both the chat and the room render", () => {
    for (const file of ["components/ChatView.tsx", "components/GroupView.tsx"]) {
      const text = source(file);
      expect(text).toContain("<ChatErrorBanner");
      expect(text).toContain('message={state.error}');
      expect(text).toContain('dispatch({ type: "error", message: null })');
    }
    const store = source("state/store.tsx");
    expect(store).toContain("useChatErrorClear(state.error, clearChatError)");
    expect(store).not.toContain('setTimeout(() => rawDispatch({ type: "error", message: null }), 6000)');
  });
});

describe("ChatNotice", () => {
  const markup = (notice: Parameters<typeof ChatNotice>[0]["notice"]) => renderToStaticMarkup(createElement(ChatNotice, { notice }));

  it("says which reference no longer resolves", () => {
    expect(markup(null)).toBe("");
    expect(markup({ kind: "thread-gone", botName: null })).toContain("That thread is no longer here.");
    expect(markup({ kind: "thread-gone", botName: "Ada" })).toContain("That thread is no longer here. Showing Ada instead.");
    expect(markup({ kind: "bot-gone", botName: null })).toContain("That bot is no longer here.");
    expect(markup({ kind: "bot-gone", botName: null })).toContain('role="status"');
  });

  it("says why a pressed Steer left pictures queued", () => {
    const text = markup({ kind: "steer-images", botName: null });
    expect(text).toContain("Pictures can&#x27;t be steered into this bot&#x27;s running turn. Your message will be sent as the next turn.");
    expect(text).toContain('role="status"');
  });

  it("shows the server's own words when a deletion went through with something left to tidy", () => {
    const text = markup({ kind: "note", botName: null, text: "Deleted. gone-vps could not be reached, so the bot's computer there was left as it was." });
    expect(text).toContain("Deleted. gone-vps could not be reached, so the bot&#x27;s computer there was left as it was.");
    expect(text).toContain('role="status"');
  });

  it("shows in the room as well as the chat", () => {
    for (const file of ["components/ChatView.tsx", "components/GroupView.tsx"]) {
      expect(source(file)).toContain("<ChatNotice notice={state.notice} />");
    }
  });
});

class FixtureEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close() {}
}

describe("ChatNotice with no AI", () => {
  const text = "Olive needs to connect an AI before bots can answer. I've told them.";
  let store!: ReturnType<typeof useStore>;
  let host: HTMLElement;
  let root: Root;
  function Harness() { store = useStore(); return createElement(ChatNotice, { notice: store.state.notice }); }
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("EventSource", FixtureEventSource);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ bots: [], groups: [], instances: [] })));
    host = document.createElement("div");
    root = createRoot(host);
    await act(async () => { root.render(createElement(StoreProvider, null, createElement(Harness))); });
    await act(async () => { store.dispatch({ type: "notice", notice: { kind: "no-ai", botName: null, text } }); });
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    vi.unstubAllGlobals();
    setTeamPeople(null);
  });

  it("shows the words with a way to connect and a way to dismiss", () => {
    expect(host.textContent).toContain(text);
    expect(button("Connect an AI")).toBeDefined();
    expect(button("Dismiss")?.getAttribute("title")).toBe("Dismiss");
  });

  it("offers no way to connect to a team's member", async () => {
    await act(async () => { setTeamPeople({ people: [], me: null, admin: false, needsYou: [] }); });
    expect(host.textContent).toContain(text);
    expect(button("Connect an AI")).toBeUndefined();
    expect(button("Dismiss")).toBeDefined();
  });

  it("goes away when the person dismisses it", async () => {
    await act(async () => { button("Dismiss")!.click(); });
    expect(store.state.notice).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("goes away when an AI is ready", async () => {
    const ready = { id: "i1", driverKind: "codex", access: "account", snapshot: { state: "available", authenticated: true } };
    await act(async () => { store.dispatch({ type: "instances", instances: [ready] as never }); });
    expect(store.state.notice).toBeNull();
  });
});
