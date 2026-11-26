#!/usr/bin/env node
// Capture the companion apps' test fixtures through a real harness and sidecar,
// against a temporary HOME and the fake engine:
//
//   node scripts/capture-companion-fixtures.mjs
//   node scripts/capture-companion-fixtures.mjs --overview-only
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// `--out <dir>`: the fixtures directory to write.
const outFlag = process.argv.indexOf("--out");
if (outFlag === -1 || !process.argv[outFlag + 1]) {
  console.error("Usage: node scripts/capture-companion-fixtures.mjs --out <fixtures dir> [--overview-only]");
  process.exit(2);
}
const OUT = resolve(process.argv[outFlag + 1]);
const overviewOnly = process.argv.includes("--overview-only");

const base = 19100 + Math.floor(Math.random() * 3000);
const HARNESS_PORT = base;
const COMPANION_PORT = base + 10;
const CONTROL_PORT = base + 11;
const HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
const SIDECAR = `http://127.0.0.1:${COMPANION_PORT}`;
const CONTROL = `http://127.0.0.1:${CONTROL_PORT}`;
const CONTROL_TOKEN = randomBytes(32).toString("base64url");
const controlHeaders = { "x-seira-control-token": CONTROL_TOKEN };

const PROFILE = { name: "Ada Lovelace", email: "ada@example.com" };

const CARD_MARKER = "fixture task card";
const CARD_INPUT = {
  intro: "Hi, good morning! Tasks I could help with:",
  tasks: [
    {
      title: "Draft the weekly follow-up summary",
      description: "You owe five follow-ups before the weekly meeting. I can draft the summary first.",
      icon: "document",
    },
    { title: "Plan tomorrow's calendar", icon: "calendar" },
    { title: "Sort the unread email", description: "Twelve messages wait since Monday.", icon: "mail" },
  ],
};

const children = [];
let home = "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep the fixture engine's checkout path and disposable home out of payloads.
const fixturePaths = (value) => {
  if (typeof value === "string") return value.replaceAll(ROOT, "/fixture-repo").replaceAll(home, "/fixture-home");
  if (Array.isArray(value)) return value.map(fixturePaths);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fixturePaths(entry)]));
  }
  return value;
};

const write = (name, value) => {
  if (overviewOnly && name !== "bot-overview") return;
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(fixturePaths(value), null, 2)}\n`);
  console.log(`  ${name}.json`);
};

const start = (label, args, env) => {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { PATH: dirname(process.execPath), TZ: "UTC", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (c) => (child.err = (child.err ?? "") + c));
  children.push({ label, child });
  return child;
};

const waitFor = async (url, label, child, headers = {}) => {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(url, { headers })).ok) return;
    } catch {
    }
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}:\n${child.err ?? ""}`);
    if (Date.now() > deadline) throw new Error(`${label} never came up:\n${child.err ?? ""}`);
    await sleep(150);
  }
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
};

let deviceToken = "";
const asDevice = (init = {}) => ({
  ...init,
  headers: { ...init.headers, authorization: `Bearer ${deviceToken}` },
});

