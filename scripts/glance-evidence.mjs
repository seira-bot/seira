// Renders the Glance visor (electron/glance-page.mjs) in headless Chrome for each state into
// docs/verification/evidence/glance/. The views come from the real model (electron/glance-model.mjs), the viewport is the
// size the visor asks its window for, at 2x, and reduced motion is on.
//
//   node scripts/glance-evidence.mjs [path to Chrome]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialState, step, validFeed } from "../electron/glance-model.mjs";
import { glancePageHtml } from "../electron/glance-page.mjs";
import { GLANCE_WINDOW } from "../electron/glance-window.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "docs/verification/evidence/glance");
const chrome = process.argv[2] ?? process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const english = JSON.parse(readFileSync(join(root, "src/locales/en.json"), "utf8"));
const LABELS = Object.fromEntries(Object.entries({ glance: "title", working: "working", needsYou: "needsYou", question: "question", failed: "failed", finished: "finished", failedLine: "failedLine", openChat: "openChat", deny: "deny", allowOnce: "allowOnce", alwaysAllow: "alwaysAllow", couldNotSend: "couldNotSend", close: "close" }).map(([field, key]) => [field, english[`glance.${key}`]]));
const START = 1_700_000_000_000;

const bot = (botId, name, color, state, line, more = {}) => ({ botId, threadId: `t-${botId}`, name, avatarUrl: null, color, state, line, startedAt: null, ask: null, ...more });
const felix = bot("felix", "Felix", "#4f8dff", "working", "Searching the web", { startedAt: START - 600_000 });
const rocco = bot("rocco", "Rocco", "#a78bfa", "working", "Writing the report", { startedAt: START - 120_000 });
const approval = (detail, canAlways = true) => ({ kind: "approval", requestId: "r-bix", title: "Bix wants to run a command", choices: [], detail, canAlways });
const bix = (ask) => bot("bix", "Bix", "#f5a524", "needs", "", { ask });
const nova = bot("nova", "Nova", "#3ccf8e", "question", "", {
  ask: { kind: "question", requestId: "r-nova", title: "Which deck should I update?", choices: [{ id: "0", label: "Q3 board deck" }, { id: "1", label: "Sales kickoff" }, { id: "2", label: "Both" }], detail: "", canAlways: false },
});
const many = ["Ana", "Ben", "Cy", "Dee", "Eli", "Fay"].map((name, index) => bot(name.toLowerCase(), name, ["#4f8dff", "#a78bfa", "#f472b6", "#22d3ee", "#facc15", "#fb923c"][index], "working", "", { startedAt: START - index * 1000 }));

/** Each scene: the feeds the page sends in order, and what the person does after the last render. */
const SCENES = [
  ["compact-working", [[felix, rocco]]],
  ["compact-many", [many]],
  ["peek", [[felix, rocco]], "peek"],
  ["open-working", [[felix, rocco]], "click"],
  ["needs-approval", [[felix], [felix, bix(approval("pnpm db:migrate --env staging"))]]],
  ["needs-approval-long", [[felix], [felix, bix(approval("rsync -av --delete ./build/ deploy@203.0.113.10:/srv/www/site/ && ssh deploy@203.0.113.10 'systemctl restart site-web site-worker && journalctl -u site-web -n 50 --no-pager'"))]]],
  ["needs-approval-cut", [[felix], [felix, bix(approval("echo step\n".repeat(30) + "rm -rf ./build"))]]],
  ["needs-no-detail", [[felix], [felix, bix(approval("", false))]]],
  ["question", [[felix], [felix, nova]]],
  ["failed", [[felix, rocco], [felix, { ...rocco, state: "failed", line: "" }]], "click"],
  ["done", [[felix, rocco], [felix]]],
  ["could-not-send", [[felix], [felix, bix(approval("pnpm db:migrate --env staging"))]], "allow-fails"],
];

function viewsOf(feeds) {
  let state = initialState(), view = null, openOn = null;
  feeds.forEach((bots, index) => {
    const feed = validFeed({ version: 1, lang: "en", bots, labels: LABELS });
    if (!feed) throw new Error(`invalid feed ${index}`);
    ({ state, view } = step(state, feed, START + index * 1000, { mainFocused: false, hidden: false }));
    if (view.openOn) openOn = view.openOn;
  });
  return {
    entries: view.entries.map((entry) => ({ key: entry.key, botId: entry.botId, threadId: entry.threadId, name: entry.name, color: entry.color, state: entry.state, line: entry.line, ask: entry.ask, avatar: null })),
    done: view.done, openOn: openOn ? { key: openOn.key, id: openOn.requestId } : null, labels: view.labels, attached: false,
  };
}

async function devtools(profile) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chrome did not open its DevTools port");
}

function session(url) {
  const socket = new WebSocket(url);
  const waiting = new Map();
  let next = 0, onLoad = null;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    } else if (message.method === "Page.loadEventFired" && onLoad) {
      const loaded = onLoad;
      onLoad = null;
      loaded();
    }
  });
  return {
    opened: new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); }),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    loaded: () => new Promise((resolve) => { onLoad = resolve; }),
    close: () => socket.close(),
  };
}

const BRIDGE = `window.__acted = []; window.__actResult = true; window.__size = null;
window.glance = {
  act: (act) => { window.__acted.push(act); return new Promise((resolve) => setTimeout(() => resolve(window.__actResult), 20)); },
  size: (size) => { window.__size = size; return Promise.resolve(true); },
};`;
const ACTIONS = {
  peek: `document.getElementById("visor").dispatchEvent(new PointerEvent("pointerenter"))`,
  click: `document.getElementById("visor").click()`,
  "allow-fails": `window.__actResult = false; document.querySelector(".acts button.primary").click()`,
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "glance-evidence-"));
const profile = join(scratch, "profile");
const browser = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
try {
  const cdp = session(await devtools(profile));
  await cdp.opened;
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: BRIDGE });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 58, g: 64, b: 76, a: 1 } });
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(glancePageHtml())}`;
  for (const [name, feeds, action] of SCENES) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: GLANCE_WINDOW.maxWidth, height: GLANCE_WINDOW.maxHeight, deviceScaleFactor: 2, mobile: false });
    const loaded = cdp.loaded();
    await cdp.send("Page.navigate", { url: page });
    await loaded;
    await cdp.send("Runtime.evaluate", { expression: `render(${JSON.stringify(viewsOf(feeds))})`, awaitPromise: true });
    await pause(400);
    if (action) {
      await cdp.send("Runtime.evaluate", { expression: ACTIONS[action] });
      await pause(600);
    }
    const { result } = await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({ size: window.__size, text: document.getElementById('visor').innerText, acted: window.__acted })", returnByValue: true });
    const { size, text, acted } = JSON.parse(result.value);
    const width = Math.min(GLANCE_WINDOW.maxWidth, Math.ceil(size?.width ?? GLANCE_WINDOW.start.width));
    const height = Math.min(GLANCE_WINDOW.maxHeight, Math.ceil(size?.height ?? GLANCE_WINDOW.start.height));
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await pause(100);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`${name}.png  ${width}x${height}  text=${JSON.stringify(text.replace(/\s+/g, " ").trim())}${acted.length ? `  acted=${JSON.stringify(acted)}` : ""}`);
  }
  cdp.close();
} finally {
  if (browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await exited;
  }
  rmSync(scratch, { recursive: true, force: true });
}
