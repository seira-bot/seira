// Whether this machine can run the bot box, decided once at boot: every bot on a Cloud home or with SEIRA_BOT_BOX=1,
// only the bots limited to chosen folders on another Linux host, and never without a working unprivileged bubblewrap (a
// kernel that refuses user namespaces, or an image without bwrap, reports `off` with its reason rather than running
// turns unboxed by surprise: the report says so, and the Admin shows it).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { inFlatpak } from "../flatpak-host.ts";

export type BoxKind = "bwrap" | "gvisor" | "user" | "off";

/** `all`: every bot spawn. `limited`: only the spawns of a bot with "Only chosen folders" on. */
export type BoxScope = "all" | "limited";

export interface BoxDetection {
  box: BoxKind;
  /** Why the box is off, as a fixed code; never free text from a tool. */
  reason: "switched-off" | "not-linux" | "no-bwrap" | "userns-refused" | "not-cloud" | "flatpak" | null;
  /** The found tools, when the box is on. */
  tools: { bwrap: string; socat: string | null } | null;
  /** Which spawns the box takes when it is on; `all` when left out. */
  scope?: BoxScope;
}

export interface DetectInput {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Runs bwrap once with a harmless command; true when the box works. */
  probe?: (bwrap: string) => boolean;
  which?: (name: string) => string | null;
}

/** A Cloud home (`home`, or the Team Cloud role `team`) boxes turns unless told not to. */
export function cloudRole(env: Record<string, string | undefined>): boolean {
  return env.SEIRA_CLOUD_ROLE === "home" || env.SEIRA_CLOUD_ROLE === "team";
}

/** `SEIRA_BOT_BOX`: unset (Cloud homes every bot, other Linux hosts the limited bots), 0/off, 1/on/bwrap. */
export function boxWanted(env: Record<string, string | undefined>): "on" | "off" | "default" {
  const raw = (env.SEIRA_BOT_BOX ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
  if (raw === "1" || raw === "on" || raw === "bwrap" || raw === "true" || raw === "yes") return "on";
  return "default";
}

export function whichOnPath(name: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const dir of (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** bubblewrap with the namespaces the box uses, running /bin/true: the one thing Fly's kernel must allow. */
export function probeBwrap(bwrap: string): boolean {
  try {
    const result = spawnSync(bwrap, [
      "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "/bin/true",
    ], { timeout: 5_000, stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function detectBox(input: DetectInput): BoxDetection {
  const wanted = boxWanted(input.env);
  if (wanted === "off") return { box: "off", reason: "switched-off", tools: null };
  const scope: BoxScope = wanted === "on" || cloudRole(input.env) ? "all" : "limited";
  const platform = input.platform ?? process.platform;
  if (scope === "limited" && platform !== "linux") return { box: "off", reason: "not-cloud", tools: null };
  if (platform !== "linux") return { box: "off", reason: "not-linux", tools: null };
  // Flatpak's own sandbox refuses the nested user namespace bubblewrap needs.
  if (scope === "limited" && inFlatpak(input.env)) return { box: "off", reason: "flatpak", tools: null };
  const which = input.which ?? ((name) => whichOnPath(name, input.env));
  const bwrap = which("bwrap");
  if (!bwrap) return { box: "off", reason: "no-bwrap", tools: null };
  if (!(input.probe ?? probeBwrap)(bwrap)) return { box: "off", reason: "userns-refused", tools: null };
  return { box: "bwrap", reason: null, tools: { bwrap, socat: which("socat") }, scope };
}
