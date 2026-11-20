// The packaged desktop and the container launcher run this instead of index.js: it turns on Node's
// on-disk compile cache for this process, so a relaunch reuses the compiled
// bundle, then runs the server unchanged. Copied, not bundled: bundling would
// inline index.js.
import module from "node:module";
import { lstatSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cacheRoot = process.env.SEIRA_SERVER_COMPILE_CACHE;
// Engine CLIs, MCP servers and terminals the server spawns must not inherit
// it. enableCompileCache does not set NODE_COMPILE_CACHE, so they inherit
// nothing from this.
delete process.env.SEIRA_SERVER_COMPILE_CACHE;

const resourcesLink = process.env.SEIRA_SERVER_RESOURCES_LINK;
delete process.env.SEIRA_SERVER_RESOURCES_LINK;

let enabled = false;
if (cacheRoot) {
  try {
    enabled = module.enableCompileCache(cacheRoot).status === module.constants.compileCacheStatus.ENABLED;
  } catch {
  }
}

// Node keys compile-cache entries by module URL, and an AppImage mounts at a new path at each launch.
if (resourcesLink && typeof module.registerHooks === "function") {
  try {
    const realRoot = realpathSync(resourcesLink);
    const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
    if (here === join(realRoot, "server")) {
      const realPrefix = pathToFileURL(realRoot).href + "/";
      const linkPrefix = pathToFileURL(resourcesLink).href + "/";
      module.registerHooks({
        resolve(specifier, context, nextResolve) {
          const result = nextResolve(specifier, context);
          return result.url?.startsWith(realPrefix)
            ? { ...result, url: linkPrefix + result.url.slice(realPrefix.length), shortCircuit: true }
            : result;
        },
      });
    }
  } catch {
  }
}

await import("./index.js");

// Node writes new entries when the process exits normally; a crash or a
// Windows kill skips that, so write them once the server is up. Then drop
// caches of other Node versions (one is left behind by each Electron
// upgrade) that no launch has used for a day. Only `v<node version>-…`
// directories inside the cache root Node reports are ever removed.
if (enabled) {
  setTimeout(() => {
    try {
      module.flushCompileCache();
      const current = module.getCompileCacheDir();
      if (dirname(current) !== resolve(cacheRoot)) return;
      const now = new Date();
      utimesSync(current, now, now);
      for (const name of readdirSync(cacheRoot)) {
        if (name === basename(current) || !/^v\d+\.\d+\.\d+-/.test(name)) continue;
        const stale = join(cacheRoot, name);
        const stat = lstatSync(stale);
        if (stat.isDirectory() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          rmSync(stale, { recursive: true, force: true });
        }
      }
    } catch {
    }
  }, 10_000).unref();
}
