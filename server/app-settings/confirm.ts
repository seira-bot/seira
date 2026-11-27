import type { ServerLineKey } from "../server-lines.ts";

/** What follows from a change that waits for the owner's tap: a code whose words come from the language packs, with the
 * names the line fills in. */
const CONSEQUENCE_KEYS = {
  keyTo: "server.appSettings.confirm.keyTo",
  autonomyUp: "server.appSettings.confirm.autonomyUp",
  dataTo: "server.appSettings.confirm.dataTo",
  deletesLogs: "server.appSettings.confirm.deletesLogs",
  standingRule: "server.appSettings.confirm.standingRule",
  botRule: "server.appSettings.confirm.botRule",
  newBots: "server.appSettings.confirm.newBots",
  thisComputer: "server.appSettings.confirm.thisComputer",
  lending: "server.appSettings.confirm.lending",
  browserLan: "server.appSettings.confirm.browserLan",
  browserProxy: "server.appSettings.confirm.browserProxy",
  wayIn: "server.appSettings.confirm.wayIn",
  usageData: "server.appSettings.confirm.usageData",
  emailOut: "server.appSettings.confirm.emailOut",
  browserOn: "server.appSettings.confirm.browserOn",
  browserOnAll: "server.appSettings.confirm.browserOnAll",
  appsOn: "server.appSettings.confirm.appsOn",
  toolsOn: "server.appSettings.confirm.toolsOn",
  ownChrome: "server.appSettings.confirm.ownChrome",
} as const satisfies Record<string, ServerLineKey>;
export type ConsequenceCode = keyof typeof CONSEQUENCE_KEYS;
export const CONSEQUENCES = Object.keys(CONSEQUENCE_KEYS) as ConsequenceCode[];
export interface Consequence {
  code: ConsequenceCode;
  params?: Record<string, string>;
}

export const consequenceKey = (code: ConsequenceCode): ServerLineKey => CONSEQUENCE_KEYS[code];

/** The host an address sends to, as the card names it; the address itself when it is no URL. */
export function hostOf(address: string): string {
  try {
    return new URL(address).host || address;
  } catch {
    return address;
  }
}
