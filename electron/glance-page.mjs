// The Glance visor's page. Security: it holds no network source, it builds every node with createElement and textContent,
// and a picture is only a data URL that main made.

export const GLANCE_PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export const GLANCE_TIMING = Object.freeze({ peekMs: 200, leaveMs: 1000, fadeMs: 140 });

const STYLE = `
:root{color-scheme:dark;--visor:#0c0f14;--ink:#f2f2f3;--ink2:rgba(242,242,243,.68);--ink3:rgba(242,242,243,.48);--line:rgba(255,255,255,.08);--card:rgba(255,255,255,.045);--hover:rgba(255,255,255,.07);--eye:#ff2a57;--eye-glow:rgba(255,42,87,.75);--ok:#3ccf8e;--wait:#f5a524;--bad:#ff5c6c;--live:#4f8dff}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;overflow:hidden;font:13px/18px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--ink);-webkit-user-select:none;user-select:none}
#visor{position:absolute;left:0;top:0;width:max-content;background:linear-gradient(180deg,#10141b 0%,var(--visor) 38%,#06070a 100%);border-radius:18px;box-shadow:inset 0 0 0 1px rgba(236,238,241,.12);opacity:0;transform:translateY(-4px) scale(.98);transform-origin:50% 0;transition:opacity 160ms ease-out,transform 160ms ease-out}
#visor.in{opacity:1;transform:none}
body.attached #visor{border-radius:0 0 18px 18px}
#visor[data-level=compact],#visor[data-level=peek],#visor[data-level=line]{cursor:pointer}
#visor[data-level=peek],#visor[data-level=line]{width:380px}
#visor[data-level=open]{width:380px;border-radius:22px}
body.attached #visor[data-level=open]{border-radius:0 0 22px 22px}
.row{display:flex;align-items:center;gap:10px;height:34px;padding:0 12px}
.faces{display:flex;align-items:center;gap:7px}
.pline{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.pline b{font-weight:600;flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pline span{color:var(--ink2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eyes{display:inline-flex;align-items:center;gap:5px;height:13px;flex:none}
.eye{position:relative;width:6px;height:11px;border-radius:999px;background:var(--eye);box-shadow:0 0 5px var(--eye-glow)}
.eye::after{content:"";position:absolute;top:18%;left:22%;width:34%;height:18%;min-width:1.5px;min-height:1.5px;border-radius:50%;background:#fff;opacity:.95}
.eyes[data-mood=asleep] .eye{height:2px;box-shadow:none;opacity:.7}
.eyes[data-mood=asleep] .eye::after,.eyes[data-mood=happy] .eye::after{display:none}
.eyes[data-mood=working] .eye{animation:look 2.6s ease-in-out infinite}
.eyes[data-mood=alert] .eye{height:13px;width:7px}
.eyes[data-mood=happy] .eye{background:transparent;box-shadow:none;height:6px;border-radius:999px 999px 0 0;border:2px solid var(--eye);border-bottom:0}
.eyes[data-mood=sad] .eye{height:9px}
.eyes[data-mood=sad] .eye:first-child{clip-path:polygon(0 34%,100% 0,100% 100%,0 100%)}
.eyes[data-mood=sad] .eye:last-child{clip-path:polygon(0 0,100% 34%,100% 100%,0 100%)}
.av{--s:18px;--ring:transparent;position:relative;display:block;width:var(--s);height:var(--s);flex:none;padding:0;border:0;border-radius:50%;background:var(--c,#6b7280) center/cover no-repeat;box-shadow:0 0 0 1.5px var(--visor),0 0 0 3px var(--ring)}
.av[data-st=working]::before{content:"";position:absolute;inset:-3px;border-radius:50%;background:conic-gradient(from 0deg,var(--live) 0 28%,rgba(79,141,255,.18) 28% 100%);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 1.5px),#000 calc(100% - 1.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 1.5px),#000 calc(100% - 1.5px));animation:spin 1.6s linear infinite}
.av[data-st=needs],.av[data-st=question]{--ring:var(--wait)}
.av[data-st=failed]{--ring:var(--bad)}
.av[data-st=done]{--ring:var(--ok)}
.av.big{--s:32px;box-shadow:0 0 0 2px var(--visor),0 0 0 3.5px var(--ring)}
.av.big[data-st=working]::before{inset:-3.5px}
.head{display:flex;align-items:center;gap:10px;height:44px;padding:0 10px 0 16px}
.head .grow{flex:1}
.others{display:flex;align-items:center;gap:8px}
.others button{cursor:pointer}
.ibtn{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--ink2);cursor:pointer}
.ibtn:hover{background:var(--hover);color:var(--ink)}
.body{padding:0 12px 12px}
.card{position:relative;border-radius:18px;padding:14px 16px;overflow:hidden;background:var(--card);box-shadow:inset 0 0 0 1px var(--line)}
.card::after{content:"";position:absolute;inset:auto 0 0;height:70%;pointer-events:none;background:radial-gradient(110% 90% at 50% 130%,var(--tint,transparent),transparent 70%);opacity:.55}
.card>*{position:relative;z-index:1}
.card[data-k=needs],.card[data-k=question]{--tint:rgba(245,165,36,.42)}
.card[data-k=failed]{--tint:rgba(255,92,108,.45)}
.card[data-k=done]{--tint:rgba(60,207,142,.38)}
.card[data-k=working]{--tint:rgba(79,141,255,.28)}
.who{display:flex;align-items:center;gap:12px}
.who .name{display:grid;min-width:0}
.who b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who .state{color:var(--ink3);font-size:12px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.say{margin:12px 0 0;font-size:15px;line-height:22px;font-weight:500;overflow-wrap:anywhere}
.err{margin:8px 0 0;color:var(--bad)}
.detail{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px var(--line);font:12px/16px ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:176px;overflow:auto;-webkit-user-select:text;user-select:text}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.vbtn{height:28px;padding:0 12px;border:0;border-radius:999px;cursor:pointer;background:rgba(255,255,255,.08);color:var(--ink);font:inherit;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vbtn:hover{background:rgba(255,255,255,.13)}
.vbtn.primary{background:var(--ink);color:#0c0f14}
.vbtn.primary:hover{background:#fff}
.vbtn.quiet{background:none;color:var(--ink2)}
.vbtn.quiet:hover{background:var(--hover);color:var(--ink)}
.vbtn:disabled{opacity:.5;cursor:default}
@keyframes look{0%,12%{transform:translateX(-22%)}48%,62%{transform:translateX(22%)}100%{transform:translateX(-22%)}}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

/** The page script. `render(view)` and `fadeOut()` are called by main; `window.glance` comes from glance-preload.cjs. */
export const GLANCE_PAGE_SCRIPT = `
"use strict";
var NS = "http://www.w3.org/2000/svg";
var PNG = /^data:image\\/png;base64,[A-Za-z0-9+\\/=]+$/, HEX = /^#[0-9a-fA-F]{6}$/;
var PEEK_MS = ${GLANCE_TIMING.peekMs}, LEAVE_MS = ${GLANCE_TIMING.leaveMs}, FADE_MS = ${GLANCE_TIMING.fadeMs};
var visor = document.getElementById("visor");
var reduced = false;
try { reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
var S = { view: null, open: false, peek: false, inside: false, focus: null, level: null, seq: 0, size: "", openId: "", peekTimer: null, leaveTimer: null, sending: {}, failed: {}, afterPaint: null };

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}
function add(parent) {
  for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
  return parent;
}
function say(template, name) { return String(template).split("{name}").join(name); }
function sleep(ms) { return new Promise(function (done) { if (ms > 0) setTimeout(done, ms); else done(); }); }
function entryOf(key) {
  var all = S.view ? S.view.entries : [];
  for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
  return null;
}
function words() { return S.view.labels; }
function stateWord(entry) {
  var l = words();
  if (entry.state === "working") return l.working;
  if (entry.state === "needs") return l.needsYou;
  if (entry.state === "question") return l.question;
  if (entry.state === "failed") return l.failed;
  return say(l.finished, entry.name);
}
function mood() {
  var all = S.view.entries, found = { ask: false, failed: false, working: false, done: false };
  for (var i = 0; i < all.length; i++) {
    var st = all[i].state;
    if (st === "needs" || st === "question") found.ask = true;
    else if (st === "failed") found.failed = true;
    else if (st === "working") found.working = true;
    else found.done = true;
  }
  return found.ask ? "alert" : found.failed ? "sad" : found.working ? "working" : found.done ? "happy" : "asleep";
}
function eyes() {
  var box = el("span", "eyes");
  box.setAttribute("data-mood", mood());
  box.setAttribute("aria-hidden", "true");
  return add(box, el("span", "eye"), el("span", "eye"));
}
function avatar(entry, big, tag) {
  var node = el(tag || "span", big ? "av big" : "av");
  node.setAttribute("data-st", entry.state);
  if (entry.color && HEX.test(entry.color)) node.style.setProperty("--c", entry.color);
  if (entry.avatar && PNG.test(entry.avatar)) node.style.backgroundImage = 'url("' + entry.avatar + '")';
  node.setAttribute("role", "img");
  node.setAttribute("aria-label", entry.name);
  return node;
}
function closeIcon() {
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("aria-hidden", "true");
  var path = document.createElementNS(NS, "path");
  path.setAttribute("d", "m6 6 12 12M18 6 6 18");
  svg.appendChild(path);
  return svg;
}
function button(label, cls, run) {
  var node = el("button", "vbtn" + (cls ? " " + cls : ""), label);
  node.setAttribute("type", "button");
  node.addEventListener("click", run);
  return node;
}

