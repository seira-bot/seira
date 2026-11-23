import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { GLANCE_PAGE_CSP, GLANCE_PAGE_SCRIPT, GLANCE_TIMING, glancePageHtml } from "./glance-page.mjs";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.handlers = {}; this.className = ""; this.textContent = ""; this.disabled = false; this.style = { setProperty() {}, backgroundImage: "" }; this.parent = null; const set = new Set(); this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }; }
  getBoundingClientRect() { return { width: 100, height: 40 }; }
  get scrollHeight() { return this.cut && this.className === "detail" ? 400 : 100; }
  get clientHeight() { return 100; }
  get scrollWidth() { return 100; }
  get clientWidth() { return 100; }
  get firstChild() { return this.children[0] ?? null; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  addEventListener(type, fn) { (this.handlers[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.handlers[type] ?? []) fn({ type }); }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  text() { return this.textContent + this.children.map((c) => c.text()).join(" "); }
}

function world({ cut = false } = {}) {
  const timers = [];
  const calls = { size: [], act: [] };
  const visor = new Node("div");
  let clock = 0, answer = true;
  const sandbox = {
    document: { body: new Node("body"), getElementById: () => visor, createElement: (tag) => Object.assign(new Node(tag), { cut }), createElementNS: (_ns, tag) => new Node(tag) },
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn, ms) => { const timer = { fn, at: clock + ms, dead: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.dead = true; },
    Promise,
  };
  sandbox.window = sandbox;
  sandbox.glance = { size: async (s) => { calls.size.push(s); return true; }, act: async (a) => { calls.act.push(a); return answer; } };
  vm.createContext(sandbox);
  vm.runInContext(`${GLANCE_PAGE_SCRIPT};this.render = render; this.fadeOut = fadeOut;`, sandbox);
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + 10);
      for (const timer of timers.filter((t) => !t.dead && t.at <= clock)) { timer.dead = true; timer.fn(); await flush(); }
    }
    await flush();
  };
  const labels = Object.fromEntries(["glance", "working", "needsYou", "question", "failed", "finished", "failedLine", "openChat", "deny", "allowOnce", "alwaysAllow", "couldNotSend", "close"].map((k) => [k, k === "finished" ? "{name} finished" : k]));
  const entry = (id, extra = {}) => ({ key: `${id}\nt`, botId: id, threadId: "t", name: id, color: null, state: "working", line: `${id} line`, ask: null, avatar: null, ...extra });
  const view = (entries, extra = {}) => ({ entries, done: null, openOn: null, labels, attached: false, ...extra });
  return { sandbox, visor, calls, advance, flush, entry, view, setAnswer: (v) => { answer = v; }, render: async (v) => { sandbox.render(v); await flush(); }, buttons: () => visor.all().filter((n) => n.tag === "button").map((n) => n.text()) };
}

const approvalAsk = (detail, canAlways = true) => ({ kind: "approval", requestId: "r1", title: "Run it", detail, choices: [], canAlways });

test("the page script parses and the CSP has no network source", () => {
  assert.doesNotThrow(() => new vm.Script(GLANCE_PAGE_SCRIPT));
  assert.match(GLANCE_PAGE_CSP, /default-src 'none'/);
  assert.doesNotMatch(GLANCE_PAGE_CSP, /https?:|connect-src|\*|ws:/);
  assert.match(glancePageHtml(), /Content-Security-Policy/);
});

