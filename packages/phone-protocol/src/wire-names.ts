/**
 * The names that cross the wire between a computer, a server and a phone app. Each has the value that
 * released phone apps know (`legacy`) and the Seira value (`seira`). `PHONE_WIRE_SEND` picks the value
 * that this code sends, one choice for each name. Code that receives a name accepts every value of
 * `acceptedWireNames`.
 *
 * `companion/src/wire-names.ts` and `electron/phone-wire-names.mjs` hold copies of this table, because
 * those builds cannot import from this package. A test fails when a copy differs from this file.
 */
export const PHONE_WIRE_NAMES = {
  pairingCredentialPrefix: { legacy: "omb_pair_", seira: "seira_pair_" },
  linkScheme: { legacy: "openmausbot", seira: "seira" },
  environmentPath: { legacy: "/.well-known/openmausbot/environment", seira: "/.well-known/seira/environment" },
  healthApp: { legacy: "openmausbot", seira: "seira" },
  pushCollapsePrefix: { legacy: "openmaus", seira: "seira" },
  mdnsServiceType: { legacy: "_openmausbot._tcp", seira: "_seira._tcp" },
  mdnsHostPrefix: { legacy: "openmausbot", seira: "seira" },
  sessionTokenPrefix: { legacy: "omb_sess_", seira: "seira_sess_" },
} as const;

export type PhoneWireName = keyof typeof PHONE_WIRE_NAMES;

export const PHONE_WIRE_SEND: Readonly<Record<PhoneWireName, "legacy" | "seira">> = {
  pairingCredentialPrefix: "seira",
  linkScheme: "seira",
  // Servers of v0.1.181 and earlier answer only the old path. The desktop asks servers of every version.
  environmentPath: "legacy",
  healthApp: "seira",
  // Phone apps 1.0.3 give their own alert the old id. A push and that alert must share one id.
  pushCollapsePrefix: "legacy",
  mdnsServiceType: "seira",
  mdnsHostPrefix: "seira",
  sessionTokenPrefix: "seira",
};

export function sentWireName(name: PhoneWireName): string {
  return PHONE_WIRE_NAMES[name][PHONE_WIRE_SEND[name]];
}

export function acceptedWireNames(name: PhoneWireName): readonly [string, string] {
  const { legacy, seira } = PHONE_WIRE_NAMES[name];
  return [legacy, seira];
}

export function acceptsWireName(name: PhoneWireName, value: string): boolean {
  return acceptedWireNames(name).includes(value);
}
