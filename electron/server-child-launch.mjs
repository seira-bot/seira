import fs from "node:fs";
import path from "node:path";

function replaceSymlink(link, target) {
  const temporary = `${link}.${process.pid}`;
  try {
    fs.rmSync(temporary, { force: true });
    fs.symlinkSync(target, temporary, "dir");
    fs.renameSync(temporary, link);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}

export function serverChildLaunch({ resourcesPath, userData, env = process.env, exists = fs.existsSync, link = replaceSymlink }) {
  const serverDir = path.join(resourcesPath, "server");
  const bootstrap = path.join(serverDir, "desktop-entry.mjs");
  if (!exists(bootstrap)) return { entry: path.join(serverDir, "index.js"), compileCacheDir: null, symlinkEnv: null };
  const real = { entry: bootstrap, compileCacheDir: null, symlinkEnv: null };
  // A translocated macOS app must load server code from its signed bundle, not through a link in user data.
  if (resourcesPath.includes("/AppTranslocation/")) return real;
  const compileCacheDir = path.join(userData, "server-compile-cache");
  if (!env.APPIMAGE) return { ...real, compileCacheDir };
  // Node keys compile-cache entries by module path, and an AppImage mounts at a new path each launch.
  const fixed = path.join(userData, "server-resources");
  try {
    link(fixed, resourcesPath);
  } catch {
    return real;
  }
  // Electron 43 utilityProcess ignores Node flags in execArgv, and a packaged Electron 43 app drops most NODE_OPTIONS, so --preserve-symlinks is not available.
  return { entry: bootstrap, compileCacheDir, symlinkEnv: { OMB_SERVER_RESOURCES_LINK: fixed } };
}
