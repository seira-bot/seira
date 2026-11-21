import type { ImportJobView, ImportUndoResult } from "../../shared/ai-import/api.ts";
import type { Fingerprint, ImportDb, Receipt, ReceiptKind } from "./db.ts";
import { hashOf, sha256 } from "./ids.ts";
import type { ImportPorts } from "./ports.ts";
import type { SkillFolderFile } from "../skill-folder.ts";
import type { RoutineScheduleInput } from "../routines.ts";

export type Decision = "add" | "skip" | "update" | "keep-both";

/** The rule for an item that a former import may have brought in already. `current` is the hash of that copy now, null when it is gone. */
export function decide(previous: Fingerprint | null, contentHash: string, current: string | null): Decision {
  if (!previous || current === null) return "add";
  if (previous.contentHash === contentHash) return "skip";
  return current === previous.written ? "update" : "keep-both";
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function routineHash(routine: { name: string; prompt: string; enabled: boolean }): string {
  return hashOf({ name: routine.name, prompt: routine.prompt, enabled: routine.enabled });
}

export function conversationHash(state: { messages: number; archived: boolean } | null): string | null {
  if (!state) return null;
  return state.archived ? String(state.messages) : `open:${state.messages}`;
}

/** The hash of what the target of a receipt or fingerprint holds now; null when it is gone. */
export function currentHash(kind: ReceiptKind, target: Record<string, unknown>, ports: ImportPorts, memory?: Map<string, string>): string | null {
  const botId = text(target.botId);
  switch (kind) {
    case "bot":
      return ports.bots.exists(botId) ? "bot" : null;
    case "persona":
      return ports.bots.exists(botId) ? sha256(ports.bots.soul(botId)) : null;
    case "topic": {
      const topic = ports.memory.readTopic(botId, text(target.topic));
      return topic === null ? null : sha256(topic);
    }
    case "daily": {
      const log = ports.memory.readLog(botId, text(target.log));
      return log === null ? null : sha256(log);
    }
    case "memory": {
      const line = text(target.line);
      const file = memory?.get(botId) ?? ports.memory.read(botId);
      return file.split("\n").includes(line) ? sha256(line) : null;
    }
    case "skill":
      return ports.skills.hash(botId, text(target.name));
    case "tool": {
      const server = ports.tools.servers()[text(target.name)];
      return server === undefined ? null : hashOf(server);
    }
    case "routine": {
      const routine = ports.routines.get(text(target.routineId));
      return routine ? routineHash(routine) : null;
    }
    case "conversation":
      return conversationHash(ports.threads.state(botId, text(target.threadId)));
  }
}

/** Puts back a skill as it was before an import changed it, switched on only if it was on. */
export function restoreSkill(ports: ImportPorts, botId: string, before: { files: SkillFolderFile[]; enabled: boolean }): void {
  const installed = ports.skills.install(botId, "import", before.files);
  if (before.enabled && !("error" in installed)) ports.skills.enable(botId, installed.name);
}

/** Removes what a job added and restores what it updated. With `force`, a changed item goes too (used to roll back a failed job). */
export function undoJob(db: ImportDb, jobId: string, ports: ImportPorts, options: { force?: boolean } = {}): ImportUndoResult {
  const result: ImportUndoResult = { removed: 0, restored: 0, kept: [] };
  const receipts = db.receipts(jobId).reverse();
  const memory = new Map<string, string>();
  const memoryChanged = new Set<string>();
  const memoryText = (botId: string): string => {
    if (!memory.has(botId)) memory.set(botId, ports.memory.read(botId));
    return memory.get(botId)!;
  };
  let servers: Record<string, unknown> | null = null;
  const threadsByBot = new Map<string, string[]>();
  const removedThreads = new Set<string>();
  const keptBots = new Set<string>();

  const restoreFingerprint = (receipt: Receipt) => {
    if (!receipt.fingerprint) return;
    if (receipt.previous) db.putFingerprint(receipt.previous);
    else db.deleteFingerprint(receipt.fingerprint);
  };

  for (const receipt of receipts) {
    const target = receipt.target;
    const botId = text(target.botId);
    if (receipt.kind === "bot") continue;
    const now = currentHash(receipt.kind, target, ports, memory);
    if (now === null) {
      restoreFingerprint(receipt);
      continue;
    }
    if (now !== receipt.written && !options.force) {
      result.kept.push(receipt.name);
      keptBots.add(botId);
      continue;
    }
    const added = receipt.action === "added";
    switch (receipt.kind) {
      case "persona":
        ports.bots.setSoul(botId, text(receipt.before));
        break;
      case "topic":
        if (added) ports.memory.removeTopic(botId, text(target.topic));
        else ports.memory.writeTopic(botId, text(target.topic), text(receipt.before));
        break;
      case "daily":
        if (added) ports.memory.removeLog(botId, text(target.log));
        else ports.memory.writeLog(botId, text(target.log), text(receipt.before));
        break;
      case "memory": {
        const lines = memoryText(botId).split("\n");
        const at = lines.indexOf(text(target.line));
        if (at >= 0) {
          if (added) lines.splice(at, 1);
          else lines[at] = text(receipt.before);
          memory.set(botId, lines.join("\n"));
          memoryChanged.add(botId);
        }
        break;
      }
      case "skill": {
        ports.skills.remove(botId, text(target.name));
        const before = receipt.before as { files: SkillFolderFile[]; enabled: boolean } | null;
        if (!added && before) restoreSkill(ports, botId, before);
        break;
      }
      case "tool": {
        servers ??= ports.tools.servers();
        const name = text(target.name);
        if (added) {
          delete servers[name];
          if (ports.bots.exists(botId)) ports.bots.setTools(botId, ports.bots.tools(botId).filter((tool) => tool !== name));
        } else {
          servers[name] = receipt.before;
        }
        break;
      }
      case "routine": {
        const id = text(target.routineId);
        if (added) ports.routines.remove(id);
        else ports.routines.update(id, receipt.before as { name: string; prompt: string; schedule: RoutineScheduleInput });
        break;
      }
      case "conversation": {
        const threadId = text(target.threadId);
        if (added) {
          threadsByBot.set(botId, [...(threadsByBot.get(botId) ?? []), threadId]);
          removedThreads.add(threadId);
        } else {
          const ids = Array.isArray(target.addedIds) ? target.addedIds.filter((id): id is string => typeof id === "string") : [];
          const before = receipt.before as { activeLeafId?: string | null } | null;
          ports.threads.removeMessages(threadId, ids, before?.activeLeafId ?? null);
        }
        break;
      }
    }
    if (added) result.removed += 1;
    else result.restored += 1;
    restoreFingerprint(receipt);
  }

  for (const [botId, threadIds] of threadsByBot) ports.threads.remove(botId, threadIds);
  for (const botId of memoryChanged) ports.memory.write(botId, memory.get(botId)!);
  if (servers) ports.tools.persist(servers);

  for (const receipt of receipts) {
    if (receipt.kind !== "bot") continue;
    const botId = text(receipt.target.botId);
    if (!ports.bots.exists(botId)) {
      restoreFingerprint(receipt);
      continue;
    }
    if (!options.force && (keptBots.has(botId) || ports.bots.busy(botId, removedThreads))) {
      result.kept.push(receipt.name);
      continue;
    }
    ports.bots.remove(botId);
    result.removed += 1;
    restoreFingerprint(receipt);
  }

  db.deleteReceipts(jobId);
  return result;
}

/** Deletes the receipts of jobs whose Undo time is over and returns the views that changed. */
export function expireReceipts(db: ImportDb, now: number): ImportJobView[] {
  const changed: ImportJobView[] = [];
  for (const row of db.jobs()) {
    if (row.view.undoUntil === null || row.view.undoUntil > now) continue;
    db.deleteReceipts(row.id);
    const view = { ...row.view, undoUntil: null, updatedAt: now };
    db.saveView(view);
    changed.push(view);
  }
  return changed;
}
