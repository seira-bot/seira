import { mkdirSync } from "node:fs";

export const REMOTE_READY_MS = 10_000;
export const REMOTE_LINE_LIMIT = 64 * 1024;
/** Only a helper that is still alive after this time is killed hard. */
export const REMOTE_KILL_GRACE_MS = 2_000;

/**
 * The visor of the main process when Glance runs in a helper process (Linux Wayland with an X11 display).
 * It has the same shape as `createGlanceWindow`, and it asks `onAct` for every action the helper reports.
 */
export function createRemoteVisor({ spawn, execPath, appArgs = [], switches = [], env = process.env, onAct, onFail, setTimer = setTimeout, clearTimer = clearTimeout, readyMs = REMOTE_READY_MS, folder, makeFolder = (path) => mkdirSync(path, { recursive: true, mode: 0o700 }) }) {
  let child = null, ready = false, closed = false, failed = false, shown = false, pending = null, waitReady = null, buffer = "", topInset = null;

  const write = (message) => {
    try { child?.stdin?.write(`${JSON.stringify(message)}\n`); } catch {}
  };

  function stop() {
    if (waitReady) clearTimer(waitReady);
    waitReady = null;
    const target = child;
    child = null;
    if (!target) return;
    try { target.stdin?.end(); } catch {}
    try { target.kill(); } catch {}
  }

  function fail() {
    if (closed || failed) return;
    failed = true;
    shown = false;
    const target = child;
    stop();
    const force = setTimer(() => {
      try { if (target && target.exitCode === null && target.signalCode === null) target.kill("SIGKILL"); } catch {}
    }, REMOTE_KILL_GRACE_MS);
    force?.unref?.();
    onFail();
  }

  function handle(line) {
    if (line.length > REMOTE_LINE_LIMIT) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (message.t === "ready") {
      if (ready) return;
      ready = true;
      if (waitReady) clearTimer(waitReady);
      waitReady = null;
      if (topInset !== null) write({ t: "inset", top: topInset });
      if (pending) { write(pending); pending = null; }
    } else if (message.t === "act" && typeof message.id === "string") {
      const id = message.id;
      Promise.resolve().then(() => onAct(message.act)).catch(() => false).then((ok) => write({ t: "acted", id, ok: ok === true }));
    }
  }

  function start() {
    const clean = { ...env };
    delete clean.ELECTRON_RUN_AS_NODE;
    try { makeFolder(folder); } catch { fail(); return; }
    let target;
    try {
      target = spawn(execPath, [...appArgs, `--seira-glance-visor=${folder}`, "--ozone-platform=x11", ...switches], { stdio: ["pipe", "pipe", "ignore"], env: clean });
    } catch {
      fail();
      return;
    }
    child = target;
    target.stdin?.on?.("error", () => {});
    target.stdout?.setEncoding?.("utf8");
    target.stdout?.on?.("data", (chunk) => {
      if (child !== target) return;
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        handle(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
      }
      if (buffer.length > REMOTE_LINE_LIMIT) buffer = "";
    });
    target.on("error", () => { if (child === target) fail(); });
    target.on("exit", () => { if (child === target) fail(); });
    waitReady = setTimer(() => { waitReady = null; if (child === target && !ready) fail(); }, readyMs);
    waitReady?.unref?.();
  }

  function send(message) {
    if (closed || failed) return;
    if (!child) start();
    if (ready) write(message);
    else pending = message;
  }

  return {
    render(payload) { send({ t: "render", payload }); shown = true; },
    hide() { if (!child) return; send({ t: "hide" }); shown = false; },
    /** Sent before the first command once the helper is ready, and at once after that. It starts no helper by itself. */
    setTopInset(top) { topInset = top; if (ready && child) write({ t: "inset", top }); },
    setSize: () => false,
    close() {
      closed = true;
      shown = false;
      pending = null;
      stop();
    },
    contents: () => null,
    visible: () => shown,
  };
}
