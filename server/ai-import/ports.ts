import { rmSync } from "node:fs";
import { join } from "node:path";

import { removeMemoryFile } from "../message-db.ts";
import { mcpServerNameError, parseStoredMcpServer } from "../mcp-registry.ts";
import type { RoutineInput, RoutineScheduleInput } from "../routines.ts";
import type { SkillFolderFile } from "../skill-folder.ts";
import { installSkill, isSkillName, listSkills, readSkillFile, readSkillReferences, removeSkill, setSkillEnabled } from "../skills.ts";
import type { Store } from "../store.ts";
import { appendImportedMessages, createImportedThreads, importedThreadStats, removeImportedMessages, type ImportedMessageInput, type ImportedThreadInput } from "../store-imported.ts";
import {
  MEMORY_LOG_DIR, readMemoryFile, readMemoryLog, readMemoryTopic, workspaceDir, writeMemoryFile, writeMemoryLog, writeMemoryTopic,
} from "../workspace.ts";

export interface ThreadPart {
  threadId: string;
  messages: ImportedMessageInput[];
  activeLeafId: string | null;
}

/** Everything the import writes goes through these calls, so tests can count and break them. */
export interface ImportPorts {
  bots: {
    exists(botId: string): boolean;
    name(botId: string): string;
    names(): string[];
    create(name: string): string;
    remove(botId: string): void;
    /** True when the bot holds work the import did not write. */
    busy(botId: string, importedThreadIds: ReadonlySet<string>): boolean;
    soul(botId: string): string;
    setSoul(botId: string, soul: string): void;
    tools(botId: string): string[];
    setTools(botId: string, names: string[]): void;
  };
  threads: {
    create(botId: string, inputs: ImportedThreadInput[]): void;
    /** Writes all parts in one transaction and returns the count of new messages. */
    append(parts: ThreadPart[]): number;
    messageIds(threadId: string): Set<string>;
    removeMessages(threadId: string, ids: string[], activeLeafId: string | null): void;
    state(botId: string, threadId: string): { messages: number; archived: boolean; activeLeafId: string | null } | null;
    remove(botId: string, threadIds: string[]): void;
  };
  memory: {
    read(botId: string): string;
    write(botId: string, text: string): void;
    readTopic(botId: string, name: string): string | null;
    writeTopic(botId: string, name: string, text: string): void;
    removeTopic(botId: string, name: string): void;
    readLog(botId: string, name: string): string | null;
    writeLog(botId: string, name: string, text: string): void;
    removeLog(botId: string, name: string): void;
  };
  skills: {
    validName(name: string): boolean;
    /** Null when the bot has no skill with that name. */
    hash(botId: string, name: string): string | null;
    files(botId: string, name: string): SkillFolderFile[] | null;
    /** Installs the skill switched off. `flagged`: the safety scan found something to review. */
    install(botId: string, source: string, files: SkillFolderFile[]): { name: string; hash: string; flagged: boolean } | { error: string };
    enabled(botId: string, name: string): boolean;
    enable(botId: string, name: string): void;
    remove(botId: string, name: string): void;
  };
  tools: {
    servers(): Record<string, unknown>;
    nameError(name: string): string | null;
    check(name: string, server: Record<string, unknown>): "invalid" | "refused" | null;
    persist(next: Record<string, unknown>): void;
  };
  routines: {
    create(input: { botId: string; name: string; prompt: string; schedule: RoutineScheduleInput }): string;
    get(id: string): { name: string; prompt: string; enabled: boolean; schedule: RoutineScheduleInput } | null;
    update(id: string, patch: { name: string; prompt: string; schedule: RoutineScheduleInput }): void;
    remove(id: string): void;
  };
}

export interface StorePortDeps {
  mcp: {
    servers(): Record<string, unknown>;
    refusal(name: string, server: Record<string, unknown>): string | null;
    persist(next: Record<string, unknown>): void;
  };
  routines: {
    create(input: RoutineInput): { id: string };
    get(id: string): { name: string; prompt: string; enabled: boolean; schedule: RoutineScheduleInput } | null;
    update(id: string, patch: Partial<RoutineInput>): unknown;
    remove(id: string): unknown;
  };
}

