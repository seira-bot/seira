#!/usr/bin/env node
// Records the short demo at the top of the README: a bot gets a job, an approval card shows, the person
// clicks Allow, and the bot finishes. Everything is synthetic: a temporary home, sample bot names, and the
// repository's fake engine. Nothing reaches a real account, model, or user folder.
//
//   node scripts/record-readme-demo.mjs --chromium <chrome> --playwright-core <dir> --dist <vite build dir> \
//     [--out <folder>] [--port <free port>]
//
// It writes demo.webm, demo.mp4 and demo.gif into the output folder (default: ./.seira-scratch/readme-demo).
// ffmpeg must be on PATH. Look at every frame before you commit the result (docs/verification/readme-demo.md).
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verificationServerEnvironment } from "./control-seira.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
const need = (name) => args.get(name) ?? (console.error(`missing --${name}`), process.exit(2));
const chromiumPath = need("chromium");
const playwrightPath = resolve(need("playwright-core"));
const dist = resolve(need("dist"));
const out = resolve(args.get("out") ?? join(root, ".seira-scratch", "readme-demo"));
const port = Number(args.get("port") ?? 18811);
const base = `http://127.0.0.1:${port}`;

const JOB = "Run the tests for the Acme website and tell me if anything fails.";
const COMMAND = "pnpm test";
const MODEL_ID = "demo-model";
const MODEL_NAME = "Demo model";
const REPLY = "All 128 tests passed. Nothing failed, so the Acme website is ready to ship.";

const home = mkdtempSync(join(tmpdir(), "seira-readme-demo-"));
const data = home;
const fakeCli = join(root, "server", "testing", "fake-acp-cli.ts");
chmodSync(fakeCli, 0o755);
mkdirSync(data, { recursive: true });
// The model chip shows the name of the model. A neutral name keeps the clip from looking like a test, and does not claim a real model.
mkdirSync(join(data, ".grok"), { recursive: true });
writeFileSync(join(data, ".grok", "config.toml"), `[model.${MODEL_ID}]\nname = "${MODEL_NAME}"\n`);
writeFileSync(join(data, "config.json"), JSON.stringify({
  // A setup card's choices would sit between the greeting and the job.
  features: { smartSetupChoices: false },
  instances: {
    grok: {
      driver: "grokAgent",
      environment: {
        FAKE_ACP_MODE: "permission",
        FAKE_ACP_PERMISSION_TOOL_CALL: JSON.stringify({ kind: "execute", rawInput: { command: COMMAND }, title: COMMAND }),
        FAKE_ACP_PERMISSION_REPLY: REPLY,
      },
      config: { cli: fakeCli, fullAuto: false },
    },
  },
}));

const server = spawn(process.execPath, [join(root, "server", "index.ts")], {
  cwd: root,
  // The same sealed environment the verification launcher gives its fixture: a temporary home, no live announcements.
  env: { ...verificationServerEnvironment({}, home, port), PATH: dirname(process.execPath), SEIRA_STATIC_DIR: dist },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const api = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method, headers: { "content-type": "application/json", origin: base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.json();
};

let browser;
try {
  for (const deadline = Date.now() + 30_000; ;) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${serverLog.slice(-2000)}`);
    await sleep(200);
  }
  // Skip the welcome flow, as the end-to-end tests do.
  const { WELCOME_VERSION } = await import(new URL("../electron/onboarding-record.mjs", import.meta.url));
  await api("PUT", "/api/config", { onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  // The one-time "Meet Seira" card would cover the end of the clip.
  const listed = await api("GET", "/api/bots");
  for (const bot of listed.bots ?? []) if (bot.welcomed !== true) await api("PATCH", `/api/bots/${bot.id}`, { welcomed: true });
  const bots = [];
  for (const name of ["Scout", "Mira", "Atlas"]) {
    const { bot } = await api("POST", "/api/bots", { name });
    await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "grok", model: MODEL_ID }, approvalMode: "ask" });
    bots.push(bot);
  }

  const { chromium } = createRequire(join(playwrightPath, "package.json"))("playwright-core");
  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--use-mock-keychain", "--no-sandbox"] });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const size = { width: 1280, height: 800 };
  const recordingStarted = Date.now();
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1, colorScheme: "light", recordVideo: { dir: out, size } });
  // A sandbox with no network card reports "offline" to the page, which shows a banner. The fixture is on loopback, so say online.
  await context.addInitScript(() => Object.defineProperty(navigator, "onLine", { get: () => true }));
  const page = await context.newPage();
  await page.goto(base);
  // A screenshot of where the run stopped tells a maintainer what changed in the app.
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => console.error("page error:", error.message));
  const stopped = async (error) => {
    await page.screenshot({ path: join(out, "stopped.png") });
    throw error;
  };
  await page.getByText("Scout", { exact: true }).first().waitFor({ timeout: 30_000 }).catch(stopped);
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click();
  await page.getByText("Scout", { exact: true }).first().click();
  const clipStart = Math.max(0, (Date.now() - recordingStarted) / 1000 - 0.3); // the clip starts on Scout's chat, not on the loading screen
  const composer = page.locator("textarea").last();
  await composer.waitFor();
  await sleep(1500);

  await composer.click();
  await page.keyboard.type(JOB, { delay: 45 });
  await sleep(700);
  await page.keyboard.press("Enter");

  const allow = page.getByRole("button", { name: "Allow once", exact: true }).first();
  await allow.waitFor({ timeout: 30_000 }).catch(stopped);
  await sleep(3500); // time to read the card
  await allow.hover();
  await sleep(700);
  await allow.click();

  await page.getByText(REPLY, { exact: false }).first().waitFor({ timeout: 30_000 }).catch(stopped);
  await sleep(3500);
  const video = page.video();
  await context.close();
  await video.saveAs(join(out, "demo.webm"));
  await video.delete();
  await browser.close();
  browser = undefined;

  const trim = ["-ss", clipStart.toFixed(2)];
  const ffmpeg = (...argv) => {
    const run = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...argv], { stdio: "inherit" });
    if (run.status !== 0) throw new Error(`ffmpeg ${argv.join(" ")} failed`);
  };
  ffmpeg(...trim, "-i", join(out, "demo.webm"), "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "30", "-preset", "slow", "-movflags", "+faststart", "-vf", "fps=20,scale=1000:-2", join(out, "demo.mp4"));
  ffmpeg(...trim, "-i", join(out, "demo.webm"), "-vf", "fps=10,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", join(out, "demo.gif"));
  console.log(`wrote ${join(out, "demo.mp4")} and ${join(out, "demo.gif")}`);
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
  await sleep(500);
  rmSync(home, { recursive: true, force: true });
}
