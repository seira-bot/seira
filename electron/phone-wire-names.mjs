/**
 * The names that cross the wire between a computer, a server and a phone app. Each has the value that
 * released phone apps know (`legacy`) and the Seira value (`seira`). `PHONE_WIRE_SEND` picks the one that
 * this code sends. Code that receives a name accepts every value of `acceptedWireNames`.
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
};

export const PHONE_WIRE_SEND = "legacy";

export function sentWireName(name) {
  return PHONE_WIRE_NAMES[name][PHONE_WIRE_SEND];
}

export function acceptedWireNames(name) {
  const { legacy, seira } = PHONE_WIRE_NAMES[name];
  return [legacy, seira];
}

export function acceptsWireName(name, value) {
  return acceptedWireNames(name).includes(value);
}