test("the script never writes markup and never shows a count", () => {
  assert.doesNotMatch(GLANCE_PAGE_SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  assert.doesNotMatch(GLANCE_PAGE_SCRIPT, /badge|["']\+["']/i);
});

test("AC-14 reduced motion turns every animation and transition off", () => {
  const html = glancePageHtml();
  const block = /@media \(prefers-reduced-motion: reduce\)\{([^]*?)\}\}/.exec(html)[1];
  assert.match(block, /animation:none!important/);
  assert.match(block, /transition:none!important/);
});

test("AC-01 compact shows eyes and at most four avatars with no text count", async () => {
  const w = world();
  await w.render(w.view(Array.from({ length: 6 }, (_, i) => w.entry(`b${i}`))));
  assert.equal(w.visor.attrs["data-level"], "compact");
  assert.equal(w.visor.all().filter((n) => n.className.startsWith("av")).length, 4);
  assert.doesNotMatch(w.visor.text(), /\+|\d/);
  assert.ok(w.visor.classList.contains("in"));
  assert.equal(w.calls.size.length, 1);
});

test("AC-03 a pointer resting 200 ms peeks one line, and leaving folds it", async () => {
  const w = world();
  await w.render(w.view([w.entry("felix", { line: "Searching the web" })]));
  w.visor.fire("pointerenter");
  await w.advance(GLANCE_TIMING.peekMs - 1);
  assert.equal(w.visor.attrs["data-level"], "compact");
  await w.advance(GLANCE_TIMING.peekMs + GLANCE_TIMING.fadeMs);
  assert.equal(w.visor.attrs["data-level"], "peek");
  assert.match(w.visor.text(), /felix/);
  assert.match(w.visor.text(), /Searching the web/);
  w.visor.fire("pointerleave");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.equal(w.visor.attrs["data-level"], "compact");
});

test("AC-04 a click opens the card of the top-priority bot; AC-09 Close and the 1 s leave fold it", async () => {
  const w = world();
  await w.render(w.view([w.entry("a", { state: "failed", line: "It broke" }), w.entry("b")]));
  w.visor.fire("click");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.equal(w.visor.attrs["data-level"], "open");
  assert.match(w.visor.text(), /It broke/);
  assert.ok(w.buttons().some((t) => t.trim() === "openChat"));
  const close = w.visor.all().find((n) => n.attrs["aria-label"] === "close");
  close.fire("click");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.equal(w.visor.attrs["data-level"], "compact");
  w.visor.fire("click");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  w.visor.fire("pointerenter");
  w.visor.fire("pointerleave");
  await w.advance(GLANCE_TIMING.leaveMs - 1);
  assert.equal(w.visor.attrs["data-level"], "open");
  await w.advance(GLANCE_TIMING.fadeMs + 20);
  assert.equal(w.visor.attrs["data-level"], "compact");
});

test("AC-05 AC-10 an ask opens by itself and stays open after the pointer leaves", async () => {
  const w = world();
  const bot = w.entry("a", { state: "needs", ask: approvalAsk("ls -la") });
  await w.render(w.view([bot], { openOn: { key: bot.key, id: "r1" } }));
  assert.equal(w.visor.attrs["data-level"], "open");
  w.visor.fire("pointerenter");
  w.visor.fire("pointerleave");
  await w.advance(GLANCE_TIMING.leaveMs * 3);
  assert.equal(w.visor.attrs["data-level"], "open");
});

test("an approval card shows the detail whole and offers Allow only when the detail is not empty", async () => {
  const w = world();
  const command = "pnpm db:migrate --env staging && echo done";
  const withDetail = w.entry("a", { state: "needs", ask: approvalAsk(command) });
  await w.render(w.view([withDetail], { openOn: { key: withDetail.key, id: "r1" } }));
  assert.equal(w.visor.all().find((n) => n.className === "detail").textContent, command);
  assert.deepEqual(w.buttons().map((t) => t.trim()).filter((t) => /deny|allowOnce|alwaysAllow|openChat/.test(t)), ["deny", "allowOnce", "alwaysAllow", "openChat"]);
  const bare = w.entry("b", { state: "needs", ask: { ...approvalAsk(""), requestId: "r2" } });
  await w.render(w.view([bare], { openOn: { key: bare.key, id: "r2" } }));
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.equal(w.visor.all().some((n) => n.className === "detail"), false);
  assert.deepEqual(w.buttons().map((t) => t.trim()).filter((t) => /deny|allowOnce|alwaysAllow|openChat/.test(t)), ["deny", "openChat"]);
});

test("AC-18 Allow hides while the detail needs scrolling to be read whole", async () => {
  const w = world({ cut: true });
  const bot = w.entry("a", { state: "needs", ask: approvalAsk("echo ok\n".repeat(40)) });
  await w.render(w.view([bot], { openOn: { key: bot.key, id: "r1" } }));
  assert.equal(w.visor.all().some((n) => n.className === "detail"), true);
  assert.deepEqual(w.buttons().map((t) => t.trim()).filter((t) => /deny|allowOnce|alwaysAllow|openChat/.test(t)), ["deny", "openChat"]);
});

test("peek and compact never show the detail", async () => {
  const w = world();
  const bot = w.entry("a", { state: "needs", line: "Wants to run a command", ask: approvalAsk("rm -rf build") });
  await w.render(w.view([bot]));
  assert.doesNotMatch(w.visor.text(), /rm -rf/);
  w.visor.fire("pointerenter");
  await w.advance(GLANCE_TIMING.peekMs + GLANCE_TIMING.fadeMs + 10);
  assert.equal(w.visor.attrs["data-level"], "peek");
  assert.doesNotMatch(w.visor.text(), /rm -rf/);
});

test("AC-06 a choice sends the act; AC-07 a failed answer keeps the card and shows the error", async () => {
  const w = world();
  const bot = w.entry("a", { state: "needs", ask: approvalAsk("ls") });
  await w.render(w.view([bot], { openOn: { key: bot.key, id: "r1" } }));
  const allow = w.visor.all().find((n) => n.tag === "button" && n.textContent === "allowOnce");
  w.setAnswer(true);
  allow.fire("click");
  await w.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.act.at(-1))), { kind: "approval", botId: "a", threadId: "t", requestId: "r1", choice: "once" });
  assert.doesNotMatch(w.visor.text(), /couldNotSend/);
  const again = w.visor.all().find((n) => n.tag === "button" && n.textContent === "deny");
  w.setAnswer(false);
  again.fire("click");
  await w.flush();
  assert.equal(w.visor.attrs["data-level"], "open");
  assert.match(w.visor.text(), /couldNotSend/);
  assert.ok(w.buttons().some((t) => t.trim() === "openChat"));
});

