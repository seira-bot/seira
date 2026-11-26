// The old server's side of moving a server out. A person who made a backup export here may hand a new server one sign-in
// that reads that export and nothing else, so the new server can pull the file itself. The sign-in ends when the export
// goes, never renews, and `moveOutRefusal` keeps it to the one download route of its own export.
import type { SessionRecord } from "./sessions.ts";

const DOWNLOAD = /^\/api\/workspace-backup\/download\/([\w-]+)$/u;

/** Why a move-out sign-in may not make this request; null when it may. */
export function moveOutRefusal(session: Pick<SessionRecord, "moveOut">, method: string, path: string): string | null {
  const exportId = session.moveOut;
  if (!exportId) return null;
  const named = DOWNLOAD.exec(path)?.[1];
  return method === "GET" && named === exportId ? null : "This sign-in only reads one backup file.";
}
