import type { WireBot } from "./wire";
import type { RoutineInput } from "./routines";
import type { ToolScope } from "./tool-scope";
import type { StartsTodos } from "./todo";

/** Data shared by the default template and an individual creation draft. */
export type BotDefaultsProfile = Partial<Pick<WireBot,
  "name" | "title" | "description" | "soul" | "notifications" | "avatarUrl" | "avatarCrop" |
  "mascotBody" | "mascotFaceColor" | "mascotAccessories" | "color" | "voice" | "speakReplies" | "section" | "modelSelection" |
  "cloudBackend" | "autoStartVps" | "approvalMode" | "alwaysAllow" | "chiefOfStaff" |
  "managedSections" | "composio" | "browser" | "voiceNotes"
>> & {
  mascotExpression?: string | null;
  computer?: WireBot["computer"] | null;
  cwd?: string | null;
  browserProfile?: string | null;
  mcpServers?: string[] | null;
  toolScope?: ToolScope | null;
  parkDirectMessages?: boolean;
  startsTodos?: StartsTodos;
  helperModel?: boolean;
  /** null or absent: follows the installation's `tts.everyReply`. */
  voiceNoteEveryReply?: boolean | null;
};

export type BotRoutineTemplate = Omit<RoutineInput, "botId" | "target" | "groupId" | "resultsThreadId">;
export interface BotSkillTemplate {
  name: string;
  description: string;
  source: string;
  text: string;
  enabled: boolean;
  warnings: string[];
}
export interface NewBotDefaults {
  profile: BotDefaultsProfile;
  memory: Record<string, string>;
  skills: BotSkillTemplate[];
  routines: BotRoutineTemplate[];
}
