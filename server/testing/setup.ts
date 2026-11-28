// Every test file gets a throwaway home, so DATA_DIR (~/.seira) never touches the real one;
// os.homedir() reads HOME / USERPROFILE at call time, and this runs before server/config.ts is imported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { VPS_SSH_DIR, vpsSshSharedControlDirectory } from "../vps-ssh-path.ts";
import { removeTempDir } from "./cleanup.ts";
import { TEST_HOME_PREFIX, useTestTmp } from "./test-tmp.ts";

// Everything the test and the code under test put in tmpdir() lands in one folder that afterAll deletes.
// The home is made after the move, so it sits in that folder and keeps its place under tmpdir().
const scratch = useTestTmp();
const home = mkdtempSync(join(tmpdir(), TEST_HOME_PREFIX));
process.env.HOME = home;
process.env.USERPROFILE = home;
// A provider that answers 5xx retries with backoff: no test should wait out real seconds.
process.env.FAKE_OPENAI_COMPAT_RETRY_SCALE ??= "0.001";
// SEIRA_DATA_DIR must never escape the throwaway home the suite deletes.
delete process.env.SEIRA_DATA_DIR;
// An ambient OMB_ name would be adopted as its SEIRA_ twin when config.ts loads, past the line above.
for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith("OMB_")) delete process.env[key];
// The model manifest comes from the bundled copy in tests; refreshing it would be a network call in every server boot.
process.env.SEIRA_DISABLE_MODEL_MANIFEST_FETCH = "1";
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// A ChatGPT-plan turn links the person's Codex home ($CODEX_HOME or ~/.codex) into its own: keep it in the throwaway home.
delete process.env.CODEX_HOME;
// No server in a test downloads the project's announcement cards; its tests hand the store a fake fetch.
process.env.SEIRA_DISABLE_ANNOUNCEMENTS = "1";
// Named explicitly although homedir() already covers it: the device tests delete this directory wholesale.
process.env.SEIRA_COMPANION_DIR = join(home, ".seira-companion");

// Product code follows navigator.language; pin it so English assertions do not depend on the host locale.
Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

// Windows will not remove a directory holding an open SQLite database: close it before the reset.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// A save written behind (server/atomic.ts) lands before the next test clears the data folder, never in it.
const { writesBehindSettled } = await import("../atomic.ts");
afterEach(writesBehindSettled);

// Windows holds a live process's cwd, and a just-killed CLI lets go a beat after the kill returns.
afterAll(async () => {
  closeMessageDb();
  // A data path too long for a control socket shares a folder in /tmp, outside the scratch folder; this home is its only user.
  const sshFolder = vpsSshSharedControlDirectory(join(home, ".seira", VPS_SSH_DIR));
  if (sshFolder) await removeTempDir(sshFolder);
  await removeTempDir(home);
  await scratch.remove();
});
