// Windows Defender Firewall drops inbound connections on a network Windows
// calls Public (Windows 11 calls a newly joined Wi-Fi Public) unless a rule
// allows the program, and the per-user installer adds none. This only finds
// the Public network, so the pairing panel can say what to change.
import { execFile } from "node:child_process";

import { backgroundAnswer } from "./background-answer.ts";

/** One line per connected network: "<InterfaceAlias>\t<NetworkCategory>". The
 * alias is the adapter name `os.networkInterfaces()` reports. UTF-8 output so a
 * localized alias survives the pipe; no quote characters, since the script
 * travels as one argv entry. */
const SCRIPT =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "Get-NetConnectionProfile | ForEach-Object { $_.InterfaceAlias + [char]9 + $_.NetworkCategory }";

/** Anything unreadable is not Public: this only adds a hint, so a wrong "no"
 * costs nothing and a wrong "yes" would mislead. */
export function publicNetworkAliases(output: string): Set<string> {
  const aliases = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.lastIndexOf("\t");
    if (tab > 0 && line.slice(tab + 1).trim() === "Public") aliases.add(line.slice(0, tab));
  }
  return aliases;
}

const getNetConnectionProfile = (): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      { timeout: 5_000, killSignal: "SIGKILL", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** How old an answer may be before the next read asks Windows again. Someone
 * who switches the network to Private sees the hint go within this long. */
const MAX_AGE_MS = 15_000;

/** Never waits (see `backgroundAnswer`); each fresh answer is a PowerShell
 * process. Off Windows the set stays empty. */
export function createPublicNetworkCheck({
  platform = process.platform,
  run = getNetConnectionProfile,
  now = Date.now,
  maxAgeMs = MAX_AGE_MS,
}: {
  platform?: NodeJS.Platform;
  run?: () => Promise<string>;
  now?: () => number;
  maxAgeMs?: number;
} = {}): () => ReadonlySet<string> {
  const none: ReadonlySet<string> = new Set();
  if (platform !== "win32") return () => none;
  const answer = backgroundAnswer(async () => publicNetworkAliases(await run()), none, { now, maxAgeMs });
  return () => answer(undefined);
}

export const publicNetworks = createPublicNetworkCheck();
