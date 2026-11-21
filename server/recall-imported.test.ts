import { rmSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import { autoRecallThreadIds, recallThreadIds } from "./recall.ts";
import { Store } from "./store.ts";
import { createImportedThreads } from "./store-imported.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

it("skips imported archive", () => {
  const store = new Store(selection);
  const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
  const normal = store.createTask(bot.id, "Normal", false)!;
  createImportedThreads(store, bot.id, [{ threadId: "imp-a", title: "Old chat", createdAt: 1, updatedAt: 2, imported: { kind: "paste", label: "Pasted chat" } }]);
  const owner = store.bot(bot.id)!;
  const rooms = new Map<string, unknown>();
  expect(recallThreadIds(owner, rooms)).toContain("imp-a");
  const auto = autoRecallThreadIds(owner, rooms);
  expect(auto).not.toContain("imp-a");
  expect(auto).toContain(normal.threadId);
  expect(auto).toContain(owner.threadId);
});
