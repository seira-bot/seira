import { z } from "zod";
import { TeamSuggestionError, type TeamSuggestionInput } from "../../shared/team-suggestion.ts";
import { hasTeamAuthority, peerAllowed, walledOff } from "../peer-roster.ts"; import { chiefLevel } from "../chief-level.ts";
import type { BotRecord } from "../store.ts";
import { libraryTeamRoles } from "../team-library.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface CatalogInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: string };
  models: unknown;
  capabilities?: { effortLevels?: readonly string[] };
}

const SUGGESTION = z.object({
  department: z.string().min(1).max(120),
  summary: z.string().max(4_000).default(""),
  bots: z.array(z.object({
    name: z.string().min(1).max(200), role: z.string().max(300).default(""),
    job: z.string().min(1).max(4_000), instructions: z.string().max(20_000).optional(),
  })).min(1).max(12),
  group_chats: z.array(z.object({ name: z.string().min(1).max(200), members: z.array(z.string().max(200)).min(2).max(12) })).max(8).optional(),
  first_task: z.string().max(500).optional(),
}).strict();

const NOT_CHIEF = "Only an active Chief may plan team setup";

/** Only dispatch inside the internal capability gate. What a Chief of Staff reads before it changes its team. */
export function createInternalChiefTeamRoutes(deps: {
  /** The calling bot as stored now; read again after every wait. */
  bot(): BotRecord | null;
  requireActive(): void;
  teams(): string[];
  bots(): readonly BotRecord[];
  instances(): Promise<readonly CatalogInstance[]>;
  library?: typeof libraryTeamRoles;
  /** Shows the suggestion card in the calling conversation; nothing is created. */
  suggest?(input: TeamSuggestionInput & { firstTask?: string }): void;
}): RouteHandler {
  const chief = () => {
    const bot = deps.bot();
    return chiefLevel(bot) && !bot!.hidden ? bot : null;
  };
  return async ({ req, res, path, method, json, readBody }) => {
    if (method === "POST" && path === "/api/internal/team-suggestion" && deps.suggest) {
      if (!chief()) return json(res, 403, { error: NOT_CHIEF });
      const parsed = SUGGESTION.safeParse(await readBody(req));
      if (!parsed.success) return json(res, 400, { error: "Give a department name and at least one bot with a name, a role and a job." });
      deps.requireActive();
      if (!chief()) return json(res, 403, { error: NOT_CHIEF });
      const { group_chats: groupChats, first_task: firstTask, ...rest } = parsed.data;
      try {
        deps.suggest({ ...rest, ...(groupChats ? { groupChats } : {}), ...(firstTask ? { firstTask } : {}) });
      } catch (error) {
        if (error instanceof TeamSuggestionError) return json(res, 400, { error: error.message });
        throw error;
      }
      return json(res, 201, { text: "The suggestion is in the chat as a card. Nothing is created: the person edits, creates or skips it. Say in one short line that it is there, then end your turn. Do not call create_bot, propose_team_setup or create_room for this team." });
    }
    if (method !== "GET" || (path !== "/api/internal/team-setup-catalog" && path !== "/api/internal/team-library")) return PASS;
    if (!chief()) return json(res, 403, { error: NOT_CHIEF });
    if (path === "/api/internal/team-library") {
      let teams: Awaited<ReturnType<typeof libraryTeamRoles>>;
      try {
        teams = await (deps.library ?? libraryTeamRoles)();
      } catch {
        return json(res, 502, { error: "The team library can't be reached right now. Build the team from what the person asked." });
      }
      deps.requireActive();
      return chief() ? json(res, 200, { teams }) : json(res, 403, { error: NOT_CHIEF });
    }
    const instances = await deps.instances();
    deps.requireActive();
    const current = chief();
    if (!current) return json(res, 403, { error: NOT_CHIEF });
    return json(res, 200, {
      teams: deps.teams().filter((name) => hasTeamAuthority(current, name)),
      bots: deps.bots().filter((bot) => !bot.hidden && hasTeamAuthority(current, bot.section) && (bot.id === current.id || (peerAllowed(current, bot) && !walledOff(current, bot))))
        .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, section: bot.section ?? "", modelSelection: bot.modelSelection, chiefOfStaff: Boolean(bot.chiefOfStaff) })),
      instances: instances.map((instance) => ({ instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
        state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [] })),
      scope: "Bot model defaults apply to groups and new threads; existing threads retain their models. Requested team setup applies immediately, and the person can undo it. Existing unauthorized teams remain outside this Chief's scope.",
    });
  };
}
