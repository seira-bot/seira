// Plain ESM so Electron's main process and the server enforce exactly the same lease protocol.
import { acquireDataDirLeaseForProcess, DataDirLeaseError, describeDataDirLease } from "../electron/data-dir-lease.mjs";
import type { DataDirLease } from "../electron/data-dir-lease.mjs";

export {
  acquireDataDirLease,
  acquireDataDirLeaseForProcess,
  clearRecordsFromEarlierRunOfThisContainer,
  clearRecordsFromOtherMachines,
  DataDirLeaseError,
  describeDataDirLease,
} from "../electron/data-dir-lease.mjs";

export type {
  DataDirLease,
  DataDirLeaseHolder,
  DelegatedDataDirLease,
  OwnedDataDirLease,
} from "../electron/data-dir-lease.mjs";

/** The server's release for every exit path (process exit, graceful close, crash guard): the first call releases, later
 * calls do nothing, and a failure is logged, never thrown, so exiting is never stopped by the lease. */
export function releaseOnceAtExit(lease: Pick<DataDirLease, "release">): () => void {
  let attempted = false;
  return () => {
    if (attempted) return;
    attempted = true;
    try {
      lease.release();
    } catch (error) {
      console.error(`[data-directory] lease release failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

/** What a person reads when a live Seira already holds the data folder (it may still be starting); null when none does. */
export function runningServerLine(dataDir: string, describe: typeof describeDataDirLease = describeDataDirLease): string | null {
  try {
    return describe(dataDir).state === "alive"
      ? "Seira is already running with this data. It may still be starting. Wait a minute, or stop it, then start again."
      : null;
  } catch {
    return null;
  }
}

/** The server's lease at start: a refusal is one plain line and exit code 1, never a stack trace. */
export function acquireDataDirLeaseOrExit(
  dataDir: string,
  environment: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = (code) => process.exit(code),
): DataDirLease {
  try {
    return acquireDataDirLeaseForProcess(dataDir, environment);
  } catch (error) {
    if (!(error instanceof DataDirLeaseError)) throw error;
    console.error(runningServerLine(dataDir) ?? error.message);
    return exit(1);
  }
}
