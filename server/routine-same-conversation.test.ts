import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import type { WorkflowStep } from "../shared/workflows.ts";
import { DATA_DIR } from "./config.ts";
import { continuesChat, ownChatAccess } from "./routine-same-conversation.ts";
import { Store } from "./store.ts";

const sonnet = { instanceId: "claude", model: "claude-sonnet-5" };
const opus = { instanceId: "claude", model: "claude-opus-5" };
const full = { modelSelection: undefined, access: undefined };
const fenced = { modelSelection: undefined, access: "read-and-draft" as const };

describe("continuesChat", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  const fixture = () => {
    const store = new Store(() => sonnet);
    const ana = store.createBot({ name: "Ana" });
    store.setAllThreadApprovalMode(ana.id, "full");
    const chat = store.createTask(ana.id, "Morning", false)!.threadId;
    return { store, ana, chat };
  };

  it("goes on in a chat that is what a new one would be now", () => {
    const { store, ana, chat } = fixture();
    expect(continuesChat(store, ana.id, chat, {}, full)).toBe(true);
    expect(continuesChat(store, ana.id, chat, { access: "read-and-draft" }, fenced)).toBe(true);
    expect(continuesChat(store, ana.id, chat, {}, { modelSelection: sonnet, access: undefined })).toBe(true);
  });

  it("opens a new chat when the chat's model or the model the run needs changed", () => {
    const { store, ana, chat } = fixture();
    expect(continuesChat(store, ana.id, chat, {}, { modelSelection: opus, access: undefined })).toBe(false);
    store.patchTask(ana.id, chat, { modelSelection: opus });
    expect(continuesChat(store, ana.id, chat, {}, full)).toBe(false);
    expect(continuesChat(store, ana.id, chat, {}, { modelSelection: opus, access: undefined })).toBe(true);
  });

  it.each<[string, (store: Store, botId: string, chat: string) => void]>([
    ["the chat's approval", (store, botId, chat) => { store.patchTask(botId, chat, { approvalMode: "ask", autoApprove: false }); }],
    ["the chat's always-allowed tools", (store, botId, chat) => { store.patchTask(botId, chat, { alwaysAllow: ["Bash"] }); }],
    ["the bot's approval", (store, botId) => { store.patchBot(botId, { approvalMode: "ask", autoApprove: false }); }],
    ["the bot's always-allowed tools", (store, botId) => { store.patchBot(botId, { alwaysAllow: ["Bash"] }); }],
  ])("opens a new chat when %s changed", (_name, change) => {
    const { store, ana, chat } = fixture();
    change(store, ana.id, chat);
    expect(continuesChat(store, ana.id, chat, {}, full)).toBe(false);
  });

  it("opens a new chat when the access changed either way, or no run owns the chat", () => {
    const { store, ana, chat } = fixture();
    expect(continuesChat(store, ana.id, chat, {}, fenced)).toBe(false);
    expect(continuesChat(store, ana.id, chat, { access: "read-and-draft" }, full)).toBe(false);
    expect(continuesChat(store, ana.id, chat, null, full)).toBe(false);
  });

  it("opens a new chat for another bot's chat, and for a bot that is hidden or gone", () => {
    const { store, ana, chat } = fixture();
    const ben = store.createBot({ name: "Ben" });
    expect(continuesChat(store, ben.id, chat, {}, full)).toBe(false);
    expect(continuesChat(store, "gone", chat, {}, full)).toBe(false);
    store.patchBot(ana.id, { hidden: true });
    expect(continuesChat(store, ana.id, chat, {}, full)).toBe(false);
  });
});

describe("ownChatAccess", () => {
  const step = (over: Partial<Extract<WorkflowStep, { kind: "bot" }>> = {}): WorkflowStep =>
    ({ id: "a", kind: "bot", botId: "ana", instruction: "Collect", position: { x: 0, y: 0 }, ...over });

  it("is the first step's own access when that step works in the run's chat, else the run's", () => {
    expect(ownChatAccess({ botId: "ana" }, step({ access: "read-and-draft" }))).toBe("read-and-draft");
    expect(ownChatAccess({ botId: "ana", access: "read-and-draft" }, step())).toBe("read-and-draft");
    expect(ownChatAccess({ botId: "ana" }, step())).toBeUndefined();
    expect(ownChatAccess({ botId: "ana" }, step({ access: "read-and-draft", botId: "ben" }))).toBeUndefined();
    expect(ownChatAccess({ botId: "ana" }, step({ access: "read-and-draft", modelSelection: opus }))).toBeUndefined();
    expect(ownChatAccess({ botId: "ana", access: "read-and-draft" }, undefined)).toBe("read-and-draft");
  });
});
