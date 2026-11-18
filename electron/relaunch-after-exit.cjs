"use strict";

const { spawn } = require("node:child_process");

// Electron's app.relaunch() cannot restart an AppImage: its relauncher process
// runs with PR_SET_NO_NEW_PRIVS, which the kernel keeps across exec. The
// AppImage runtime mounts its image with the setuid fusermount3, which then
// fails with "Operation not permitted", and the relauncher sends that error to
// /dev/null. Its default execPath also points into the old mount, which goes
// away when this process exits.
//
// Instead, this process spawns a detached bash that it does not restrict. bash
// reads stdin until EOF. libuv creates the write end with close-on-exec, so
// only this process holds it, but Node closes it while Electron still shuts
// down. bash then waits until the kernel gives it a new parent, which happens
// only when this process has exited: the moment Electron's relauncher waits
// for. The AppImage runtime leaves its keep-alive pipe and mount directory
// open without close-on-exec, and spawn() passes them on, so bash closes every
// descriptor above 2 before it starts the AppImage. Otherwise the new process
// keeps the old mount alive.
const RUN_AFTER_PARENT_EXITS = [
  "read -r ignored",
  'for ((tries = 0; tries < 600; tries++)); do read -r -a stat </proc/$$/stat; [ "${stat[3]}" = "$PPID" ] || break; sleep 0.05; done',
  'for fd in /proc/$$/fd/*; do fd=${fd##*/}; case $fd in 0|1|2) ;; *) exec {fd}>&- ;; esac; done',
  'exec "$@" </dev/null',
].join("\n");

/**
 * Starts `appImage` with `args` once this process has exited.
 * Throws when the waiting shell cannot start; `onError` receives later spawn errors.
 */
function relaunchAppImageAfterExit(appImage, args, { env, onError }) {
  const waiter = spawn("bash", ["-c", RUN_AFTER_PARENT_EXITS, "appimage-relaunch", appImage, ...args], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env,
  });
  waiter.on("error", onError);
  if (waiter.pid === undefined) {
    throw new Error("Could not schedule the AppImage to restart");
  }
  waiter.stdin.on("error", () => {});
  waiter.stdin.unref();
  waiter.unref();
}

/**
 * Restarts the desktop with `args` after it quits. The caller still quits the app.
 */
function relaunchAfterExit(app, args, { env = process.env, onError }) {
  if (!env.APPIMAGE) {
    app.relaunch({ args });
    return;
  }
  try {
    relaunchAppImageAfterExit(env.APPIMAGE, args, { env, onError });
  } catch (error) {
    onError(error);
  }
}

module.exports = { relaunchAfterExit, relaunchAppImageAfterExit };
