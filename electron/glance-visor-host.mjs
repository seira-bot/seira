import { isAbsolute } from "node:path";
import { TOP_INSET_MAX } from "./glance-top-inset.mjs";
import { createGlanceWindow } from "./glance-window.mjs";

const VISOR_FLAG = "--seira-glance-visor";
export const HOST_ACT_WAIT_MS = 10_000;
export const HOST_LINE_LIMIT = 4 * 1024 * 1024;

/**
 * Runs in the helper process that the main process starts with `--ozone-platform=x11`.
 * It reads one JSON command per line from `input` and writes one JSON event per line to `output`.
 * The main process chooses the settings folder that the flag names, and every helper start reuses it.
 * It opens no port and loads only the page of `createGlanceWindow`. Every check of an action stays in the main process.
 */
export function runGlanceVisorHost({ app, BrowserWindow, ipcMain, screen, input = process.stdin, output = process.stdout, argv = process.argv, createVisor = createGlanceWindow, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const flag = argv.find((entry) => entry.startsWith(`${VISOR_FLAG}=`));
  const folder = flag ? flag.slice(VISOR_FLAG.length + 1) : "";
  if (!folder || !isAbsolute(folder)) {
    app.quit();
    return Promise.resolve();
  }
  app.setPath("userData", folder);
  app.on("window-all-closed", () => {});

  let visor = null, nextAct = 1, ended = false;
  const waiting = new Map();
  const send = (message) => { try { output.write(`${JSON.stringify(message)}\n`); } catch {} };
  const fromVisor = (event) => {
    const contents = visor?.contents();
    return Boolean(contents && event.sender === contents && event.senderFrame && event.senderFrame === contents.mainFrame);
  };

  ipcMain.handle("glance-visor:act", (event, raw) => {
    if (!fromVisor(event)) return false;
    const id = String(nextAct++);
    return new Promise((resolve) => {
      const wait = setTimer(() => { waiting.delete(id); resolve(false); }, HOST_ACT_WAIT_MS);
      wait?.unref?.();
      waiting.set(id, { resolve, wait });
      send({ t: "act", id, act: raw });
    });
  });
  ipcMain.handle("glance-visor:size", (event, size) => fromVisor(event) && visor?.setSize(size) === true);

  function handle(line) {
    if (line.length > HOST_LINE_LIMIT) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object" || !visor) return;
    if (message.t === "render") visor.render(message.payload);
    else if (message.t === "hide") visor.hide();
    else if (message.t === "inset") { if (Number.isInteger(message.top) && message.top >= 0 && message.top <= TOP_INSET_MAX) visor.setTopInset(message.top); }
    else if (message.t === "acted" && typeof message.id === "string") {
      const found = waiting.get(message.id);
      if (!found) return;
      waiting.delete(message.id);
      clearTimer(found.wait);
      found.resolve(message.ok === true);
    }
  }

  function finish() {
    if (ended) return;
    ended = true;
    visor?.close();
    app.quit();
  }

  let buffer = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
    if (buffer.length > HOST_LINE_LIMIT) buffer = "";
  });
  input.on("end", finish);
  input.on("close", finish);

  return Promise.resolve(app.whenReady()).then(() => {
    visor = createVisor({ BrowserWindow, screen, platform: "linux" });
    send({ t: "ready" });
  });
}
