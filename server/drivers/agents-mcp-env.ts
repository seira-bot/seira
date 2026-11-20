import { TOOL_BRIDGE_ENV } from "./agents-bridge.ts";
import { TOOL_LIMIT_ENV } from "../tool-count-limit.ts";
import { DEFER_TOOLS_ENV } from "./agents-claude-defer.ts";

/** The settings the harness gives the agents MCP server, and the only ones a request may carry over HTTP. */
export const AGENTS_MCP_ENV = ["SEIRA_BOT_ID", "SEIRA_THREAD_ID", "SEIRA_EXTERNAL_RUNTIME", "SEIRA_CHIEF_OF_STAFF",
  "SEIRA_SKILL_AUTHORING_ENABLED", "SEIRA_MEMORY_ENABLED", "SEIRA_SHARED_COMPUTERS_ENABLED", "SEIRA_CLOUD_HOME", "SEIRA_VOICE_NOTES",
  "SEIRA_X_RESEARCH", "SEIRA_RESEARCH", "SEIRA_TEAM_PEOPLE", "SEIRA_SEIRA", "SEIRA_COMPUTER_SELECTION", "SEIRA_ROOM", "SEIRA_IMAGE_GENERATION", "SEIRA_MEETINGS", "SEIRA_APP_HOSTING", "SEIRA_TOOLS_OFF", "SEIRA_LOCAL_VM", TOOL_BRIDGE_ENV, TOOL_LIMIT_ENV,
  // Claude's deferred catalog: the URL form carries it as the stdio proxy's environment does.
  DEFER_TOOLS_ENV] as const;
