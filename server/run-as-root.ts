import { userError, userErrorThrown } from "./user-errors.ts";

export function runsAsRoot(euid: number | undefined = process.geteuid?.()): boolean {
  return euid === 0;
}

export function startsWithAsk(hostedWorkspace: boolean, euid?: number): boolean {
  return hostedWorkspace || runsAsRoot(euid);
}

/** Claude Code refuses --dangerously-skip-permissions and bypassPermissions as root or with sudo (2.x). */
export function claudeRootRefusal(stderr: string): boolean {
  return /\broot\b[^\n]*\bsudo\b|\bsudo\b[^\n]*\broot\b/i.test(stderr);
}

export const ROOT_FULL_ACCESS_TEXT = userError("serverError.engine.rootFullAccess").error;

export function refuseRootFullAccess<T extends string | undefined>(permissionMode: T, euid?: number): T {
  if (permissionMode === "bypassPermissions" && runsAsRoot(euid)) throw userErrorThrown("serverError.engine.rootFullAccess");
  return permissionMode;
}