export function createStorePorts(store: Store, deps: StorePortDeps): ImportPorts {
  const memoryPath = (botId: string, ...parts: string[]) => join(workspaceDir(botId), "memory", ...parts);
  return {
    bots: {
      exists: (botId) => Boolean(store.bot(botId)),
      name: (botId) => store.bot(botId)?.name ?? "",
      names: () => store.bots.map((bot) => bot.name),
      create: (name) => store.createBot({ name }, { seedMessages: false }).id,
      remove: (botId) => { store.deleteBot(botId); },
      busy: (botId, imported) => {
        const bot = store.bot(botId);
        if (!bot) return false;
        if (store.messagesFor(bot.threadId).length) return true;
        return (bot.tasks ?? []).some((task) => task.threadId !== bot.threadId && !imported.has(task.threadId));
      },
      soul: (botId) => store.bot(botId)?.soul ?? "",
      setSoul: (botId, soul) => { store.setSoul(botId, soul); },
      tools: (botId) => [...(store.bot(botId)?.mcpServers ?? [])],
      setTools: (botId, names) => { store.patchBot(botId, { mcpServers: names }); },
    },
    threads: {
      create: (botId, inputs) => { if (inputs.length) createImportedThreads(store, botId, inputs); },
      append: (parts) => (parts.length ? appendImportedMessages(store, parts) : 0),
      messageIds: (threadId) => new Set(store.messagesFor(threadId).map((message) => message.id)),
      removeMessages: (threadId, ids, activeLeafId) => { removeImportedMessages(store, threadId, ids, activeLeafId); },
      state: (botId, threadId) => {
        const task = store.taskByThread(botId, threadId);
        const stats = task ? importedThreadStats(threadId) : null;
        if (!task) return null;
        return { messages: stats?.messages ?? 0, archived: task.archivedAt !== undefined, activeLeafId: stats?.activeLeafId ?? null };
      },
      remove: (botId, threadIds) => { if (threadIds.length) store.deleteTasks(botId, threadIds); },
    },
    memory: {
      read: (botId) => readMemoryFile(botId).text,
      write: (botId, text) => writeMemoryFile(botId, text),
      readTopic: (botId, name) => readMemoryTopic(botId, name),
      writeTopic: (botId, name, text) => writeMemoryTopic(botId, name, text),
      removeTopic: (botId, name) => {
        rmSync(memoryPath(botId, name), { force: true });
        removeMemoryFile(botId, `memory/${name}`);
      },
      readLog: (botId, name) => readMemoryLog(botId, name),
      writeLog: (botId, name, text) => writeMemoryLog(botId, name, text),
      removeLog: (botId, name) => {
        rmSync(memoryPath(botId, MEMORY_LOG_DIR, name), { force: true });
        removeMemoryFile(botId, `memory/${MEMORY_LOG_DIR}/${name}`);
      },
    },
    skills: {
      validName: (name) => isSkillName(name),
      hash: (botId, name) => listSkills(botId).find((skill) => skill.name === name)?.sha256 ?? null,
      files: (botId, name) => {
        const skillMd = readSkillFile(botId, name);
        if (skillMd === null) return null;
        return [{ path: "SKILL.md", content: skillMd }, ...(readSkillReferences(botId, name) ?? [])];
      },
      install: (botId, source, files) => {
        const listing = installSkill(botId, source, files);
        if ("error" in listing) return listing;
        return { name: listing.name, hash: listing.sha256, flagged: listing.warnings.length > 0 };
      },
      enabled: (botId, name) => listSkills(botId).find((skill) => skill.name === name)?.enabled ?? false,
      enable: (botId, name) => { setSkillEnabled(botId, name, true); },
      remove: (botId, name) => { removeSkill(botId, name); },
    },
    tools: {
      servers: () => ({ ...deps.mcp.servers() }),
      nameError: (name) => mcpServerNameError(name),
      check: (name, server) => {
        if (!parseStoredMcpServer(name, server).ok) return "invalid";
        return deps.mcp.refusal(name, server) ? "refused" : null;
      },
      persist: (next) => deps.mcp.persist(next),
    },
    routines: {
      create: (input) => deps.routines.create({ ...input, enabled: false }).id,
      get: (id) => deps.routines.get(id),
      update: (id, patch) => { deps.routines.update(id, patch); },
      remove: (id) => { deps.routines.remove(id); },
    },
  };
}
