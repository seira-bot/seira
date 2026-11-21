import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_CLOSE_REASON_CHARS, BOARD_DONE_WINDOW_MS, type BoardCard } from "../shared/board.ts";
import { writeFileAtomic } from "./atomic.ts";

export interface BoardClosure {
  at: number;
  by: NonNullable<BoardCard["closedBy"]>;
  reason?: string;
}

export interface BoardClosures {
  get(cardId: string): BoardClosure | undefined;
  close(cardId: string, by: BoardClosure["by"], reason?: string): void;
}

const MAX_ENTRIES = 1000;
const FILE = "board-closed.json";

function parseBy(value: unknown): BoardClosure["by"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const by = value as Record<string, unknown>;
  if (by.kind === "person" && typeof by.name === "string") return { kind: "person", name: by.name };
  if (by.kind === "bot" && typeof by.botId === "string") return { kind: "bot", botId: by.botId };
  return undefined;
}

function load(file: string): Map<string, BoardClosure> {
  const closures = new Map<string, BoardClosure>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return closures;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return closures;
  for (const [cardId, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const { at, by, reason } = entry as Record<string, unknown>;
    const parsed = parseBy(by);
    if (typeof at !== "number" || !Number.isFinite(at) || !parsed) continue;
    closures.set(cardId, { at, by: parsed, ...(typeof reason === "string" && reason ? { reason } : {}) });
  }
  return closures;
}

/** Which Needs you cards a person or a bot moved to Done, kept in the data folder for as long as the Done column shows them. */
export function createBoardClosures(options: { dataDir: string; now?: () => number }): BoardClosures {
  const file = join(options.dataDir, FILE);
  const now = options.now ?? Date.now;
  const closures = load(file);
  return {
    get: (cardId) => closures.get(cardId),
    close(cardId, by, reason) {
      const at = now();
      const text = reason?.replace(/\s+/g, " ").trim().slice(0, BOARD_CLOSE_REASON_CHARS);
      closures.delete(cardId);
      closures.set(cardId, { at, by, ...(text ? { reason: text } : {}) });
      for (const [id, closure] of closures) if (closure.at < at - BOARD_DONE_WINDOW_MS) closures.delete(id);
      while (closures.size > MAX_ENTRIES) closures.delete(closures.keys().next().value as string);
      writeFileAtomic(file, JSON.stringify(Object.fromEntries(closures)) + "\n", { mode: 0o600 });
    },
  };
}
