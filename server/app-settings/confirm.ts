import type { ServerLineKey } from "../server-lines.ts";

/** What follows from a change that waits for the owner's tap: a code whose words come from the language packs, with the
 * names the line fills in. */
export const CONSEQUENCES = ["keyTo", "autonomyUp", "dataTo", "deletesLogs", "standingRule", "botRule", "newBots", "thisComputer", "lending", "browserLan", "browserProxy", "wayIn", "usageData", "emailOut"] as const;
export type ConsequenceCode = (typeof CONSEQUENCES)[number];
export interface Consequence {
  code: ConsequenceCode;
  params?: Record<string, string>;
}

export const consequenceKey = (code: ConsequenceCode): ServerLineKey => `server.appSettings.confirm.${code}`;

/** The host an address sends to, as the card names it; the address itself when it is no URL. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}
