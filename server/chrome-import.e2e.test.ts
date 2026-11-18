// Real server, a fake Chrome profile, and a real headless Chromium as the bot's browser behind a stand-in for agent-browser.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { writeFakeBrowser } from "./browser/chrome-import/testing/fake-profile.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLI = join(ROOT, "server/testing/fake-claude-cli.ts");
const FAKE_ENGINE = join(ROOT, "server/browser/chrome-import/testing/fake-engine.mjs");
const CHROMIUM = process.env.CHROMIUM_BIN || "/usr/bin/chromium";

const SESSION_VALUE = "e2e-cookie-value-3c9a71f0";
const PREFERENCE_VALUE = "e2e-cookie-value-90b2d4ee";
const OTHER_VALUE = "e2e-cookie-value-5d1e8a27";

const folders: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const folder of folders.splice(0)) await removeTempDir(folder);
});

async function startBrowser(root: string): Promise<string> {
  const profile = join(root, "chromium-profile");
  mkdirSync(profile, { recursive: true });
  const child = spawn(CHROMIUM, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  children.push(child);
  const portFile = join(profile, "DevToolsActivePort");
  await expect.poll(() => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n").length >= 2, { timeout: 30_000, interval: 100 }).toBe(true);
  const [port, path] = readFileSync(portFile, "utf8").split("\n");
  return `ws://127.0.0.1:${port}${path}`;
}

async function startServer(home: string, engine: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: { ...verificationServerEnvironment(process.env, home, port), XDG_CONFIG_HOME: join(home, ".config"), OMB_AGENT_BROWSER_PATH: engine },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const output: string[] = [];
  child.stdout!.on("data", (chunk) => { output.push(String(chunk)); });
  child.stderr!.on("data", (chunk) => { output.push(String(chunk)); });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output.join("")}`);
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 30_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as any };
  };
  return { api, output: () => output.join("") };
}

describe.skipIf(process.platform !== "linux" || !existsSync(CHROMIUM))("importing sign-ins from Chrome", () => {
  it("copies chosen sites into a running bot browser, lists them, and signs out of them", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-chrome-import-"));
    folders.push(home);
    mkdirSync(join(home, "tmp"), { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({
      features: { browser: true },
      instances: { claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: FAKE_CLI } } },
    }));
    writeFakeBrowser(join(home, ".config", "google-chrome"), [{ name: "Person 1", cookies: [
      { hostKey: ".example.com", name: "sid", value: SESSION_VALUE },
      { hostKey: "www.example.com", name: "pref", value: PREFERENCE_VALUE },
      { hostKey: ".other.test", name: "tok", value: OTHER_VALUE },
    ] }]);

    const addressFile = join(home, "cdp-url");
    writeFileSync(addressFile, await startBrowser(home));
    const engine = join(home, "agent-browser");
    writeFileSync(engine, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_ENGINE}' '${addressFile}' "$@"\n`, { mode: 0o755 });

    const { api, output } = await startServer(home, engine);
    const bot = (await api("POST", "/api/bots", { name: "Import probe" })).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { computer: "browser", browser: true })).status).toBe(200);

    const profiles = await api("GET", "/api/browser-sites/import/profiles");
    expect(profiles.status).toBe(200);
    expect(profiles.body.profiles).toHaveLength(1);
    expect(profiles.body.profiles[0]).toMatchObject({ name: "Person 1" });

    const listing = await api("POST", "/api/browser-sites/import/sites", { bot: bot.id, source: profiles.body.profiles[0].id });
    expect(listing.status).toBe(200);
    expect(listing.body.sites.map((site: { site: string; cookies: number }) => [site.site, site.cookies]).sort()).toEqual([["example.com", 2], ["other.test", 1]]);

    expect((await api("GET", `/api/browser-sites?bot=${bot.id}`)).body.sites).toEqual([]);
    const imported = await api("POST", "/api/browser-sites/import", { bot: bot.id, ticket: listing.body.ticket, sites: ["example.com"] });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ imported: { sites: 1, cookies: 2 }, running: true });

    const after = await api("GET", `/api/browser-sites?bot=${bot.id}`);
    expect(after.status).toBe(200);
    expect(after.body.sites.map((site: { site: string }) => site.site)).toEqual(["example.com"]);
    expect(after.body.sites[0].cookies).toBe(2);

    const reused = await api("POST", "/api/browser-sites/import", { bot: bot.id, ticket: listing.body.ticket, sites: ["example.com"] });
    expect(reused.status).toBe(409);

    const signedOut = await api("POST", "/api/browser-sites/sign-out", { bot: bot.id, site: "example.com" });
    expect(signedOut.status).toBe(200);
    expect(signedOut.body.sites).toEqual([]);
    expect((await api("GET", `/api/browser-sites?bot=${bot.id}`)).body.sites).toEqual([]);

    const everything = [profiles.text, listing.text, imported.text, after.text, output()].join("\n");
    for (const value of [SESSION_VALUE, PREFERENCE_VALUE, OTHER_VALUE]) expect(everything).not.toContain(value);
  }, 120_000);
});