async function captureFrames(wanted, during) {
  const controller = new AbortController();
  const res = await fetch(`${SIDECAR}/api/events`, asDevice({ signal: controller.signal }));
  const frames = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const pump = (async () => {
    while (frames.length < wanted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      // events are separated by a blank line
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            frames.push(JSON.parse(line.slice(5).trim()));
          } catch {
          }
        }
      }
    }
  })();

  await during();
  await Promise.race([pump, sleep(8000)]);
  controller.abort();
  return frames.slice(0, wanted);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  home = mkdtempSync(join(tmpdir(), "companion-fixtures-"));
  mkdirSync(join(home, ".seira"), { recursive: true });
  writeFileSync(join(home, ".seira", "config.json"), JSON.stringify({
    profile: PROFILE,
    instances: {
      claude: {
        driver: "claudeAgent",
        displayName: "Fixture engine",
        config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") },
      },
    },
  }));

  const toolRoutes = join(home, "tool-routes.json");
  writeFileSync(toolRoutes, JSON.stringify({ [CARD_MARKER]: [{ name: "suggest_tasks", server: "agents", input: CARD_INPUT }] }));

  console.log(`harness on ${HARNESS_PORT}, companion on ${COMPANION_PORT}`);
  const harness = start("harness", [join(ROOT, "server", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    SEIRA_PORT: String(HARNESS_PORT),
    FAKE_CLAUDE_MODE: "happy",
    FAKE_CLAUDE_TOOL_ROUTES: toolRoutes,
    SEIRA_WEBHOOK_PORT: String(base + 1),
  });
  await waitFor(`${HARNESS}/api/health`, "harness", harness);

  // Client-facing fixtures go through the sidecar, which scrubs, rewrites SSE
  // frames and refuses device routes; the harness directly only for setup.
  const sidecar = start("companion", [join(ROOT, "companion", "src", "index.ts")], {
    HOME: home,
    USERPROFILE: home,
    SEIRA_PORT: String(HARNESS_PORT),
    SEIRA_WEBHOOK_PORT: String(base + 1),
    SEIRA_COMPANION_PORT: String(COMPANION_PORT),
    SEIRA_CONTROL_PORT: String(CONTROL_PORT),
    SEIRA_CONTROL_TOKEN: CONTROL_TOKEN,
    SEIRA_COMPANION_DIR: join(home, "companion"),
  });
  await waitFor(`${CONTROL}/state`, "companion", sidecar, controlHeaders);

  console.log("writing:");
  write("unauthorized", (await json(`${SIDECAR}/api/bots`)).body);
  write("pair-rejected", (await json(`${SIDECAR}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "000000", deviceName: "Ada's iPhone" }),
  })).body);

  const { code } = (await json(`${CONTROL}/pairing`, { method: "POST", headers: controlHeaders })).body;
  const paired = await json(`${SIDECAR}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, deviceName: "Ada's iPhone" }),
  });
  if (!paired.body.token) throw new Error(`pairing failed: ${JSON.stringify(paired.body)}`);
  deviceToken = paired.body.token;
  // A fixture is a file people copy, so the live token is never written.
  write("pair-response", { ...paired.body, token: "seira_REDACTED" });

  // Left unfiled: DecodingTests pins bots-full's first bot as section-less.
  const created = await json(`${SIDECAR}/api/bots`, asDevice({ method: "POST" }));
  const bot = created.body.bot;
  if (!bot) throw new Error(`could not create a bot: ${JSON.stringify(created.body)}`);

  // The harness names a fresh bot at random; pinned so recaptures do not churn.
  const renamed = await json(`${SIDECAR}/api/bots/${bot.id}/profile`, asDevice({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Pesto" }),
  }));
  if (renamed.status !== 200) throw new Error(`could not rename the bot: ${JSON.stringify(renamed.body)}`);
  bot.name = "Pesto";

  // Remove the other bots the harness seeds on an empty store, through the
  // harness because no phone route deletes bots. Seira itself (`defaultBot`)
  // cannot be deleted, so it stays in the fleet fixtures.
  const preseeded = (await json(`${HARNESS}/api/bots`)).body.bots ?? [];
  for (const extra of preseeded) {
    if (extra.id === bot.id || extra.defaultBot) continue;
    const removed = await json(`${HARNESS}/api/bots/${extra.id}`, { method: "DELETE" });
    if (removed.status !== 200) {
      throw new Error(`could not remove the seeded starter bot: ${JSON.stringify(removed.body)}`);
    }
  }

  console.log("capturing frames");
  const frames = await captureFrames(4, async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`${SIDECAR}/api/bots/${bot.id}/messages`, asDevice({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `fixture message ${i}` }),
      }));
      await sleep(120);
    }
  });
  if (frames.length === 0) throw new Error("no frames arrived on /api/events");

  write("sse-frames", frames);
  const hello = frames.find((f) => f.kind === "hello");
  if (hello) write("sse-hello", hello);

  // Created on the harness to exercise a channel's section field. Five
  // messages, so the capture capped at three has a page boundary (hasMore).
  const madeRoom = await json(`${HARNESS}/api/groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixtures", memberIds: [bot.id], section: "Fixtures" }),
  });
  const room = madeRoom.body.group;
  if (!room) throw new Error(`could not create a room: ${JSON.stringify(madeRoom.body)}`);
  // Setup is skipped on the harness: a phone has no /setup route.
  const skipped = await json(`${HARNESS}/api/groups/${room.id}/setup`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "skip" }),
  });
  if (skipped.status !== 200) throw new Error(`could not skip room setup: ${JSON.stringify(skipped.body)}`);
  for (let i = 0; i < 5; i++) {
    const posted = await fetch(`${SIDECAR}/api/groups/${room.id}/messages`, asDevice({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `room fixture message ${i}` }),
    }));
    if (!posted.ok) throw new Error(`could not post room message ${i}: ${posted.status}`);
    await sleep(120);
  }

  // Posts return before the store appends them: wait for 4 rows so hasMore
  // stays true below.
  const roomMessageCount = async () => {
    const page = await json(`${SIDECAR}/api/threads/${room.threadId}/messages`, asDevice());
    return (page.body.messages ?? []).length;
  };
  const pollDeadline = Date.now() + 5_000;
  let landed = await roomMessageCount();
  while (landed < 4) {
    if (Date.now() > pollDeadline) {
      throw new Error(`only ${landed} of the 5 room messages landed before the timeout`);
    }
    await sleep(150);
    landed = await roomMessageCount();
  }

  write("bots-full", (await json(`${SIDECAR}/api/bots`, asDevice())).body);
  write("bots-paged", (await json(`${SIDECAR}/api/bots?messages=3`, asDevice())).body);
  write(
    "thread-page",
    (await json(`${SIDECAR}/api/threads/${bot.threadId}/messages?limit=2`, asDevice())).body,
  );
  write("config", (await json(`${SIDECAR}/api/config`, asDevice())).body);
  write("instances", (await json(`${SIDECAR}/api/instances`, asDevice())).body);
  write("limit-resets", (await json(`${SIDECAR}/api/limit-resets`, asDevice())).body);

  write("forbidden", (await json(`${SIDECAR}/api/config`, asDevice({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xai: { apiKey: "not-a-real-key" } }),
  }))).body);

  // Kiwi exercises every overview section: an interval routine, a persona,
  // and the profile-change history a soul edit appends.
  const kiwiCreated = await json(`${SIDECAR}/api/bots`, asDevice({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Kiwi", title: "Tracker", description: "Files bugs." }),
  }));
  const kiwi = kiwiCreated.body.bot;
  if (!kiwi) throw new Error(`could not create Kiwi: ${JSON.stringify(kiwiCreated.body)}`);
  const filed = await json(`${SIDECAR}/api/sidebar-sections`, asDevice({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Fixtures", botIds: [kiwi.id] }),
  }));
  if (filed.status !== 200) throw new Error(`could not file Kiwi: ${JSON.stringify(filed.body)}`);
  const souled = await json(`${SIDECAR}/api/bots/${kiwi.id}/profile`, asDevice({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ soul: "File bugs.\n\nNever file noise." }),
  }));
  if (souled.status !== 200) throw new Error(`could not set Kiwi's soul: ${JSON.stringify(souled.body)}`);
  const routined = await json(`${SIDECAR}/api/routines`, asDevice({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Triage Discord",
      prompt: "Check Discord for new bug reports and file them.",
      target: "bot",
      botId: kiwi.id,
      runOn: "seira",
      enabled: true,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: Date.now() },
    }),
  }));
  if (routined.status !== 201) throw new Error(`could not create Kiwi's routine: ${JSON.stringify(routined.body)}`);
  // The next-run clock changes per capture; the phone suites pin the shape.
  const overview = await json(`${SIDECAR}/api/bots/${kiwi.id}/overview`, asDevice());
  if (overview.status !== 200) throw new Error(`could not read Kiwi's overview: ${JSON.stringify(overview.body)}`);
  write("bot-overview", overview.body);

  // A fixture harness has no tool runs, so the rows are empty.
  const activity = await json(`${SIDECAR}/api/bots/${kiwi.id}/activity?limit=50`, asDevice());
  if (activity.status !== 200) throw new Error(`could not read Kiwi's activity: ${JSON.stringify(activity.body)}`);
  write("bot-activity", activity.body);

  // One entry of each kind, so a phone decodes every field.
  for (const entry of [
    { kind: "person", name: "Ada Lovelace", detail: "Runs the team", aliases: ["Ada"] },
    { kind: "place", name: "Launch plan", detail: "Notion, Marketing space" },
    { kind: "decision", name: "Ship Android first", detail: "Decided in the Monday sync" },
    { kind: "term", name: "MCHQ", detail: "MissionControlHQ, the old name" },
  ]) {
    const added = await json(`${SIDECAR}/api/team-memory?section=`, asDevice({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    }));
    if (added.status !== 201) throw new Error(`could not add team memory: ${JSON.stringify(added.body)}`);
  }
  const memory = await json(`${SIDECAR}/api/team-memory?section=`, asDevice());
  if (memory.status !== 200) throw new Error(`could not read team memory: ${JSON.stringify(memory.body)}`);
  write("team-memory", memory.body);

  await captureTaskSuggestions();

  console.log("\nnot captured: options-card.json — needs a real approval from a real turn");
}

