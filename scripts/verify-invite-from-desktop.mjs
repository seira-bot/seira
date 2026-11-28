// The real app shell in three Electron windows against one disposable fake-engine server with email sign-in on:
// a connected server in the desktop window, the desktop app's own computer, and a plain browser page.
// Run: xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/verify-invite-from-desktop.mjs   (see docs/verification/invite-from-desktop.md)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureFlag = "--seira-invite-from-desktop-fixture";
const GUEST = "guest@corp.test";
// A value as a JavaScript literal for code the page runs: JSON, with the characters that can end a script or a line escaped.
const UNSAFE = { "<": "\\u003C", ">": "\\u003E", "/": "\\u002F", "\u2028": "\\u2028", "\u2029": "\\u2029" };
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (one) => UNSAFE[one]);

if (process.versions.electron && process.argv.includes(fixtureFlag)) {
  const { app, BrowserWindow, ipcMain, session } = await import("electron");
  const { desktopCapabilities } = createRequire(import.meta.url)("../electron/capabilities.cjs");
  const [url, output, shots] = process.argv.slice(process.argv.indexOf(fixtureFlag) + 1);
  const serverOrigin = new URL(url).origin;
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  if (process.env.SEIRA_ELECTRON_NO_SANDBOX === "1") {
    app.commandLine.appendSwitch("no-sandbox");
    app.commandLine.appendSwitch("disable-dev-shm-usage");
  }
  // The page asks these once at start and waits for the answer, so each one needs an answer.
  for (const channel of ["home:page", "home:updating", "update:offered", "desktop-crash-reports:read"]) ipcMain.on(channel, (event) => { event.returnValue = false; });
  for (const channel of ["desktop-analytics:read", "desktop-language:read"]) ipcMain.on(channel, (event) => { event.returnValue = null; });
  for (const channel of ["desktop:skin", "workspaces:line", "desktop-notices:state", "workspaces:places", "workspaces:look", "text-size:get", "rail:offer", "window-frame:state", "updates-consent:state", "call:active"]) ipcMain.handle(channel, () => null);
  ipcMain.handle("window:state", () => ({ maximized: false, fullScreen: false }));
  ipcMain.handle("sharing:state", () => ({ enabled: false, folders: [], terminal: false, computer: false, connected: false }));
  ipcMain.handle("update:get-state", () => ({ status: "idle" }));
  ipcMain.handle("companion:state", () => ({ running: false, enabled: false, devices: [], bind: null, publicUrl: null }));
  ipcMain.handle("desktop:capabilities", () => desktopCapabilities({ platform: process.platform }));
  ipcMain.handle("environments:state", () => ({ activeId: "local", environments: [], localOrigin: serverOrigin, remote: false }));
  ipcMain.handle("workspaces:state", () => ({ active: "This computer", environments: [] }));
  ipcMain.handle("desktop-remote:state", () => ({ active: false }));

  app.whenReady().then(async () => {
    const blocked = [];
    const errors = [];
    session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
      const target = new URL(request.url);
      const allowed = target.origin === serverOrigin || target.protocol === "devtools:" || target.protocol === "data:" || target.protocol === "blob:";
      if (!allowed && target.origin !== "https://www.google.com") blocked.push(request.url);
      callback({ cancel: !allowed });
    });
    const checks = [];
    const open = async (name, localOrigin) => {
      const win = new BrowserWindow({
        show: true, width: 1280, height: 860,
        webPreferences: {
          contextIsolation: true, sandbox: true, nodeIntegration: false,
          ...(localOrigin ? { preload: join(root, "electron/preload.cjs"), additionalArguments: [`--seira-local-origin=${localOrigin}`] } : {}),
        },
      });
      win.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(`${name}: ${event.message}`); console.error(`${name} console: ${event.message}`); } });
      win.webContents.on("render-process-gone", (_e, details) => console.error(`${name}: renderer gone ${details.reason}`));
      win.webContents.on("did-fail-load", (_e, code, description, failed) => console.error(`${name}: load failed ${code} ${description} ${failed}`));
      await Promise.race([win.loadURL(url), new Promise((_, reject) => setTimeout(() => reject(new Error(`${name}: the page did not load in 40 s`)), 40_000))]);
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const capture = async () => {
        for (let attempt = 0; ; attempt++) {
          try { return (await win.webContents.capturePage()).toPNG(); } catch (error) {
            if (attempt >= 20) throw error;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
      };
      const shot = async (file, wait = 500) => { await new Promise((resolve) => setTimeout(resolve, wait)); writeFileSync(join(shots, `${name}-${file}.png`), await capture()); };
      const until = async (check, description) => {
        for (let attempt = 0; attempt < 400; attempt++) {
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        writeFileSync(join(shots, `${name}-failure.png`), await capture());
        console.error(String(await evaluate("document.body.innerText")).slice(0, 1500));
        throw new Error(`${name}: timed out: ${description}`);
      };
      const clickButton = (label, within = "document") => evaluate(`(() => { const el = [...${within}.querySelectorAll('button')].find((one) => one.textContent.trim() === ${literal(label)}); if (!el) throw new Error('No button ' + ${literal(label)}); el.click(); })()`);
      const has = (selector) => evaluate(`Boolean(document.querySelector(${literal(selector)}))`);
      await until(() => has('button[aria-label="Settings"]'), "app shell with the Settings button");
      const openSettings = async () => {
        await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
        await until(() => has("[data-settings-page]"), "Settings navigation");
      };
      const openDepartmentMenu = async (file) => {
        if (await has("[data-settings-page]")) {
          await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
          await until(async () => !(await has("[data-settings-page]")), "Settings closed");
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await until(() => evaluate("[...document.querySelectorAll('*')].some((el) => el.children.length === 0 && el.textContent.trim() === 'Sales')"), "department Sales in the sidebar");
        await evaluate(`(() => { const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === 'Sales'); label.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 })); })()`);
        await until(() => has('[role="menu"][aria-label="Sales"]'), "department menu");
        await shot(file, 0);
        return evaluate(`document.querySelector('[role="menu"][aria-label="Sales"]').textContent`);
      };
      const setInput = (selector, value) => evaluate(`(() => { const el = document.querySelector(${literal(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${literal(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      return { win, evaluate, shot, until, clickButton, has, openSettings, openDepartmentMenu, setInput };
    };

    // Shows People and Invite: used by the connected server and the browser page.
    const invitesFromPeople = async (name, window) => {
      await window.openSettings();
      await window.until(() => window.has('[data-settings-page="people"]'), "People in the Settings navigation");
      checks.push(`${name}: People shows in the Settings navigation`);
      await window.evaluate(`document.querySelector('[data-settings-page="people"]').click()`);
      await window.until(() => window.evaluate("[...document.querySelectorAll('button')].some((el) => el.textContent.trim() === 'Invite')"), "the Invite button in Members");
      checks.push(`${name}: the Members block shows with the Invite button`);
      await window.shot("people");
      await window.clickButton("Invite");
      await window.until(() => window.has("[data-invite-dialog]"), "the Invite dialog");
      await window.shot("invite-dialog");
      await window.until(() => window.has("[data-invite-dialog] input"), "the email field");
      await window.setInput("[data-invite-dialog] input", GUEST);
      await window.clickButton("Invite", "document.querySelector('[data-invite-dialog]')");
      await window.until(() => window.evaluate("document.querySelector('[data-invite-dialog]')?.textContent.includes('Invite ready') ?? false"), "the invite is ready");
      checks.push(`${name}: saving ${GUEST} gives Invite ready`);
      const copy = await window.evaluate("[...document.querySelectorAll('[data-invite-dialog] button')].some((el) => el.textContent.trim() === 'Copy')");
      checks.push(`${name}: copy-link control ${copy ? "shows" : "does not show"}`);
      await window.shot("invite-ready");
      await window.clickButton("Done", "document.querySelector('[data-invite-dialog]')");
      await window.until(async () => !(await window.has("[data-invite-dialog]")), "the dialog closed");
      await window.until(() => window.evaluate(`document.body.innerText.includes(${literal(GUEST)})`), "the new person's row");
      checks.push(`${name}: the row for ${GUEST} is in the list`);
      await window.shot("row-added");
    };

    // REMOTE: a connected server's page in the desktop window (the preload says the app's own computer is another origin).
    const remote = await open("remote", "https://remote-fixture.invalid");
    assert.equal(await remote.evaluate("typeof window.ogb"), "object", "the desktop bridge is there");
    assert.equal(await remote.evaluate("Boolean(window.ogb.companion)"), false, "a connected server's page has no own-computer bridge");
    await invitesFromPeople("remote", remote);
    assert.match(await remote.openDepartmentMenu("department-menu"), /Invite to this department/);
    checks.push("remote: the department menu has Invite to this department");
    remote.win.close();

    // LOCAL: the desktop app's own computer.
    const local = await open("local", serverOrigin);
    assert.equal(await local.evaluate("Boolean(window.ogb.companion)"), true, "the own-computer bridge is there");
    await local.openSettings();
    assert.equal(await local.has('[data-settings-page="people"]'), false, "no People on the app's own computer");
    checks.push("local: no People in the Settings navigation");
    await local.shot("settings-nav");
    const localMenu = await local.openDepartmentMenu("department-menu");
    assert.doesNotMatch(localMenu, /Invite to this department/);
    checks.push("local: the department menu has no invite entry");
    local.win.close();

    // BROWSER: the server's own page, no preload.
    const browser = await open("browser", null);
    assert.equal(await browser.evaluate("typeof window.ogb"), "undefined");
    await invitesFromPeople("browser", browser);
    browser.win.close();

    assert.deepEqual(blocked, [], "unexpected external request attempted");
    const receipt = { passed: true, checks, consoleErrors: errors.slice(0, 20) };
    writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify(receipt));
    app.exit(0);
  }).catch((error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const { build } = await import("vite");
  const { launchVerificationServer } = await import("./control-seira.ts");
  const output = mkdtempSync(join(tmpdir(), "seira-invite-desktop-"));
  const shots = process.env.SEIRA_INVITE_SHOTS ?? join(output, "shots");
  for (const dir of ["home", "user-data"]) mkdirSync(join(output, dir));
  mkdirSync(shots, { recursive: true });
  const ui = process.env.SEIRA_INVITE_UI ?? join(output, "ui");
  if (!existsSync(join(ui, "index.html"))) await build({ root, logLevel: "error", build: { outDir: ui, emptyOutDir: true } });
  const fixture = await launchVerificationServer({ ...process.env, SEIRA_SIGNIN_SMTP_URL: "smtp://127.0.0.1:9" }, undefined, undefined, undefined, undefined, undefined, [], ui);
  const api = async (method, path, body) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${method} ${path} answered ${response.status}`);
    return response.json();
  };
  try {
    await api("PUT", "/api/config", { signIn: { admins: ["owner@corp.test"], members: [] }, onboarding: { completedAt: new Date().toISOString(), version: 99 } });
    const { bot } = await api("POST", "/api/bots", { name: "Helper" });
    await api("POST", "/api/sidebar-sections", { name: "Sales", botIds: [bot.id] });
    const probe = await fetch(fixture.info.url, { redirect: "manual" });
    console.log(`probe ${probe.status} ${probe.headers.get("content-type")} ${probe.headers.get("location") ?? ""}`);
    console.log(JSON.stringify({ server: fixture.info.url, evidence: output, shots }));
    const electron = createRequire(import.meta.url)("electron");
    const child = spawn(electron, [fileURLToPath(import.meta.url), fixtureFlag, fixture.info.url, output, shots], {
      env: { PATH: process.env.PATH, HOME: join(output, "home"), XDG_CONFIG_HOME: join(output, "home"), TMPDIR: output, TEMP: output, TMP: output,
        DISPLAY: process.env.DISPLAY, ...(process.env.SEIRA_ELECTRON_NO_SANDBOX ? { SEIRA_ELECTRON_NO_SANDBOX: process.env.SEIRA_ELECTRON_NO_SANDBOX } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => { appendFileSync(join(output, "electron.log"), data); process.stdout.write(data); });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timeout = setTimeout(stop, 180_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { clearTimeout(timeout); process.off("SIGINT", stop); process.off("SIGTERM", stop); });
    assert.equal(code, 0, `Electron check failed; inspect ${join(output, "electron.log")}`);
  } finally {
    await fixture.close();
    for (const dir of ["home", "user-data", ...(process.env.SEIRA_INVITE_UI ? [] : ["ui"])]) rmSync(join(output, dir), { recursive: true, force: true });
  }
}
