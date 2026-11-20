import { DEFER_TOOLS_ENV, claudeUpFrontBytes } from "../../server/drivers/agents-claude-defer.ts";
import { agentsToolList } from "../../server/drivers/agents-mcp.ts";

const BASE = { SEIRA_BOT_ID: "bot-context", SEIRA_CHIEF_OF_STAFF: "1", SEIRA_COMPUTER_SELECTION: "1" };
/** A Chief's direct chat with nothing extra, and with every switch the catalog has. */
export const CONTEXT_PROFILES: Record<string, Record<string, string>> = {
  default: BASE,
  fullest: {
    ...BASE, SEIRA_SKILL_AUTHORING_ENABLED: "1", SEIRA_SHARED_COMPUTERS_ENABLED: "1", SEIRA_VOICE_NOTES: "1", SEIRA_X_RESEARCH: "1", SEIRA_RESEARCH: "1",
    SEIRA_TEAM_PEOPLE: "1", SEIRA_IMAGE_GENERATION: "1", SEIRA_APP_HOSTING: "1",
  },
};

/** Bytes of the agents server a Claude turn sends before any search, every tool whole against all but a few deferred. */
export function contextSizes() {
  return Object.entries(CONTEXT_PROFILES).map(([profile, env]) => {
    const whole = agentsToolList(env).listed;
    const deferred = agentsToolList({ ...env, [DEFER_TOOLS_ENV]: "1" }).listed;
    return {
      profile,
      tools: whole.length,
      loaded: deferred.filter((tool) => !("_meta" in tool)).map((tool) => tool.name),
      before: claudeUpFrontBytes(whole),
      after: claudeUpFrontBytes(deferred),
    };
  });
}
