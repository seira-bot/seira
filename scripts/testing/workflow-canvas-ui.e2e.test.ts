// A person draws a workflow on the canvas and hands it to a routine, end to end in the real app: the real server in a
// temporary home, a scripted engine, the real renderer in headless Chrome, in both skins. Run with SEIRA_UI_E2E=1;
// SEIRA_WORKFLOW_SHOTS=DIR keeps the screenshots there.
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
const SHOTS = process.env.SEIRA_WORKFLOW_SHOTS || join(ROOT, ".seira-scratch", "workflow-canvas");
const SHORT_TMP = process.platform === "win32" ? tmpdir() : "/tmp";
const enabled = process.env.SEIRA_UI_E2E === "1";
const SKINS = ["midnight", "daylight"] as const;
const PANEL = 'aside[aria-label="Step settings"]';
const STEPS = "[data-workflow-canvas] [data-workflow-step]";
const CONNECTIONS = "[data-workflow-canvas] [data-workflow-connection]";

async function openApp(server: { url: string; port: number; dataDir: string; logPath: string }, botId: string) {
  mkdirSync(SHOTS, { recursive: true });
  const tools = await ensureUiBrowser(process.env);
  const preview = await mountPreview({ info: { url: server.url } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Workflow canvas", logLevel: "warn" });
  const handle: UiHandle = { url: server.url, previewUrl: preview.previewUrl, session: `seira-workflow-canvas-${server.port}`, binary: tools.binary, home: server.dataDir, botId, logPath: server.logPath, chrome: tools.chrome };
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
  const count = (selector: string) => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`) as Promise<number>;
  const clickIn = async (scope: string, label: string) => {
    const found = await evaluate(`(() => { const button = [...(document.querySelector(${JSON.stringify(scope)})?.querySelectorAll("button") ?? [])].find((candidate) => candidate.textContent.trim() === ${JSON.stringify(label)}); button?.click(); return Boolean(button); })()`);
    expect(found, `${label} in ${scope}`).toBe(true);
  };
  const fill = (selector: string, value: string) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); return field.value; })()`);
  const choose = (selector: string, option: string) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const entry = [...field.options].find((candidate) => candidate.textContent === ${JSON.stringify(option)}); if (!entry) return null; field.value = entry.value; field.dispatchEvent(new Event("change", { bubbles: true })); return entry.value; })()`);
  const reload = async () => { await evaluate("location.reload(); true"); await expect.poll(() => exists("[data-sidebar-automations]"), { timeout: 30_000 }).toBe(true); };
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
  return { ui, evaluate, declineIntro, screenshot, skinShots, text, exists, count, clickIn, fill, choose, reload, openAutomations, close };
}

(enabled ? it : it.skip)("a person draws a workflow, edits and undoes steps, and hands it to a routine", async () => {
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
    const chat = { script: [{ key: "chat", match: [""], repeat: true, steps: [], reply: "OK." }] };
    writeFileSync(server.planPath, JSON.stringify({ [starter.id]: chat, [scout]: chat, [ledger]: chat }));
    const saved = async () => ((await api("GET", "/api/workflows")).workflows as any[]).find((workflow) => workflow.name === "Morning round");

    app = await openApp(server, scout);
    const { ui, evaluate, declineIntro, skinShots, text, exists, count, clickIn, fill, choose, reload, openAutomations } = app;
    const openWorkflows = async () => {
      await openAutomations();
      await ui("click", "--name", "Workflows");
      await expect.poll(() => exists('[aria-label="Your workflows"], section[aria-label="Workflows"]')).toBe(true);
    };
    const onCanvas = async (kind: string) => {
      const before = await count(STEPS);
      await ui("click", "--name", kind);
      await expect.poll(() => count(STEPS)).toBe(before + 1);
    };
    const fillPanel = async (bot: string, instruction: string) => {
      await expect.poll(() => exists(`${PANEL} textarea`)).toBe(true);
      expect(await choose(`${PANEL} select`, bot), `${bot} is in the Bot list`).not.toBeNull();
      await fill(`${PANEL} textarea`, instruction);
    };

    // 1. The Workflows view starts empty.
    await declineIntro();
    await openWorkflows();
    await expect.poll(() => text()).toContain("You have no workflows.");
    await skinShots("list-empty");

    // 2. New workflow, then a name.
    await evaluate(`document.querySelector('section[aria-label="Workflows"] button').click(); true`);
    await expect.poll(() => exists('input[aria-label="Workflow name"]'), { timeout: 15_000 }).toBe(true);
    expect(await text()).toContain("Add a bot step to start this workflow.");
    await fill('input[aria-label="Workflow name"]', "Morning round");

    // 3. Two Bot steps: the first by a click, the second by the keyboard; the palette joins them.
    await onCanvas("Bot step");
    await fillPanel("Scout", "Collect today's leads.");
    await evaluate(`document.querySelector('[data-workflow-palette="bot"]').focus(); true`);
    await ui("press", "--keys", "Enter");
    await expect.poll(() => count(STEPS)).toBe(2);
    await fillPanel("Ledger", "File the leads.");
    if ((await count(CONNECTIONS)) === 0) {
      await evaluate(`document.querySelector('[data-workflow-canvas] [aria-label^="Bot step: Scout"]').click(); true`);
      await expect.poll(() => exists(`${PANEL} select[id$="-next-then"]`)).toBe(true);
      await choose(`${PANEL} select[id$="-next-then"]`, "Ledger");
      await expect.poll(() => count(CONNECTIONS)).toBe(1);
    }
    expect(await count(CONNECTIONS), "the first Bot step connects to the second").toBe(1);

    // 4. An AI check after the second step, and a step on its Yes branch.
    await onCanvas("AI check");
    await expect.poll(() => exists(`${PANEL} textarea`)).toBe(true);
    await fill(`${PANEL} textarea`, "Did Scout find any leads?");
    await onCanvas("Post results");
    expect(await count(CONNECTIONS)).toBe(3);

    // 5. Autosave, reload, and everything is still there.
    await expect.poll(async () => (await saved())?.steps.length, { timeout: 30_000 }).toBe(4);
    await expect.poll(async () => { const workflow = await saved(); return workflow?.steps.find((step: any) => step.kind === "check")?.question; }, { timeout: 30_000 }).toBe("Did Scout find any leads?");
    const workflow = await saved();
    expect(workflow.steps.map((step: any) => step.kind).sort()).toEqual(["bot", "bot", "check", "post"]);
    expect(workflow.steps.filter((step: any) => step.kind === "bot").map((step: any) => [step.botId, step.instruction]).sort()).toEqual([[ledger, "File the leads."], [scout, "Collect today's leads."]].sort());
    const check = workflow.steps.find((step: any) => step.kind === "check");
    const post = workflow.steps.find((step: any) => step.kind === "post");
    expect(workflow.connections.find((connection: any) => connection.from === check.id)).toMatchObject({ to: post.id, branch: "yes" });
    expect(workflow.connections).toHaveLength(3);
    await reload();
    await openWorkflows();
    await expect.poll(() => text()).toContain("Morning round");
    expect(await text()).toContain("4 steps");
    await skinShots("list-with-workflow");
    await evaluate(`document.querySelector("[data-workflow] button").click(); true`);
    await expect.poll(() => count(STEPS), { timeout: 15_000 }).toBe(4);
    expect(await count(CONNECTIONS)).toBe(3);
    expect(await evaluate(`document.querySelector('input[aria-label="Workflow name"]').value`)).toBe("Morning round");

    // 6. Delete a step and press Undo.
    await evaluate(`document.querySelector('[data-workflow-canvas] [aria-label^="Bot step: Scout"]').click(); true`);
    await expect.poll(() => text(PANEL)).toContain("Bot step");
    await skinShots("editor-panel-open");
    await evaluate(`document.querySelector('[data-workflow-canvas] [aria-label^="Post results"]').click(); true`);
    await expect.poll(() => text(PANEL)).toContain("Post results");
    await clickIn(PANEL, "Delete step");
    await expect.poll(() => count(STEPS)).toBe(3);
    await expect.poll(() => text("body")).toContain("Deleted Where the routine posts results");
    await ui("click", "--name", "Undo");
    await expect.poll(() => count(STEPS)).toBe(4);
    expect(await count(CONNECTIONS)).toBe(3);
    await expect.poll(async () => (await saved())?.steps.length, { timeout: 30_000 }).toBe(4);
    expect((await saved()).connections).toHaveLength(3);

    // 7. A routine takes the workflow: What it does, Workflow, Use, Save.
    await ui("click", "--name", "List");
    await clickIn("main", "New");
    await expect.poll(() => text("[role=dialog]")).toContain("What should happen?");
    await ui("click", "--name", "Set it up yourself");
    await ui("click", "--name", "Continue");
    await expect.poll(() => exists('[role=dialog] input[aria-label="Title"]'), { timeout: 15_000 }).toBe(true);
    await fill('[role=dialog] input[aria-label="Title"]', "Run the morning round");
    await evaluate(`document.querySelector('[data-what-it-does="workflow"]').click(); true`);
    await expect.poll(() => exists("[data-workflow-slot]")).toBe(true);
    await ui("click", "--name", "Use Morning round");
    await expect.poll(() => text("[data-workflow-slot]")).toContain("Morning round");
    await expect.poll(() => text("[role=dialog]")).toContain("In use");
    await evaluate(`document.querySelector("[data-workflow-slot]").scrollIntoView({ block: "center" }); true`);
    await skinShots("routine-slot");
    await clickIn("[role=dialog]", "Save");
    await expect.poll(() => exists("[role=dialog]")).toBe(false);
    await expect.poll(async () => ((await api("GET", "/api/routines")).routines as any[]).find((routine) => routine.name === "Run the morning round")?.workflowId, { timeout: 15_000 }).toBe(workflow.id);

    // 8. The console stayed clean.
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
