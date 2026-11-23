// A person reads a failed workflow run and runs it again from the failed step, end to end in the real app: the real
// server in a temporary home, a scripted engine that fails once, the real renderer in headless Chrome, in both skins.
// Run with SEIRA_UI_E2E=1; SEIRA_WORKFLOW_SHOTS=DIR keeps the screenshots there.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchRestartableServer } from "../../server/testing/restartable-server.ts";
import { runControlSeira } from "../control-seira.ts";
import { agentBrowser, ensureUiBrowser, sessionEnv, type UiHandle } from "./control-seira-ui.ts";
import { mountPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHOTS = process.env.SEIRA_WORKFLOW_SHOTS || join(ROOT, ".seira-scratch", "workflow-run");
const SHORT_TMP = process.platform === "win32" ? tmpdir() : "/tmp";
const enabled = process.env.SEIRA_UI_E2E === "1";
const SKINS = ["midnight", "daylight"] as const;
const PANEL = 'aside[aria-label="Automation"]';
const STEP = (id: string) => `[data-workflow-canvas] [data-workflow-step="${id}"]`;

async function openApp(server: { url: string; port: number; dataDir: string; logPath: string }, botId: string) {
  mkdirSync(SHOTS, { recursive: true });
  const tools = await ensureUiBrowser(process.env);
  const preview = await mountPreview({ info: { url: server.url } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Workflow run", logLevel: "warn" });
  const handle: UiHandle = { url: server.url, previewUrl: preview.previewUrl, session: `seira-workflow-run-${server.port}`, binary: tools.binary, home: server.dataDir, botId, logPath: server.logPath, chrome: tools.chrome };
  const browser = (...args: string[]) => agentBrowser(tools.binary, sessionEnv(handle), args, 120_000);
  await browser("set", "viewport", "1280", "800");
  await browser("open", preview.previewUrl);
  const handlePath = join(server.dataDir, "ui.json");
  writeFileSync(handlePath, JSON.stringify(handle));
  const ui = (verb: string, ...args: string[]) => runControlSeira(["ui", verb, "--ui", handlePath, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  let shot = 0;
  const screenshot = async (name: string) => { await new Promise((resolve) => setTimeout(resolve, 300)); await ui("screenshot", "--out", join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`)); };
  const setSkin = async (skin: string) => {
    await evaluate(`import('/src/lib/skins.ts').then(({ applySkin }) => { applySkin(${JSON.stringify(skin)}); return document.documentElement.dataset.skin; })`);
    await evaluate("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))");
    await new Promise((resolve) => setTimeout(resolve, 400));
  };
  /** One screenshot of the same screen in each skin; the app is left in Midnight. */
  const skinShots = async (name: string) => {
    for (const skin of SKINS) {
      await setSkin(skin);
      await screenshot(`${name}-${skin}`);
    }
    await setSkin("midnight");
  };
  const text = (selector = "main") => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`) as Promise<string>;
  const exists = (selector: string) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`) as Promise<boolean>;
  const attribute = (selector: string, name: string) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`) as Promise<string | null>;
  const clickIn = async (scope: string, label: string) => {
    const found = await evaluate(`(() => { const button = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return Boolean(button); })()`);
    expect(found, `${label} in ${scope}`).toBe(true);
  };
  const openAutomations = async () => {
    await evaluate(`document.querySelector('button[aria-label="Open bot list"]')?.click(); true`);
    await expect.poll(() => evaluate(`(() => { const entry = document.querySelector("[data-sidebar-automations]"); entry?.click(); return Boolean(entry); })()`)).toBe(true);
    await expect.poll(() => text("main h1"), { timeout: 15_000 }).toBe("Automations");
  };
  /** The first-run offer to add Seira can open over any screen; a person turns it down. */
  const declineIntro = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const gone = await evaluate(`(() => { const button = [...document.querySelectorAll("[role=dialog] button")].find((candidate) => candidate.textContent.trim() === "Not now"); button?.click(); return Boolean(button); })()`);
      if (gone) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const close = async () => {
    await browser("close").catch(() => {});
    await preview.close();
  };
  return { ui, evaluate, declineIntro, screenshot, skinShots, text, exists, attribute, clickIn, openAutomations, close };
}

(enabled ? it : it.skip)("a person reads a failed workflow run and runs it again from the failed step", async () => {
  const server = await launchRestartableServer({ scripted: true, dataDirRoot: SHORT_TMP });
  let app: Awaited<ReturnType<typeof openApp>> | undefined;
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json", origin: server.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as any;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const starter = (await api("GET", "/api/bots?messages=0")).bots[0];
    const newBot = async (name: string) => ((await runControlSeira(["new-bot", "--name", name, "--url", server.url])) as { bot: { id: string } }).bot.id;
    const scout = await newBot("Scout");
    const ledger = await newBot("Ledger");
    const chat = { key: "chat", match: [""], repeat: true, steps: [], reply: "OK." };
    const plan = (ledgerFails: boolean) => writeFileSync(server.planPath, JSON.stringify({
      [starter.id]: { script: [chat] },
      [scout]: { script: [{ key: "collect", match: ["Collect today's leads."], repeat: true, steps: [], reply: "Found 3 leads: Ada, Grace and Linus." }, chat] },
      [ledger]: { script: [{ key: "file", match: ["File the leads."], repeat: true, steps: [], ...(ledgerFails ? { failWith: "Provider disconnected." } : { reply: "Filed 3 leads." }) }, chat] },
    }));
    plan(true);

    const scoutStep = "s_scout";
    const ledgerStep = "s_ledger";
    const { workflow } = await api("POST", "/api/workflows", {
      name: "Lead round",
      steps: [
        { id: scoutStep, kind: "bot", botId: scout, instruction: "Collect today's leads.", position: { x: 80, y: 80 } },
        { id: ledgerStep, kind: "bot", botId: ledger, instruction: "File the leads.", position: { x: 80, y: 260 } },
      ],
      connections: [{ id: "c_one", from: scoutStep, to: ledgerStep }],
    });
    const { routine } = await api("POST", "/api/routines", { name: "Lead round routine", workflowId: workflow.id, schedule: { type: "interval", everyMinutes: 1440, anchorAt: Date.now() + 86_400_000 } });
    const runOf = async (runId: string) => (await api("GET", `/api/workflow-runs/${runId}`)).run;
    const statuses = (run: any) => Object.fromEntries(run.stepRuns.map((step: any) => [step.stepId, step.status]));

    const { run: first } = await api("POST", `/api/routines/${routine.id}/run`);
    await expect.poll(async () => (await runOf(first.id)).status, { timeout: 60_000 }).toBe("failed");
    expect(statuses(await runOf(first.id))).toMatchObject({ [scoutStep]: "done", [ledgerStep]: "failed" });

    app = await openApp(server, scout);
    const { ui, evaluate, declineIntro, skinShots, text, exists, attribute, clickIn, openAutomations } = app;
    const state = (id: string) => attribute(STEP(id), "data-step-status");

    // 1. The routine's panel shows the run; its Open button leads to the run view.
    await declineIntro();
    await openAutomations();
    await expect.poll(() => evaluate(`(() => { const row = [...document.querySelectorAll("[data-automation]")].find((item) => item.innerText.includes("Lead round routine")); const button = row?.querySelector("button"); button?.click(); return Boolean(button); })()`)).toBe(true);
    await expect.poll(() => exists(`${PANEL} [data-workflow-run="${first.id}"]`), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => text(`${PANEL} [data-workflow-run]`)).toContain("Failed");
    await skinShots("routine-panel-steps");
    await clickIn(`${PANEL} [data-workflow-run]`, "Open");

    // 2. Step 1 is done, step 2 failed and selected, and its error shows.
    await expect.poll(() => exists("[data-workflow-canvas]"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => state(scoutStep)).toBe("done");
    await expect.poll(() => state(ledgerStep)).toBe("failed");
    expect(await attribute(STEP(ledgerStep), "aria-current")).toBe("true");
    expect(await attribute(STEP(scoutStep), "aria-current")).toBeNull();
    await expect.poll(() => text('aside[aria-label="Result"]')).toContain("Ledger couldn't finish this step.");
    expect(await text(`[data-workflow-result="${ledgerStep}"]`)).toContain("Failed");
    expect(await exists('[data-workflow-run-status="failed"]')).toBe(true);
    await skinShots("run-failed");

    // 3. The script now lets Ledger finish; Run again from here opens a new run that ends done.
    plan(false);
    await clickIn('aside[aria-label="Result"]', "Run again from here");
    await expect.poll(() => attribute("[data-workflow-run-status]", "data-workflow-run-status"), { timeout: 60_000 }).toBe("completed");
    const runs = (await api("GET", `/api/workflows/${workflow.id}/runs`)).runs as Array<{ runId: string; status: string; fromRunId?: string }>;
    expect(runs).toHaveLength(2);
    const second = runs.find((run) => run.runId !== first.id)!;
    expect(second).toMatchObject({ status: "completed", fromRunId: first.id });
    expect(statuses(await runOf(second.runId))).toMatchObject({ [scoutStep]: "done", [ledgerStep]: "done" });
    await expect.poll(() => state(ledgerStep)).toBe("done");
    expect(["done", "carried"]).toContain(await state(scoutStep));
    expect(await exists("[data-workflow-canvas] [data-step-status=failed]")).toBe(false);

    // 4. Both runs are listed, and the finished one is the one open.
    const listed = await evaluate(`[...document.querySelectorAll('aside[aria-label="Result"] section')].find((section) => section.querySelector("h3")?.textContent === "Runs of this routine")?.querySelectorAll("li").length ?? 0`);
    expect(listed).toBe(2);
    expect(await evaluate(`document.querySelectorAll('aside[aria-label="Result"] li button[aria-current="true"]').length`)).toBe(1);
    await evaluate(`document.querySelector(${JSON.stringify(STEP(ledgerStep))}).click(); true`);
    await expect.poll(() => text(`[data-workflow-result="${ledgerStep}"]`)).toContain("Filed 3 leads.");
    await skinShots("run-finished");

    // 5. The console stayed clean.
    const consoleErrors = ((await ui("console")).messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error");
    expect(consoleErrors).toEqual([]);
  } catch (error) {
    await app?.screenshot("failure").catch(() => {});
    throw error;
  } finally {
    await app?.close();
    console.info(JSON.stringify({ logPath: server.logPath, screenshots: SHOTS }));
    await server.close();
  }
}, 600_000);
