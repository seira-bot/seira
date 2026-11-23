// Security: while the bot box is on, a boxed bot can write the server's HOME (plan.ts binds it read-write). The server's
// own processes run outside the box, so they must never look a program up in a folder there, nor start one from there:
// a program a bot left in ~/.local/bin would otherwise run outside the box at the next engine status read. The data
// folder is the exception: the box replaces it with an empty one, and the engines the app installs there are read-only.
// With only the limited bots boxed, HOME stays trusted (the person and the unboxed bots write it anyway), but a folder
// a limited box writes never is: its sign-in folders in HOME (except the program folders it has read-only there), the
// bots' folders and the folders its bots may change.
import { realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";

import { linksOnTheWay, under } from "./plan.ts";

let distrusted: { homes: readonly string[]; kept: readonly string[]; bots: readonly string[] } | null = null;
let limitedBox: { folders: readonly string[]; chosen: () => readonly string[]; kept: () => readonly string[] } | null = null;

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
 * Read at each check, so a change counts at once: `chosen`, the other folders its bots may change; `kept`, the folders
 * inside `folders` that every box has had read-only. */
export function distrustLimitedBoxFolders(folders: readonly string[] | null, chosen: () => readonly string[] = () => [], kept: () => readonly string[] = () => []): void {
  limitedBox = folders ? { folders: folders.flatMap(bothNames), chosen, kept } : null;
}

/** Whether HOME is untrusted: only while every bot spawn is boxed. */
export function homeProgramsDistrusted(): boolean {
  return distrusted !== null;
}

/** Whether the server distrusts any folder now: HOME, or the folders a limited box writes. */
export function programsDistrusted(): boolean {
  return distrusted !== null || limitedBox !== null;
}

interface BoxWrites { always: readonly string[]; chosen: readonly string[]; kept: readonly string[] }

function limitedBoxWrites(): BoxWrites | null {
  if (!limitedBox) return null;
  const absolute = (list: () => readonly string[]): string[] => {
    try { return list().filter((dir) => isAbsolute(dir)).flatMap(bothNames); } catch { return []; }
  };
  // Security: a list that fails to load counts as empty, which leaves every folder the box always writes distrusted.
  return { always: limitedBox.folders, chosen: absolute(limitedBox.chosen), kept: absolute(limitedBox.kept) };
}

function mayRunFrom(path: string, boxWrites: BoxWrites | null): boolean {
  const home = distrusted;
  if (!home && !boxWrites) return true;
  const steps = linksOnTheWay(path);
  if (!steps) return false;
  const named = [resolve(path), steps[steps.length - 1]];
  const links = steps.slice(0, -1);
  const inside = (name: string, dirs: readonly string[]) => dirs.some((dir) => under(name, dir));
  // Security: the path as given, where it ends and each link on the way, each on its own, so that a link a bot can change
  // never borrows the trust of the folder it points to. A link changes where the folder that holds it is written.
  const written = (dirs: readonly string[], kept: readonly string[]) =>
    named.some((name) => inside(name, dirs) && !inside(name, kept)) || links.some((link) => inside(dirname(link), dirs) && !inside(link, kept));
  if (boxWrites && (written(boxWrites.chosen, []) || written(boxWrites.always, boxWrites.kept))) return false;
  return !home || !(written(home.bots, []) || written(home.homes, home.kept));
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