function levelNow() {
  if (S.open && entryOf(S.focus)) return "open";
  if (S.view.done && entryOf(S.view.done)) return "line";
  return S.peek ? "peek" : "compact";
}
function faces() {
  var row = el("div", "faces"), all = S.view.entries;
  for (var i = 0; i < all.length && i < 4; i++) add(row, avatar(all[i], false));
  return row;
}
function buildCompact() { return add(el("div", "row"), eyes(), faces()); }
function buildPeek() {
  var top = S.view.entries[0];
  return add(el("div", "row"), eyes(), avatar(top, false), add(el("div", "pline"), el("b", "", top.name), el("span", "", top.line || stateWord(top))));
}
function buildLine() {
  var done = entryOf(S.view.done);
  return add(el("div", "row"), eyes(), avatar(done, false), add(el("div", "pline"), el("span", "", say(words().finished, done.name))));
}
function sendAct(entry, act) {
  var key = entry.key;
  if (S.sending[key]) return;
  S.sending[key] = true;
  S.failed[key] = false;
  update();
  Promise.resolve().then(function () { return window.glance.act(act); }).then(function (ok) { return ok === true; }, function () { return false; }).then(function (ok) {
    S.sending[key] = false;
    S.failed[key] = !ok;
    update();
  });
}
function openChat(entry) {
  Promise.resolve().then(function () { return window.glance.act({ kind: "open", botId: entry.botId, threadId: entry.threadId }); }).then(function () {}, function () {});
  closeCard();
}
/** Security: Allow shows only while the whole text of what it covers is in view without scrolling. */
function cutOff(node) {
  return node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1;
}
function buildCard(entry) {
  var l = words(), card = el("div", "card"), busy = S.sending[entry.key] === true;
  card.setAttribute("data-k", entry.state);
  var name = add(el("div", "name"), el("b", "", entry.name), el("span", "state", stateWord(entry)));
  add(card, add(el("div", "who"), avatar(entry, true), name));
  var ask = entry.ask;
  var text = ask ? ask.title : entry.state === "failed" ? (entry.line || say(l.failedLine, entry.name)) : entry.state === "done" ? say(l.finished, entry.name) : entry.line;
  if (text) add(card, el("p", "say", text));
  var detail = ask && ask.kind === "approval" && typeof ask.detail === "string" ? ask.detail : "";
  var pre = detail ? el("pre", "detail", detail) : null;
  add(card, pre);
  if (S.failed[entry.key]) {
    var err = el("p", "err", l.couldNotSend);
    err.setAttribute("role", "alert");
    add(card, err);
  }
  var acts = el("div", "acts");
  function approval(label, choice, cls) {
    var node = button(label, cls, function () { sendAct(entry, { kind: "approval", botId: entry.botId, threadId: entry.threadId, requestId: ask.requestId, choice: choice }); });
    node.disabled = busy;
    return node;
  }
  if (ask && ask.kind === "approval") {
    add(acts, approval(l.deny, "deny", ""));
    var allow = [];
    if (detail) allow.push(approval(l.allowOnce, "once", "primary"));
    if (detail && ask.canAlways) allow.push(approval(l.alwaysAllow, "always", ""));
    allow.forEach(function (node) { add(acts, node); });
    if (allow.length) S.afterPaint = function () { if (cutOff(pre)) allow.forEach(function (node) { acts.removeChild(node); }); };
  } else if (ask) {
    ask.choices.forEach(function (choice) {
      var node = button(choice.label, "", function () { sendAct(entry, { kind: "answer", botId: entry.botId, threadId: entry.threadId, requestId: ask.requestId, choiceId: choice.id }); });
      node.disabled = busy;
      add(acts, node);
    });
  }
  add(acts, button(l.openChat, ask && ask.kind === "question" && ask.choices.length === 0 ? "primary" : "quiet", function () { openChat(entry); }));
  return add(card, acts);
}
function buildOpen() {
  var l = words(), focus = entryOf(S.focus), others = el("div", "others");
  S.view.entries.forEach(function (entry) {
    if (entry.key === focus.key) return;
    var node = avatar(entry, false, "button");
    node.setAttribute("type", "button");
    node.setAttribute("aria-label", entry.name + ", " + stateWord(entry));
    node.addEventListener("click", function () { S.focus = entry.key; update(); });
    add(others, node);
  });
  var close = el("button", "ibtn");
  close.setAttribute("type", "button");
  close.setAttribute("aria-label", l.close);
  close.setAttribute("title", l.close);
  close.addEventListener("click", closeCard);
  add(close, closeIcon());
  var head = add(el("div", "head"), eyes(), others, el("span", "grow"), close);
  return add(el("div", "pane"), head, add(el("div", "body"), buildCard(focus)));
}
function build(level) {
  return level === "open" ? buildOpen() : level === "line" ? buildLine() : level === "peek" ? buildPeek() : buildCompact();
}

