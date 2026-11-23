import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { actAllowed, DONE_MS, GLANCE_LIMITS, initialState, step, validFeed } from "./glance-model.mjs";

const LABELS = Object.fromEntries(["glance", "working", "needsYou", "question", "failed", "finished", "failedLine", "openChat", "deny", "allowOnce", "alwaysAllow", "couldNotSend", "close"].map((key) => [key, key]));
const bot = (id, extra = {}) => ({ botId: id, threadId: `t-${id}`, name: id, avatarUrl: null, color: null, state: "working", line: "Working", startedAt: 100, ask: null, ...extra });
const ask = (extra = {}) => ({ kind: "approval", requestId: "r1", title: "Run a command", detail: "ls -la", choices: [], canAlways: true, ...extra });
const feed = (...bots) => ({ version: 1, lang: "en", bots, labels: { ...LABELS } });
const run = (state, bots, now, opts) => step(state, validFeed(feed(...bots)), now, opts);
const keys = (out) => out.view.entries.map((entry) => entry.botId);

test("the limits equal shared/glance.ts", () => {
  const source = readFileSync(new URL("../shared/glance.ts", import.meta.url), "utf8");
  const block = /GLANCE_LIMITS = Object\.freeze\(\{([^}]*)\}\)/.exec(source)[1];
  const shared = Object.fromEntries([...block.matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual({ ...GLANCE_LIMITS }, shared);
  assert.equal(GLANCE_LIMITS.detail, 400);
});

test("validFeed accepts a clean feed and rejects wrong versions, types and limits", () => {
  assert.ok(validFeed(feed(bot("a"))));
  assert.equal(validFeed({ ...feed(), version: 2 }), null);
  assert.equal(validFeed(null), null);
  assert.equal(validFeed(feed(bot("a", { state: "idle" }))), null);
  assert.equal(validFeed(feed(bot("a", { startedAt: "x" }))), null);
  assert.equal(validFeed(feed(...Array.from({ length: 13 }, (_, i) => bot(`b${i}`)))), null);
  assert.equal(validFeed(feed(bot("a", { name: "x".repeat(81) }))), null);
  assert.equal(validFeed(feed(bot("a", { line: "x".repeat(161) }))), null);
  assert.equal(validFeed(feed(bot("a", { botId: "x".repeat(129) }))), null);
  assert.equal(validFeed(feed(bot("a", { state: "needs", ask: ask({ title: "x".repeat(241) }) }))), null);
  assert.equal(validFeed(feed(bot("a", { state: "needs", ask: ask({ detail: "x".repeat(401) }) }))), null);
  assert.equal(validFeed(feed(bot("a", { state: "needs", ask: ask({ detail: 5 }) }))), null);
  assert.ok(validFeed(feed(bot("a", { state: "needs", ask: ask({ detail: "x".repeat(400) }) }))));
  const choices = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: "c" }));
  assert.equal(validFeed(feed(bot("a", { state: "question", ask: ask({ kind: "question", choices }) }))), null);
  assert.equal(validFeed({ ...feed(), labels: { ...LABELS, close: "x".repeat(121) } }), null);
  assert.equal(validFeed({ ...feed(), labels: { ...LABELS, close: 1 } }), null);
});

test("validFeed drops an external avatar, a bad colour and control characters", () => {
  const out = validFeed(feed(bot("a", { avatarUrl: "https://evil.example/a.png", color: "red", name: "Fe\u0007lix" })));
  assert.equal(out.bots[0].avatarUrl, null);
  assert.equal(out.bots[0].color, null);
  assert.equal(out.bots[0].name, "Felix");
  const ok = validFeed(feed(bot("a", { avatarUrl: "/api/attachments/ab-1_x.png", color: "#00ff99" })));
  assert.equal(ok.bots[0].avatarUrl, "/api/attachments/ab-1_x.png");
  assert.equal(ok.bots[0].color, "#00ff99");
  assert.equal(validFeed(feed(bot("a", { avatarUrl: "/api/attachments/../x.png" }))).bots[0].avatarUrl, null);
});

test("AC-04 priority: ask, failed, longest working, done", () => {
  let out = run(initialState(), [bot("w2", { startedAt: 200 }), bot("w1", { startedAt: 100 }), bot("n", { state: "needs", ask: ask() })], 0, { mainFocused: true });
  assert.deepEqual(keys(out), ["n", "w1", "w2"]);
  out = run(out.state, [bot("w2", { startedAt: 200 }), bot("n", { state: "failed" })], 1000, { mainFocused: true });
  assert.deepEqual(keys(out), ["n", "w2", "w1"]);
  assert.equal(out.view.entries.at(-1).state, "done");
  assert.equal(out.view.entries[0].state, "failed");
});

test("AC-02 nothing active means inactive", () => {
  const out = run(initialState(), [], 0);
  assert.equal(out.view.active, false);
  assert.deepEqual(out.view.entries, []);
});

