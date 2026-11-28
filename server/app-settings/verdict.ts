// Who may change the app's settings from a turn: judged on this turn's own request line, not on the phone-access test.
// A thread whose history someone else wrote into, or a server several people sign in to, still gets the change, but only
// through a card the owner taps.

/** Why a turn may not change a setting at all; written to the decision log, never shown. */
export type SettingsRefusalCode = "shared" | "guest" | "automation" | "unproven" | "not-owner";

export type SettingsVerdict =
  | { kind: "clean" }
  | { kind: "confirm"; why: "history" | "shared" }
  | { kind: "refused"; code: SettingsRefusalCode };

/** Reads the owner test's code (null: the owner's own, clean conversation) as a settings verdict. `several`: the server
 * lets several people in, so even an admin's clean request waits for a tap. */
export function settingsVerdict(code: string | null, several: boolean): SettingsVerdict {
  if (code === null) return several ? { kind: "confirm", why: "shared" } : { kind: "clean" };
  if (code === "someone-else" || code === "memory-changed") return { kind: "confirm", why: "history" };
  return { kind: "refused", code: code === "unproven" ? "unproven" : "not-owner" };
}
