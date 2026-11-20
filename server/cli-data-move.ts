import { join, resolve } from "node:path";

import { migrateLegacyData } from "../electron/legacy-migrate.mjs";
import { dataHome } from "./data-dir.ts";

/** Moves an earlier version's data folder before the command line writes its first file there. `--data-dir` wins over SEIRA_DATA_DIR, as in parseArgs. */
export function migrateBeforeFirstWrite(argv: string[], env: NodeJS.ProcessEnv = process.env, home = dataHome()): void {
  const at = argv.indexOf("--data-dir");
  const dataDir = at >= 0 && argv[at + 1] ? resolve(argv[at + 1]!) : env.SEIRA_DATA_DIR || join(home, ".seira");
  migrateLegacyData({ home, dataDir, env: { ...env, SEIRA_DATA_DIR: dataDir } });
}