test("a question shows one button per choice, or only Open chat without choices", async () => {
  const w = world();
  const q = (choices) => w.entry("q", { state: "question", ask: { kind: "question", requestId: "r", title: "Which time", detail: "", choices, canAlways: false } });
  const withChoices = q([{ id: "a", label: "Tue" }, { id: "b", label: "Wed" }]);
  await w.render(w.view([withChoices], { openOn: { key: withChoices.key, id: "r" } }));
  assert.deepEqual(w.buttons().map((t) => t.trim()).filter((t) => ["Tue", "Wed", "openChat", "deny"].includes(t)), ["Tue", "Wed", "openChat"]);
  const bare = q([]);
  await w.render(w.view([bare], { openOn: { key: bare.key, id: "r2" } }));
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.deepEqual(w.buttons().map((t) => t.trim()).filter((t) => ["Tue", "Wed", "openChat"].includes(t)), ["openChat"]);
});

test("AC-08 Open chat sends an open act and folds the card", async () => {
  const w = world();
  const bot = w.entry("a", { state: "failed" });
  await w.render(w.view([bot]));
  w.visor.fire("click");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  w.visor.all().find((n) => n.tag === "button" && n.textContent === "openChat").fire("click");
  await w.advance(GLANCE_TIMING.fadeMs + 10);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.act.at(-1))), { kind: "open", botId: "a", threadId: "t" });
  assert.equal(w.visor.attrs["data-level"], "compact");
});

test("the done line says the finished words", async () => {
  const w = world();
  const done = w.entry("felix", { state: "done", line: "" });
  await w.render(w.view([done], { done: done.key }));
  assert.equal(w.visor.attrs["data-level"], "line");
  assert.match(w.visor.text(), /felix finished/);
});