function paint(level, ticket) {
  S.level = level;
  visor.setAttribute("data-level", level);
  while (visor.firstChild) visor.removeChild(visor.firstChild);
  S.afterPaint = null;
  visor.appendChild(build(level));
  if (S.afterPaint) S.afterPaint();
  var box = visor.getBoundingClientRect();
  var size = { width: Math.ceil(box.width), height: Math.ceil(box.height) };
  var mark = size.width + "x" + size.height;
  var fit = mark === S.size && visor.classList.contains("in") ? Promise.resolve() : Promise.resolve().then(function () { return window.glance.size(size); }).then(function () { S.size = mark; }, function () {});
  return fit.then(function () { if (ticket === S.seq) visor.classList.add("in"); });
}
function update() {
  if (!S.view || !S.view.entries.length) return Promise.resolve();
  var ticket = ++S.seq, next = levelNow();
  if (S.level !== null && next !== S.level && visor.classList.contains("in")) {
    visor.classList.remove("in");
    return sleep(reduced ? 0 : FADE_MS).then(function () { if (ticket === S.seq) return paint(next, ticket); });
  }
  return paint(next, ticket);
}

function stopTimer(name) { if (S[name] !== null) { clearTimeout(S[name]); S[name] = null; } }
function closeCard() { stopTimer("leaveTimer"); S.open = false; update(); }
function holdsAsk() { var focus = entryOf(S.focus); return Boolean(focus && focus.ask); }
function watchLeave() {
  if (S.open && !S.inside && !holdsAsk() && S.leaveTimer === null) S.leaveTimer = setTimeout(function () { S.leaveTimer = null; if (!S.inside && !holdsAsk()) closeCard(); }, LEAVE_MS);
}
visor.addEventListener("pointerenter", function () {
  S.inside = true;
  stopTimer("leaveTimer");
  if (S.level === "compact" && !S.open && S.peekTimer === null) S.peekTimer = setTimeout(function () { S.peekTimer = null; if (S.inside) { S.peek = true; update(); } }, PEEK_MS);
});
visor.addEventListener("pointerleave", function () {
  S.inside = false;
  stopTimer("peekTimer");
  if (S.peek) { S.peek = false; update(); }
  watchLeave();
});
visor.addEventListener("click", function () {
  if (S.level === "open" || !S.view || !S.view.entries.length) return;
  stopTimer("peekTimer");
  S.peek = false;
  S.open = true;
  S.focus = S.view.entries[0].key;
  update();
});

