// electron-updater installs an AppImage update under the release asset's name
// and unlinks the old file, breaking every launcher entry that points at the
// versioned path. Upstream overwrites in place only when the running file's
// name has no version, so force that branch.

// esbuild renames the imported `path` module per build (path2, path3, …), so
// match the identifier instead of pinning one. The back-reference keeps this
// from matching an unrelated join().
const RENAME_ASSIGNMENT =
  /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/g;

const IN_PLACE_ASSIGNMENT = "destination = appImageFile;";

// Upstream also unlinks the running AppImage before validating anything, then
// `mv`s the staged download from the updater cache, which may be on another
// filesystem. Instead: move into a sibling of the destination, then rename(2)
// over it atomically; nothing is removed until the replacement is complete.
const UNLINK_BEFORE_INSTALL = /^\s*\(0, fs_1\.unlinkSync\)\(appImageFile\);\n/m;

const MOVE_INTO_PLACE =
  /\(0, child_process_1\.execFileSync\)\("mv", \["-f", installerPath, destination\]\);/;

const ATOMIC_MOVE = [
  'const stagedDestination = `${destination}.new`;',
  '(0, child_process_1.execFileSync)("mv", ["-f", installerPath, stagedDestination]);',
  "(0, fs_1.renameSync)(stagedDestination, destination);",
].join("\n        ");

// BaseUpdater starts doInstall before it asks Electron to quit, so an immediate
// spawn can reach the data-directory lease while the old desktop is still
// cleaning up. The replacement must start only after this process exits.
//
// Electron's app.relaunch() cannot start it: its relauncher process runs with
// PR_SET_NO_NEW_PRIVS, which the kernel keeps across exec. The AppImage
// runtime mounts its image with the setuid fusermount3, which then fails with
// "Operation not permitted", and the relauncher sends that error to /dev/null.
//
// Instead, this process spawns a detached bash that it does not restrict. bash
// reads stdin until EOF, which comes when this process exits and the kernel
// closes the write end (libuv creates that end with close-on-exec, so no
// other child holds it). The AppImage runtime leaves its keep-alive pipe and
// mount directory open without close-on-exec, and spawn() passes them on, so
// bash closes every descriptor above 2 before it runs the update. Otherwise
// the new version keeps the old version's mount alive.
const IMMEDIATE_RELAUNCH = /this\.spawnLog\(destination, \[\], env\);/g;
const RELAUNCH_AFTER_EXIT = [
  "read -r ignored",
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; case $fd in 0|1|2) ;; *) exec {fd}>&- ;; esac; done',
  'exec "$1" </dev/null',
].join("\n");
const QUEUED_RELAUNCH = [
  `const relaunch = (0, child_process_1.spawn)("bash", ["-c", ${JSON.stringify(RELAUNCH_AFTER_EXIT)}, "appimage-relaunch", destination], {`,
  '  detached: true,',
  '  stdio: ["pipe", "ignore", "ignore"],',
  '  env',
  '});',
  'relaunch.on("error", (error) => this._logger.error(`Cannot restart the updated AppImage: ${error.stack || error}`));',
  'if (relaunch.pid === undefined) {',
  '  throw new Error("Could not schedule the updated AppImage to restart");',
  '}',
  'relaunch.stdin.on("error", () => {});',
  'relaunch.stdin.unref();',
  'relaunch.unref();',
].join("\n          ");

const REPLACEMENTS = [
  ["rename branch", RENAME_ASSIGNMENT, IN_PLACE_ASSIGNMENT],
  ["unlink before install", UNLINK_BEFORE_INSTALL, ""],
  ["move into place", MOVE_INTO_PLACE, ATOMIC_MOVE],
  ["immediate relaunch", IMMEDIATE_RELAUNCH, QUEUED_RELAUNCH],
];

/**
 * Throws when any step's upstream shape moved: a silently unpatched bundle would
 * ship the launcher-breaking behaviour again.
 */
export function patchAppImageUpdater(source) {
  let patched = source;
  for (const [label, pattern, replacement] of REPLACEMENTS) {
    const found = patched.match(pattern);
    const count = found ? (pattern.global ? found.length : 1) : 0;
    if (count !== 1) {
      throw new Error(
        `Expected exactly 1 AppImage "${label}" site to patch, found ${count}. ` +
          "electron-updater's AppImageUpdater.doInstall changed shape — re-read it and update " +
          "scripts/patch-appimage-updater.mjs before releasing.",
      );
    }
    // A replacement function keeps "$$" and "$1" in the shell script literal.
    patched = patched.replace(pattern, () => replacement);
  }
  return patched;
}