// Ids and times differ per run: each distinct value maps to a stable stand-in in first-seen order.
const TIME_KEYS = new Set(["at", "changedAt"]);
const ID_KEYS = new Set(["id", "messageId", "threadId", "startedMessageId", "parentId", "activeLeafId"]);
const pinRun = () => {
  const ids = new Map();
  const times = new Map();
  const walk = (value, key) => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, entry]) => [k, walk(entry, k)]));
    }
    if ((typeof value === "number" || typeof value === "string") && TIME_KEYS.has(key)) {
      if (!times.has(value)) times.set(value, 1_700_000_000_000 + times.size * 1000);
      const pinned = times.get(value);
      return typeof value === "string" ? new Date(pinned).toISOString() : pinned;
    }
    if (typeof value === "string" && ID_KEYS.has(key) && !/^s[1-5]$/.test(value)) {
      if (!ids.has(value)) ids.set(value, `fixture-${key.replace(/Id$/, "") || "id"}-${ids.size + 1}`);
      return ids.get(value);
    }
    return value;
  };
  return (value) => walk(value);
};

const waitUntil = async (what, check) => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = await check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};

async function captureTaskSuggestions() {
  const created = await json(`${SIDECAR}/api/bots`, asDevice({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Basil" }),
  }));
  const basil = created.body.bot;
  if (!basil) throw new Error(`could not create Basil: ${JSON.stringify(created.body)}`);
  const page = async () => (await json(`${SIDECAR}/api/threads/${basil.threadId}/messages?limit=50`, asDevice())).body;
  const cardLine = async () => (await page()).messages?.find((m) => m.taskSuggestions);
  const answer = (messageId, suggestionId, action) =>
    json(`${SIDECAR}/api/bots/${basil.id}/task-suggestions`, asDevice({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: basil.threadId, messageId, suggestionId, action }),
    }));

  const sent = await fetch(`${SIDECAR}/api/bots/${basil.id}/messages`, asDevice({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `Good morning, ${CARD_MARKER} please` }),
  }));
  if (!sent.ok) throw new Error(`could not send the card message: ${sent.status}`);
  const card = await waitUntil("the task card", cardLine);
  await waitUntil("the end of the card turn", async () =>
    (await page()).messages?.some((m) => m.role === "bot" && !m.taskSuggestions && /hello from fake claude/.test(m.text ?? "")));
  await sleep(500);

  let hide, show, start;
  const frames = await captureFrames(14, async () => {
    hide = await answer(card.id, "s1", "hide");
    show = await answer(card.id, "s1", "show");
    start = await answer(card.id, "s1", "start");
  });
  const startAgain = await answer(card.id, "s1", "start");
  const unknown = await answer(card.id, "s9", "hide");
  await waitUntil("the Start turn", async () => (await page()).messages?.some((m) => m.fromTaskSuggestion));
  const pageAfter = { body: await page() };

  // Only the lines this card touches: the rest of a turn carries run-bound ids and timings.
  const startedId = start.body.sent?.id;
  const ours = (message) => message?.id === card.id || message?.id === startedId;
  const cardFrames = frames
    .filter((frame) => (frame.kind === "message.patch" && frame.message?.id === card.id) || (frame.kind === "message" && frame.message?.id === startedId))
    .map(({ seq: _seq, ...frame }) => frame);
  const pin = pinRun();
  const fixture = pin({
    card,
    hide, show, start, startAgain, unknown,
    frames: { status: 200, body: cardFrames },
    page: { status: 200, body: { ...pageAfter.body, messages: pageAfter.body.messages.filter(ours) } },
  });
  write("task-suggestions", fixture);
}

const cleanup = () => {
  for (const { child } of children) child.kill("SIGKILL");
  if (home) rmSync(home, { recursive: true, force: true });
};

main().then(
  () => (cleanup(), console.log("done")),
  (error) => {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
