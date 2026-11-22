// Security: while the bot box is on, a boxed bot can write the server's HOME (plan.ts binds it read-write). The server's
// own processes run outside the box, so they must never look a program up in a folder there, nor start one from there:
// a program a bot left in ~/.local/bin would otherwise run outside the box at the next engine status read. The data
// folder is the exception: the box replaces it with an empty one, and the engines the app installs there are read-only.
// With only the limited bots boxed, HOME stays trusted (the person and the unboxed bots write it anyway), but a folder
// a limited box writes never is: its sign-in folders in HOME, the bots' folders and the folders its bots may change.
import { realpathSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

import { under } from "./plan.ts";

let distrusted: { homes: readonly string[]; kept: readonly string[]; bots: readonly string[] } | null = null;
let limitedBox: { folders: readonly string[]; chosen: () => readonly string[] } | null = null;

/** A folder as given and as the filesystem names it, so a link's target is judged by where it really is. */
function bothNames(dir: string): string[] {
  const given = resolve(dir);
  try { return [...new Set([given, realpathSync(given)])]; } catch { return [given]; }
}

/** Called with the server's HOME when the box goes on, and with null when it stops. `kept`: folders under HOME no bot
 * can write (the data folder); `bots`: the folders in it bots do write (their workspaces, a Team Cloud's engine homes). */
export function distrustHomePrograms(home: string | null, kept: readonly string[] = [], bots: readonly string[] = []): void {
  distrusted = home ? { homes: bothNames(home), kept: kept.flatMap(bothNames), bots: bots.flatMap(bothNames) } : null;
}

/** Called with the folders a box of only the limited bots always writes when it goes on, and with null when it stops.
 * `chosen` is read at each check: the other folders its bots may change, so a new one counts at once. */
export function distrustLimitedBoxFolders(folders: readonly string[] | null, chosen: () => readonly string[] = () => []): void {
  limitedBox = folders ? { folders: folders.flatMap(bothNames), chosen } : null;
}

/** Whether HOME is untrusted: only while every bot spawn is boxed. */
export function homeProgramsDistrusted(): boolean {
  return distrusted !== null;
}

/** Whether the server distrusts any folder now: HOME, or the folders a limited box writes. */
export function programsDistrusted(): boolean {
  return distrusted !== null || limitedBox !== null;
}

function limitedBoxWrites(): string[] | null {
  if (!limitedBox) return null;
  let chosen: readonly string[] = [];
  // Security: a list that fails to load still leaves the folders the box always writes distrusted.
  try { chosen = limitedBox.chosen(); } catch {}
  return [...limitedBox.folders, ...chosen.filter((dir) => isAbsolute(dir)).flatMap(bothNames)];
}

function mayRunFrom(path: string, boxWrites: readonly string[] | null): boolean {
  if (!distrusted && !boxWrites) return true;
  if (!isAbsolute(path)) return false;
  const full = resolve(path);
  if (boxWrites && bothNames(full).some((name) => boxWrites.some((dir) => under(name, dir)))) return false;
  if (!distrusted) return true;
  if (distrusted.bots.some((dir) => under(full, dir))) return false;
  return !distrusted.homes.some((home) => under(full, home)) || distrusted.kept.some((dir) => under(full, dir));
}

/** Whether the server may run a program from `path` (a folder or a file) outside the box. */
export function serverMayRunFrom(path: string): boolean {
  return mayRunFrom(path, limitedBoxWrites());
}

/** `path` without the folders the server may not run programs from. */
export function serverPath(path: string | undefined): string {
  const boxWrites = limitedBoxWrites();
  if (!distrusted && !boxWrites) return path ?? "";
  return (path ?? "").split(delimiter).filter((dir) => dir && mayRunFrom(dir, boxWrites)).join(delimiter);
}