function render(view) {
  S.view = view;
  if (document.body) document.body.className = view.attached ? "attached" : "";
  var live = {};
  view.entries.forEach(function (entry) { live[entry.key] = true; });
  Object.keys(S.sending).forEach(function (key) { if (!live[key]) delete S.sending[key]; });
  Object.keys(S.failed).forEach(function (key) { if (!live[key]) delete S.failed[key]; });
  if (view.openOn && view.openOn.key + "\\n" + view.openOn.id !== S.openId && entryOf(view.openOn.key)) {
    S.openId = view.openOn.key + "\\n" + view.openOn.id;
    S.open = true;
    S.peek = false;
    S.focus = view.openOn.key;
  }
  if (S.open && !entryOf(S.focus)) S.focus = view.entries.length ? view.entries[0].key : null;
  if (!S.focus) S.open = false;
  if (holdsAsk()) stopTimer("leaveTimer");
  watchLeave();
  return update();
}
function fadeOut() { visor.classList.remove("in"); S.level = null; S.open = false; S.peek = false; }
`;

export function glancePageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${GLANCE_PAGE_CSP}"><title>Seira</title><style>${STYLE}</style></head><body><div id="visor" role="status"></div><script>${GLANCE_PAGE_SCRIPT}</script></body></html>`;
}
