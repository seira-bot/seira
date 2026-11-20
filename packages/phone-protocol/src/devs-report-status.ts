// A @devs bug report's status, as the Seira team last said it (server/host/devs-reports.ts asks about it hourly and at each
// start). The server writes it on the person's message that sent the report, and on the one line that tells them its fix
// runs here; clients say it in their own words (src/components/BugReportNote.tsx), so it follows the app's language.

export interface BugReportStatus {
  /** The Seira team's id for the report (the "Sent to the Seira team (report …)" line names it). */
  id: string;
  /** `received`: we have it and are looking; `fixed`: the team fixed it. */
  status: "received" | "fixed";
  /** The release the fix ships in, once the team knows it. */
  fixedIn?: string;
  /** This app runs that release (or a later one): the fix is here. */
  running?: true;
}

/** A bug report a bot wrote and the person has not sent yet, or what became of it once they sent it. Nothing in it is the
 * report itself: the person who may read the draft asks the server for it by `id`. */
export interface BugOffer {
  id: string;
  /** The person who may see and send it: their reaction key, "user" where one person uses the workspace. */
  for: string;
  /** `error`: Seira offered it after its own error. `devs`: the person asked for it with @devs. */
  from: "error" | "devs";
  /** The bot that wrote it. */
  by?: string;
  /** `offer`: waiting for the person. `saved`: sent while offline, goes on its own. `sent`: a new issue. `joined`: added to
   * an open issue about the same error. `opened`: no relay here, so the person opened a prefilled issue form. */
  state: "offer" | "saved" | "sent" | "joined" | "opened";
  /** The public issue's number, when the relay said it. */
  issue?: number;
}

export interface BugReportField {
  /** On a person's message that tagged @devs: its report's status. On the one notice that tells them the fix runs here: the same, `running` set. */
  bugReport?: BugReportStatus;
  /** On the line a bug report draft hangs under: a failed turn, the turn's reply, or the person's @devs message. */
  bugOffer?: BugOffer;
}

const VERSION = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether this app's version (`running`) is the release `fixedIn` or a later one. Anything that doesn't read as a version is
 * never at least it, and neither is a pre-release of that very release: the fix is said to be here only when it surely is. */
export function versionAtLeast(running: string, fixedIn: string): boolean {
  const have = VERSION.exec(running.trim()), want = VERSION.exec(fixedIn.trim());
  if (!have || !want || want[4] !== undefined) return false;
  for (const part of [1, 2, 3]) {
    const a = Number(have[part]), b = Number(want[part]);
    if (a !== b) return a > b;
  }
  return have[4] === undefined;
}
