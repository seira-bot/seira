// The neutral shape every source reader emits. Readers stream events; the job engine spools, counts and applies them.

export type ImportSourceKind = "chatgpt" | "claude-ai" | "hermes" | "openclaw" | "claude-code" | "paste";

export interface ImportSource {
  kind: ImportSourceKind;
  version?: string;
  profile?: string;
  /** Stable for the same export or folder, so a second import of it finds the first one's items. */
  fingerprint: string;
}

/** `ref` is the source's own ID, or a path-like key when the source has none. It is unique within one source. */
export interface ImportMemoryItem {
  ref: string;
  text: string;
}

export interface ImportTopic {
  ref: string;
  title: string;
  text: string;
}

export interface ImportDailyNote {
  ref: string;
  /** YYYY-MM-DD */
  date: string;
  text: string;
}

/** `dir` is a copy inside the job's staging folder, never the source folder. */
export interface ImportSkill {
  ref: string;
  name: string;
  dir: string;
}

/** Names of the env or header values the tool needs, never the values. */
export interface ImportTool {
  ref: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  needsKey: string[];
}

/** `schedule`: a 5-field cron line, "every <n><m|h|d>", or an ISO date for a single run.
 * `timeZone`: the IANA zone a cron line runs in; without it, the zone of the computer that runs Seira. */
export interface ImportRoutine {
  ref: string;
  name: string;
  schedule: string;
  prompt: string;
  timeZone?: string;
}

export interface ImportChannel {
  ref: string;
  kind: string;
  name?: string;
}

export interface ImportAgent {
  ref: string;
  name: string;
  persona?: string;
  /** Lines the engine appends to the persona. */
  howToReply: ImportMemoryItem[];
  aboutYou: ImportMemoryItem[];
  memories: ImportMemoryItem[];
  topics: ImportTopic[];
  dailyNotes: ImportDailyNote[];
  skills: ImportSkill[];
  tools: ImportTool[];
  routines: ImportRoutine[];
  channels: ImportChannel[];
}

/** `entry`: a name in the upload's file list. `path`: a copy inside the staging folder. Neither when `missing`. */
export interface ImportAttachment {
  ref: string;
  name: string;
  mime?: string;
  size?: number;
  entry?: string;
  path?: string;
  missing?: true;
}

export type ImportNote = { kind: "file-not-in-export"; name?: string } | { kind: "tool-call"; name: string };

export interface ImportMessage {
  ref: string;
  parentRef: string | null;
  role: "user" | "assistant";
  text: string;
  /** Milliseconds since the epoch, or null when the source has no time. */
  at: number | null;
  attachments?: ImportAttachment[];
  notes?: ImportNote[];
}

/** `messages` holds every node. The active branch is the chain from `activeLeafRef` up through `parentRef`. */
export interface ImportConversation {
  ref: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  activeLeafRef: string | null;
  messages: ImportMessage[];
}

export type ImportItemKind = "conversation" | "message" | "attachment" | "memory" | "topic" | "skill" | "tool" | "routine" | "channel" | "file";

export type ImportLeftoverReason = "unreadable" | "too-large" | "too-deep" | "unsupported" | "locked" | "not-in-export";

export interface ImportLeftover {
  ref: string;
  kind: ImportItemKind;
  name?: string;
  reason: ImportLeftoverReason;
}

export type ImportEvent =
  | { type: "source"; source: ImportSource }
  | { type: "agent"; agent: ImportAgent }
  | { type: "conversation"; agentRef: string; conversation: ImportConversation }
  | { type: "leftover"; leftover: ImportLeftover }
  | { type: "progress"; done: number; total: number | null; unit: "bytes" | "items" };

export function emptyAgent(ref: string, name: string): ImportAgent {
  return { ref, name, howToReply: [], aboutYou: [], memories: [], topics: [], dailyNotes: [], skills: [], tools: [], routines: [], channels: [] };
}