test("AC-01 compact shows at most four", () => {
  const out = run(initialState(), Array.from({ length: 6 }, (_, i) => bot(`b${i}`, { startedAt: i })), 0);
  assert.equal(out.view.compact.length, 4);
  assert.equal(out.view.entries.length, 6);
  assert.equal(out.view.active, true);
});

test("a bot that leaves working shows done for 4 s", () => {
  let out = run(initialState(), [bot("a")], 0);
  out = run(out.state, [], 1000);
  assert.equal(out.view.entries[0].state, "done");
  assert.equal(out.view.done, out.view.entries[0].key);
  assert.equal(out.view.nextAt, 1000 + DONE_MS);
  out = run(out.state, [], 1000 + DONE_MS - 1);
  assert.equal(out.view.active, true);
  out = run(out.state, [], 1000 + DONE_MS);
  assert.equal(out.view.active, false);
  assert.equal(out.view.done, null);
});

test("an old failure at start is not shown; a failure after another state is", () => {
  let out = run(initialState(), [bot("old", { state: "failed" })], 0);
  assert.equal(out.view.active, false);
  out = run(out.state, [bot("old", { state: "failed" })], 10);
  assert.equal(out.view.active, false);
  out = run(out.state, [bot("new")], 20);
  out = run(out.state, [bot("new", { state: "failed" }), bot("old", { state: "failed" })], 30);
  assert.deepEqual(keys(out), ["new"]);
  out = run(out.state, [bot("new", { state: "failed" })], 40);
  assert.deepEqual(keys(out), ["new"]);
});

test("AC-05 AC-17 a new ask opens the visor unless the main window has focus or Glance is hidden", () => {
  const bots = [bot("a", { state: "needs", ask: ask() })];
  let out = run(initialState(), bots, 0, { mainFocused: true });
  assert.equal(out.view.openOn, null);
  out = run(out.state, bots, 1, { hidden: true });
  assert.equal(out.view.openOn, null);
  out = run(out.state, bots, 2, {});
  assert.deepEqual(out.view.openOn, { key: "a\nt-a", requestId: "r1" });
  out = run(out.state, bots, 3, {});
  assert.equal(out.view.openOn, null);
  out = run(out.state, [bot("a", { state: "needs", ask: ask({ requestId: "r2" }) })], 4, {});
  assert.equal(out.view.openOn.requestId, "r2");
});

test("actAllowed checks bot, thread, request, choice and detail", () => {
  const approval = bot("a", { state: "needs", ask: ask() });
  const question = bot("q", { state: "question", ask: { kind: "question", requestId: "r9", title: "Which", detail: "", choices: [{ id: "c1", label: "One" }], canAlways: false } });
  const f = { bots: [approval, question, bot("w")] };
  const base = { botId: "a", threadId: "t-a", requestId: "r1" };
  assert.ok(actAllowed(f, { kind: "open", botId: "w", threadId: "t-w" }));
  assert.ok(!actAllowed(f, { kind: "open", botId: "w", threadId: "other" }));
  assert.ok(!actAllowed(f, { kind: "open", botId: "zzz", threadId: "t-zzz" }));
  for (const choice of ["deny", "once", "always"]) assert.ok(actAllowed(f, { kind: "approval", ...base, choice }));
  assert.ok(!actAllowed(f, { kind: "approval", ...base, choice: "forever" }));
  assert.ok(!actAllowed(f, { kind: "approval", ...base, requestId: "old", choice: "deny" }));
  assert.ok(!actAllowed(f, { kind: "approval", botId: "w", threadId: "t-w", requestId: "r1", choice: "deny" }));
  const noAlways = { bots: [bot("a", { state: "needs", ask: ask({ canAlways: false }) })] };
  assert.ok(!actAllowed(noAlways, { kind: "approval", ...base, choice: "always" }));
  assert.ok(actAllowed(noAlways, { kind: "approval", ...base, choice: "once" }));
  const q = { botId: "q", threadId: "t-q", requestId: "r9" };
  assert.ok(actAllowed(f, { kind: "answer", ...q, choiceId: "c1" }));
  assert.ok(!actAllowed(f, { kind: "answer", ...q, choiceId: "c2" }));
  assert.ok(!actAllowed(f, { kind: "approval", ...q, choice: "deny" }));
  assert.ok(!actAllowed(f, { kind: "answer", ...base, choiceId: "c1" }));
});

test("actAllowed refuses once and always for an approval with an empty detail, and still allows deny", () => {
  const f = { bots: [bot("a", { state: "needs", ask: ask({ detail: "" }) })] };
  const base = { kind: "approval", botId: "a", threadId: "t-a", requestId: "r1" };
  assert.ok(!actAllowed(f, { ...base, choice: "once" }));
  assert.ok(!actAllowed(f, { ...base, choice: "always" }));
  assert.ok(actAllowed(f, { ...base, choice: "deny" }));
});
