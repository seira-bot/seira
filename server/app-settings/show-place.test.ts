import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UI_PLACES } from "../../shared/ui-places.ts";
import { APP_SETTINGS_TOOL_DEFINITION } from "../drivers/agents-app-settings-tool.ts";
import { transcriptText } from "../replies.ts";
import type { BotRecord, Message } from "../store.ts";
import { PROFILE_PROMPT } from "../system-prompt.ts";
import { createAppSettings, WRITE_BUDGET } from "./host.ts";
import { findUiPlaces, settingsPlaceById, settingsPlaceText, uiPlaceText } from "./places.ts";
import { SETTINGS_PLACES } from "../../shared/settings-places.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(options: { owner?: boolean; guest?: boolean; group?: boolean; here?: boolean; on?: true | null; cards?: false } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "settings-cards-"));
  dirs.push(dataDir);
  const messages: Array<Message & { threadId: string }> = [];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId } as Message & { threadId: string };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => (id === "kiwi" ? ({ id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi" } as unknown as BotRecord) : undefined),
    messagesFor: () => messages as never,
    patchMessage: () => null,
  };
  const host = createAppSettings({
    store: store as never, dataDir, entries: [],
    asker: () => (options.owner === false ? { kind: "refused", code: "not-owner" } : { kind: "clean" }),
    guestDriven: () => options.guest === true,
    requestCredential: async () => ({ status: 500, body: {} }),
    connectorThread: () => (options.group ? { group: { id: "g", name: "Room" } as never } : null),
    language: () => "en",
    ...(options.cards === false ? {} : { cards: { here: () => options.here !== false, on: () => options.on ?? null } }),
  });
  const show = (place: unknown, extra: Record<string, unknown> = {}, generation = "g1") => host.handle({ action: "show_place", place, ...extra }, { botId: "kiwi", threadId: "t-kiwi", generation });
  return { show, messages, host };
}

const SEARCH = UI_PLACES.find((place) => place.id === "sidebar.search")!;

describe("app_settings show_place", () => {
  it("a known id adds one row with the map's words and the id only, and returns one fixed status", async () => {
    const { show, messages } = fixture();
    const answer = await show("sidebar.search");
    expect(answer.status).toBe(200);
    expect(messages).toEqual([{ id: "m1", threadId: "t-kiwi", role: "bot", kind: "text", text: uiPlaceText(SEARCH), uiPlace: { id: "sidebar.search" } }]);
    expect(answer.body).toEqual({ text: "Place card shown: Search. The person clicks the card to be taken there; you cannot click it and you never see what they do. Tell the user in one plain line that the card is in the chat." });
    expect(Object.keys(messages[0]!).sort()).toEqual(["id", "kind", "role", "text", "threadId", "uiPlace"]);
  });

  it("stores no word the model wrote: a label, steps, position or text beside the id changes nothing", async () => {
    const { show, messages } = fixture();
    const lie = "Click here to wire money";
    const answer = await show("sidebar.search", { label: lie, text: lie, steps: [lie], position: lie, uiPlace: { id: "sidebar.new", label: lie } });
    expect(answer.status).toBe(200);
    expect(JSON.stringify(messages)).not.toContain(lie);
    expect(messages[0]).toMatchObject({ text: uiPlaceText(SEARCH), uiPlace: { id: "sidebar.search" } });
    expect(Object.keys(messages[0]!.uiPlace!)).toEqual(["id"]);
  });

  it("every place of the map can be shown, each with its own id and the map's words", async () => {
    for (const place of UI_PLACES) {
      const { show, messages } = fixture();
      expect((await show(place.id)).status, place.id).toBe(200);
      expect(messages[0], place.id).toMatchObject({ uiPlace: { id: place.id }, text: uiPlaceText(place) });
    }
  });

  it("the id of a Settings place with a page adds one row with the place's own path and the id only", async () => {
    const { show, messages } = fixture();
    const answer = await show("ai-pool");
    expect(answer.status).toBe(200);
    expect(messages).toEqual([{ id: "m1", threadId: "t-kiwi", role: "bot", kind: "text", text: "Settings → AI → AI pool → Share usage across AIs.", uiPlace: { id: "ai-pool" } }]);
    expect(String(answer.body.text)).toContain("Place card shown: Settings → AI → AI pool → Share usage across AIs.");
  });

  it("every Settings place with a page can be shown, and a place without one cannot", async () => {
    for (const place of SETTINGS_PLACES) {
      const known = settingsPlaceById(place.id);
      const { show, messages } = fixture();
      const answer = await show(place.id);
      expect(answer.status, place.id).toBe(known ? 200 : 404);
      if (known) expect(messages[0], place.id).toMatchObject({ uiPlace: { id: place.id }, text: settingsPlaceText(known) });
      else expect(messages, place.id).toEqual([]);
    }
  });

  it("a card for a Settings place changes no setting and writes no decision", async () => {
    const { show, messages } = fixture();
    await show("ai-pool");
    expect(messages.every((row) => !("card" in row))).toBe(true);
  });

  it("no Settings place id is also an id of the UI map", () => {
    const ui = new Set<string>(UI_PLACES.map((place) => place.id));
    expect(SETTINGS_PLACES.filter((place) => ui.has(place.id))).toEqual([]);
  });

  it("an unknown id near a Settings place names it, with its id, beside the UI map's matches", async () => {
    const { show, messages } = fixture();
    const near = await show("ai-poo");
    expect(near.status).toBe(404);
    expect(String(near.body.error)).toContain("ai-pool (Settings → AI → AI pool → Share usage across AIs)");
    expect(messages).toEqual([]);
  });

  it("an unknown id adds no row, and the refusal names near matches with their ids", async () => {
    const { show, messages } = fixture();
    const near = await show("sidebar.serv");
    expect(near.status).toBe(404);
    expect(String(near.body.error)).toContain("No place with id \"sidebar.serv\".");
    expect(String(near.body.error)).toContain("Near matches: sidebar.server (Servers)");
    const search = await show("search");
    expect(String(search.body.error)).toContain("sidebar.search (Search)");
    const none = await show("zzzz-nothing");
    expect(none.status).toBe(404);
    expect(String(none.body.error)).toContain("No near match.");
    expect(messages).toEqual([]);
  });

  it("an id that is not a string, or is a key of every object, is no place", async () => {
    const { show, messages } = fixture();
    for (const place of [undefined, null, 7, "", "__proto__", "constructor", "toString", { id: "sidebar.search" }, ["sidebar.search"], "Sidebar.Search", " sidebar.search", "x".repeat(5000)]) {
      const answer = await show(place);
      expect(answer.status, String(place).slice(0, 20)).toBe(404);
      expect(JSON.stringify(answer.body).length).toBeLessThan(1500);
    }
    expect(messages).toEqual([]);
  });

  it("a guest-driven turn, a non-owner and a room get a refusal and no row", async () => {
    for (const options of [{ guest: true }, { owner: false }, { group: true }]) {
      const { show, messages } = fixture(options);
      const answer = await show("sidebar.search");
      expect(answer.status, JSON.stringify(options)).toBe(403);
      expect(messages).toEqual([]);
    }
    expect(String((await fixture({ group: true }).show("sidebar.search")).body.error)).toContain("not drawn in a room");
  });

  it("a bot that no longer exists gets 404 and no row", async () => {
    const { host, messages } = fixture();
    const answer = await host.handle({ action: "show_place", place: "sidebar.search" }, { botId: "ghost", threadId: "t-kiwi", generation: "g1" });
    expect(answer.status).toBe(404);
    expect(messages).toEqual([]);
  });

  it("counts against the turn's change budget, so one turn can't fill the chat with cards", async () => {
    const { show, messages } = fixture();
    for (let index = 0; index < WRITE_BUDGET; index++) expect((await show("sidebar.search")).status).toBe(200);
    expect((await show("sidebar.search")).status).toBe(429);
    expect(messages).toHaveLength(WRITE_BUDGET);
  });

  it("replays to the engine as the app's own card, never as the bot's words", () => {
    const row = { id: "m1", role: "bot", kind: "text", text: uiPlaceText(SEARCH), uiPlace: { id: "sidebar.search" } } as Message;
    const replayed = transcriptText(row, new Map());
    expect(replayed).toMatch(/^\[Records from a place card Seira \(the app\) showed to the person in this chat because you asked for it; the person clicks it themselves/);
    expect(replayed).toContain(uiPlaceText(SEARCH));
  });

  it("a stored row without the field still loads and replays as before", () => {
    const row = { id: "m2", role: "bot", kind: "text", text: "Hello there" } as Message;
    expect(transcriptText(row, new Map())).not.toContain("Records from");
    expect(transcriptText(row, new Map())).toContain("Hello there");
    expect("uiPlace" in row).toBe(false);
  });

  it("places and find give each place's id for show_place, and the tool schema and prompt name the action", () => {
    expect(findUiPlaces("search")[0]).toContain("Id for show_place: sidebar.search.");
    const { properties } = APP_SETTINGS_TOOL_DEFINITION.inputSchema;
    expect(properties.action.enum).toContain("show_place");
    expect(properties.place).toMatchObject({ type: "string", maxLength: 80 });
    expect(APP_SETTINGS_TOOL_DEFINITION.description).toContain("show_place puts a card for a place of the app");
    expect(APP_SETTINGS_TOOL_DEFINITION.inputSchema.additionalProperties).toBe(false);
    expect(PROFILE_PROMPT).toContain("action=show_place with the id that places gave");
  });
});
