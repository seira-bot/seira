// Source maps of a release build: upload them to the crash report service, then delete every one, so no package carries
// a map (scripts/after-pack.mjs checks it). Without SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT the script only
// deletes the maps. The upload tool is not a dependency of Seira: `npx` fetches the pinned version when it is needed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SENTRY_CLI = "@sentry/cli@3.8.2";
/** The built UI and the built server. */
export const MAP_DIRS = [path.join(root, "dist"), path.join(root, "dist-server")];

export const hasUploadAccess = (env) => Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);

/** Deletes every .map file under the folders. A folder that does not exist counts as empty. */
export async function deleteMaps(dirs) {
  let deleted = 0;
  for (const dir of dirs) {
    let entries;
    try { entries = await readdir(dir, { recursive: true }); } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".map")) continue;
      await rm(path.join(dir, entry), { force: true });
      deleted++;
    }
  }
  return deleted;
}

/** The two upload tool calls, as argument lists. */
export const uploadCommands = (version, dirs) => [
  ["sourcemaps", "inject", ...dirs],
  ["sourcemaps", "upload", "--release", `seira@${version}`, ...dirs],
];

function runCli(args, env) {
  const result = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", SENTRY_CLI, ...args], {
    stdio: "inherit", env, shell: process.platform === "win32",
  });
  return result.status ?? 1;
}

/** Uploads when the build has access, then deletes the maps in every case. Throws after the delete when the upload failed. */
export async function runSymbols({ env = process.env, dirs = MAP_DIRS, version, run = runCli } = {}) {
  let failure;
  let uploaded = false;
  if (hasUploadAccess(env)) {
    const present = [];
    for (const dir of dirs) if (await readdir(dir).then(() => true, () => false)) present.push(dir);
    try {
      for (const args of uploadCommands(version, present)) {
        const status = await run(args, env);
        if (status !== 0) throw new Error(`The source map upload step "${args.slice(0, 2).join(" ")}" failed with status ${status}.`);
      }
      uploaded = true;
    } catch (error) {
      failure = error;
    }
  }
  const deleted = await deleteMaps(dirs);
  if (failure) throw failure;
  return { uploaded, deleted };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  runSymbols({ version }).then(({ uploaded, deleted }) => {
    console.log(uploaded ? `source maps uploaded for seira@${version}, ${deleted} map files deleted` : `no upload access, ${deleted} map files deleted`);
  }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
