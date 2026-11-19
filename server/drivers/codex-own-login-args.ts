import { codexSelectedProviderArgs } from "./codex-catalog.ts";
import { codexTurnConfigArgs } from "./codex-guest.ts";
import { codexToolSurfaceArgs } from "./codex-tool-surface.ts";

/** App-server arguments of Codex on its own ChatGPT sign-in, for a chat turn and for a Live call alike.
 * `inBetween` sits after the tool limits and before the bot's switched-off skills. */
export function codexOwnLoginArgs(
  env: Record<string, string | undefined>,
  model: string | null | undefined,
  turnConfigArgs: string[],
  inBetween: string[] = [],
): string[] {
  return [...codexSelectedProviderArgs(env, model), ...codexToolSurfaceArgs(), ...inBetween, ...turnConfigArgs];
}

/** The arguments of a Live call: the tool limits, skill switches and model of the bot's chat turns. */
export function codexLiveAppServerArgs(env: Record<string, string | undefined>, input: { botId: string; model: string | null }): string[] {
  return codexOwnLoginArgs(env, input.model, codexTurnConfigArgs({ botId: input.botId }, env));
}
