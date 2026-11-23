import environments from "./environments.cjs";
import { handSaved } from "./own-home-main.mjs";

/**
 * A server saved by hand takes a new name, in this app's own saved places only (environments.cjs withServerName).
 * `rename(id, name)` answers `{ outcome }`: saved, name, taken, gone, or failed when the file could not be written.
 * `persist(state)` writes the state and refreshes the title, the menus and the rail. `taken()`: the names of the places that
 * are not saved entries (This computer, workspaces of its own). The channel `environments:rename` runs behind `guard`,
 * for this computer's own page (Settings → Servers); the rail's page goes through `workspaces:rename` (cloud-rail.mjs).
 */
export function installServerRename({ ipcMain, guard, state, persist, taken }) {
  const rename = (id, name) => {
    const current = state();
    const entry = current.environments.find((candidate) => candidate.id === id);
    if (!entry || !handSaved(entry)) return { outcome: "gone" };
    const done = environments.withServerName(current, id, name, taken());
    if (done.state !== current) {
      try { persist(done.state); } catch { return { outcome: "failed" }; }
    }
    return { outcome: done.outcome };
  };
  ipcMain.handle("environments:rename", guard("environments:rename", (_event, id, name) => rename(typeof id === "string" ? id : "", typeof name === "string" ? name : "")));
  return rename;
}
