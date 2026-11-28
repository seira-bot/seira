import { PublicError } from "./public-error.ts";
/** A backup owns one quiet workspace. Never interrupt a turn to obtain it. */
export class WorkspaceBackupMaintenance {
  active = false;
  pendingRestore = false;
  private requests = 0;

  assertAvailable(): void {
    if (this.active) throw new PublicError(this.pendingRestore
      ? "A workspace restore is ready. Fully quit and reopen Seira (or restart the hosted server) to finish."
      : "A workspace backup is in progress. Try again when it finishes.", 503);
  }

  request(): () => void {
    this.assertAvailable();
    this.requests++;
    return () => { this.requests--; };
  }

  async run<T>(work: () => Promise<T>, hooks: { idle: () => boolean; pause: () => void; resume: () => void; flush: () => Promise<void> }, keepLocked = false): Promise<T> {
    this.assertAvailable();
    if (this.requests || !hooks.idle()) throw new PublicError("Wait for bot turns, approvals, sign-ins, and computer actions to finish before backing up or restoring.", 409);
    this.active = true;
    let committed = false;
    try {
      hooks.pause();
      await hooks.flush();
      if (!hooks.idle()) throw new PublicError("The workspace is still finishing background work. Try again shortly.", 409);
      const result = await work();
      committed = keepLocked;
      this.pendingRestore = keepLocked;
      return result;
    } finally {
      if (!committed) {
        this.active = false;
        hooks.resume();
      }
    }
  }
}
