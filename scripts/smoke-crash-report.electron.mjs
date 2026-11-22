// Electron side of scripts/smoke-crash-report.mjs. Do not start it by hand: the orchestrator sets the environment.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, crashReporter, ipcMain, net } = require("electron");

const phase = process.argv.find((arg) => ["renderer", "main-crash", "restart", "foreign-url"].includes(arg));
const dir = process.env.SMOKE_CRASH_DIR;
if (!phase || !dir) {
  console.error("[smoke-crash-report] missing phase or SMOKE_CRASH_DIR");
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userData = path.join(dir, "user-data");
app.setPath("userData", userData);
app.setPath("crashDumps", path.join(dir, "dumps"));

if (phase === "main-crash") globalThis.__smokeCanary = process.env.SMOKE_CANARY;

const finish = (code = 0) => {
  setTimeout(() => app.exit(code), 2000);
  app.quit();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function crashRenderer() {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await win.loadURL("data:text/html,<p>smoke</p>");
  win.webContents.debugger.attach("1.3");
  // The command never answers, because the page ends: do not wait for it.
  win.webContents.debugger.sendCommand("Page.crash").catch(() => {});
}

app.whenReady().then(async () => {
  const { createCrashReports } = await import(new URL("../electron/crash-report.mjs", import.meta.url));
  let sentOnce = false;
  let onSent = () => {};
  const crashReports = createCrashReports({
    app,
    ipcMain,
    crashReporter,
    fetch: async (url, init) => {
      const response = await net.fetch(url, init);
      sentOnce = true;
      onSent();
      return response;
    },
    prefs: { crashReports: () => true, setCrashReports: () => {} },
    userData,
    roots: [app.getAppPath() || root],
    firstSendDelayMs: 1000,
  });
  console.log(`[smoke-crash-report] phase=${phase} available=${crashReports.available}`);

  if (phase === "main-crash") {
    await sleep(2000);
    process.crash();
    return;
  }
  if (phase === "restart") {
    onSent = () => setTimeout(() => finish(0), 1500);
    await sleep(30_000);
    return finish(sentOnce ? 0 : 3);
  }
  await crashRenderer();
  if (phase === "renderer") {
    onSent = () => setTimeout(() => finish(0), 1500);
    await sleep(20_000);
    return finish(sentOnce ? 0 : 3);
  }
  await sleep(10_000);
  finish(0);
});

app.on("window-all-closed", () => {});
