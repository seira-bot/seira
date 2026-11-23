// A person draws a workflow from a finished reply in a chat, end to end in the real app: the real server in a temporary
// home, a scripted engine that hands work to a second bot, the real renderer in headless Chrome, in both skins.
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
const SHOTS = process.env.SEIRA_WORKFLOW_SHOTS || join(ROOT, ".seira-scratch", "workflow-draw");
const SHORT_TMP = process.platform === "win32" ? tmpdir() : "/tmp";
const enabled = process.env.SEIRA_UI_E2E === "1";
const SKINS = ["midnight", "daylight"] as const;
const STEPS = "[data-workflow-canvas] [data-workflow-step]";
const CONNECTIONS = "[data-workflow-canvas] [data-workflow-connection]";

async function openApp(server: { url: string; port: number; dataDir: string; logPath: string }, botId: string) {
  mkdirSync(SHOTS, { recursive: true });
  const tools = await ensureUiBrowser(process.env);
  const preview = await mountPreview({ info: { url: server.url } }, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Draw as workflow", logLevel: "warn" });
  const handle: UiHandle = { url: server.url, previewUrl: preview.previewUrl, session: `seira-workflow-draw-${server.port}`, binary: tools.binary, home: server.dataDir, botId, logPath: server.logPath, chrome: tools.chrome };
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
  /** The first-run offer to add Seira can open over any screen; a person turns it down. */
  const declineIntro = async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const gone = await evaluate(`(() => { const button = [...document.querySelectorAll("[role=dialog] button")].find((candidate) => candidate.textContent.trim() === "Not now"); button?.click(); return Boolean(button); })()`);
      if (gone) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  /** From any screen: a person opens the bot list, leaving Automations first when it hides the list button. */
  const openChat = async (id: string) => {
    await expect.poll(() => evaluate(`(() => {
      const row = document.querySelector('[data-sidebar-bot-row="${id}"]');
      if (row) { row.click(); return true; }
      const list = document.querySelector('button[aria-label="Open bot list"]');
      if (list) { list.click(); return false; }
      document.querySelector('main header button[aria-label="Back"]')?.click();
      return false;
    })()`), { timeout: 30_000, interval: 500 }).toBe(true);
  };
  /** Opens the more menu of the reply that says `reply`. */
  const openReplyMenu = async (reply: string) => {
    await expect.poll(() => evaluate(`(() => { const row = [...document.querySelectorAll("[data-message-row]")].find((candidate) => candidate.innerText.includes(${JSON.stringify(reply)})); const more = row?.querySelector('button[aria-haspopup="menu"]'); more?.click(); return Boolean(more); })()`), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => exists("[role=menuitem]")).toBe(true);
  };
  const chooseDraw = async () => {
    const found = await evaluate(`(() => { const item = [...document.querySelectorAll("[role=menuitem]")].find((candidate) => candidate.textContent.trim() === "Draw as workflow"); item?.click(); return Boolean(item); })()`);
    expect(found, "Draw as workflow is in the more menu").toBe(true);
  };
  const close = async () => {
    await browser("close").catch(() => {});
    await preview.close();
  };
  return { ui, evaluate, declineIntro, screenshot, skinShots, text, exists, count, openChat, openReplyMenu, chooseDraw, close };
}

(enabled ? it : it.skip)("a person draws a workflow from a finished reply, with its hand-offs", async () => {
  const server = await launchRestartableServer({ scripted: true, dataDirRoot: SHORT_TMP });
  let app: Awaited<ReturnType<typeof openApp>> | undefined;
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${server.url}${path}`, { method, headers: { "content-type": "application/json", origin: server.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const value = await response.json() as any;
      if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const newBot = async (name: string) => ((await runControlSeira(["new-bot", "--name", name, "--url", server.url])) as { bot: { id: string; activeTaskId: string } }).bot;
    const lumi = await newBot("Lumi");
    const scout = await newBot("Scout");
    const ledger = await newBot("Ledger");
    await api("PATCH", `/api/bots/${lumi.id}`, { approvalMode: "auto", acknowledgeLocalAuto: true, applyToAllThreads: true });
    writeFileSync(server.planPath, JSON.stringify({
      [lumi.id]: { turns: [
        { steps: [{ tool: "coordinate_bots", arguments: { bot_ids: [scout.id], request_key: "orders", message: "Pull today's orders." }, expectError: false }], reply: "Asked Scout." },
        { reply: "Scout pulled 12 orders." },
      ] },
      [scout.id]: { turns: [{ reply: "12 orders today." }] },
      [ledger.id]: { turns: [{ reply: "The week is planned." }] },
    }));
    const send = async (bot: { id: string; activeTaskId: string }, words: string) => {
      await runControlSeira(["send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", words, "--url", server.url]);
      const done = await runControlSeira(["wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "40", "--url", server.url]) as { status: string };
      expect(done.status).toBe("settled");
    };
    const saved = async (name: string) => ((await api("GET", "/api/workflows")).workflows as any[]).find((workflow) => workflow.name === name);
    await send(lumi, "Summarize today's orders");
    await send(ledger, "Plan the week");

    app = await openApp(server, lumi.id);
    const { ui, evaluate, declineIntro, screenshot, skinShots, text, exists, count, openChat, openReplyMenu, chooseDraw } = app;

    // 1. The more menu of Lumi's last reply offers Draw as workflow.
    await declineIntro();
    await openChat(lumi.id);
    await openReplyMenu("Scout pulled 12 orders.");
    expect(await text("[role=menu]")).toContain("Draw as workflow");
    await skinShots("draw-menu");

    // 2. Choosing it opens a named workflow on the canvas: Lumi's request, then Scout's hand-off, joined.
    await chooseDraw();
    await expect.poll(() => exists('input[aria-label="Workflow name"]'), { timeout: 30_000 }).toBe(true);
    expect(await evaluate(`document.querySelector('input[aria-label="Workflow name"]').value`)).toBe("Summarize today's orders");
    await expect.poll(() => count(STEPS), { timeout: 15_000 }).toBe(2);
    expect(await count(CONNECTIONS)).toBe(1);
    expect(await exists('[data-workflow-canvas] [aria-label^="Bot step: Lumi"]')).toBe(true);
    expect(await exists('[data-workflow-canvas] [aria-label^="Bot step: Scout"]')).toBe(true);
    await skinShots("drawn-canvas");

    // 3. The workflow is saved with the same two bot steps.
    await expect.poll(async () => Boolean(await saved("Summarize today's orders")), { timeout: 30_000 }).toBe(true);
    const drawn = await saved("Summarize today's orders");
    expect(drawn.steps.map((step: any) => [step.kind, step.botId, step.instruction])).toEqual([
      ["bot", lumi.id, "Summarize today's orders"],
      ["bot", scout.id, "Pull today's orders."],
    ]);
    expect(drawn.connections).toHaveLength(1);

    // 4. A chat with no hand-off gives one bot step with the request.
    await openChat(ledger.id);
    await openReplyMenu("The week is planned.");
    await chooseDraw();
    await expect.poll(() => evaluate(`document.querySelector('input[aria-label="Workflow name"]')?.value ?? ""`), { timeout: 30_000 }).toBe("Plan the week");
    await expect.poll(() => count(STEPS), { timeout: 15_000 }).toBe(1);
    expect(await count(CONNECTIONS)).toBe(0);
    await screenshot("single-step");
    const single = await saved("Plan the week");
    expect(single.steps.map((step: any) => [step.kind, step.botId, step.instruction])).toEqual([["bot", ledger.id, "Plan the week"]]);

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
