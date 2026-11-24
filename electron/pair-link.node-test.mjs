import assert from "node:assert/strict";
import test from "node:test";

import { createPairLinks, pairLinkFromCommandLine, pairLinkIntent } from "./pair-link.mjs";
import { installPairLinks } from "./pair-link-main.mjs";
import { createServerConnect } from "./server-probe.mjs";

const CODE = "7KQ2-M9XD-H4TP";
const LINK = `seira://pair?address=${encodeURIComponent("https://seira.example.com")}&code=${CODE}`;

test("reads the link a server's Open in app button makes, and nothing else", () => {
  assert.deepEqual(pairLinkIntent(LINK), { valid: true, address: "https://seira.example.com", secret: CODE });
  assert.deepEqual(pairLinkIntent("seira://pair?address=http%3A%2F%2F192.168.1.20%3A8799"), { valid: true, address: "http://192.168.1.20:8799", secret: null });
  const token = `seira_pair_${"a".repeat(43)}`;
  assert.deepEqual(pairLinkIntent(`seira://pair?address=https%3A%2F%2Fmini.example&token=${token}&name=mini`), { valid: true, address: "https://mini.example", secret: token });
  assert.deepEqual(pairLinkIntent("SEIRA://pair?address=https%3A%2F%2Fseira.example.com"), { valid: true, address: "https://seira.example.com", secret: null });
});

test("leaves every other link to its own handler", () => {
  for (const other of ["seira://cloud", "seira://thread/abc", "seira://paired?address=x", "seira://pairing", "https://example.com/seira://pair?address=x", "", undefined, 7]) {
    assert.equal(pairLinkIntent(other), null);
  }
});

test("a pair link that is not exactly the action is invalid, never repaired", () => {
  const address = "address=https%3A%2F%2Fseira.example.com";
  for (const bad of [
    "seira://pair",
    "seira://pair?",
    `seira://pair?code=${CODE}`,
    "seira://pair?address=seira.example.com",
    "seira://pair?address=ftp%3A%2F%2Fseira.example.com",
    "seira://pair?address=javascript%3Aalert(1)",
    `seira://pair?${address}&${address}`,
    `seira://pair?${address}&code=${CODE}&code=${CODE}`,
    `seira://pair?${address}&code=${CODE}&token=seira_pair_x`,
    `seira://pair?${address}&redirect=https%3A%2F%2Fevil.example`,
    `seira://pair/extra?${address}`,
    `seira://user@pair?${address}`,
    `seira://pair:80?${address}`,
    `seira://pair?${address}#more`,
    `seira://pair?${address}&code=${"A".repeat(300)}`,
    `seira://pair?${address}&x=${"a".repeat(3000)}`,
    `seira://pair?${address}\nseira://pair?${address}`,
    `seira://pair?${address} `.replace(" ", "\u0000"),
  ]) assert.deepEqual(pairLinkIntent(bad), { valid: false }, bad);
});

test("takes the link out of a command line so a relaunch does not open it again", () => {
  const argv = ["app", "--flag", LINK, "seira://pair?address=bad"];
  assert.deepEqual(pairLinkFromCommandLine(argv), { valid: false });
  assert.deepEqual(argv, ["app", "--flag"]);
  assert.equal(pairLinkFromCommandLine(["app"]), null);
  const one = ["app", LINK];
  assert.equal(pairLinkFromCommandLine(one).address, "https://seira.example.com");
  assert.deepEqual(one, ["app"]);
});

function connectWith({ fetch, answers = [true], log = [] } = {}) {
  const events = [];
  const connect = createServerConnect({
    fetch: async (url, options) => { events.push(["fetch", String(url), options.redirect]); return fetch(url); },
    ownEnvironmentId: async () => null,
    ask: async () => { events.push(["ask"]); return true; },
    open: (found) => events.push(["open", found.origin, found.code]),
    t: (key) => key,
  });
  const confirm = async (shown) => { events.push(["confirm", shown]); return answers.shift() ?? false; };
  return { connect: { connectFromLink: (link) => connect.connectFromLink(link, confirm) }, events, log };
}
const descriptor = () => new Response(JSON.stringify({ environmentId: "env-a", label: "mini" }), { headers: { "content-type": "application/json" } });

test("asks about the normalized origin before any network request, then opens the pairing page once", async () => {
  const { connect, events } = connectWith({ fetch: descriptor });
  assert.equal(await connect.connectFromLink({ address: "HTTPS://Seira.Example.com:443/", secret: CODE }), true);
  assert.deepEqual(events.map((event) => event[0]), ["confirm", "fetch", "open"]);
  assert.deepEqual(events[0], ["confirm", { origin: "https://seira.example.com", withSecret: true }]);
  assert.equal(events[1][2], "error");
  assert.deepEqual(events[2], ["open", "https://seira.example.com", CODE]);
});

test("a declined question makes no request and saves nothing", async () => {
  const { connect, events } = connectWith({ fetch: descriptor, answers: [false] });
  assert.equal(await connect.connectFromLink({ address: "https://seira.example.com", secret: CODE }), false);
  assert.deepEqual(events.map((event) => event[0]), ["confirm"]);
});

test("a link that names no clear origin is refused before the question and before any request", async () => {
  const { connect, events } = connectWith({ fetch: descriptor });
  for (const address of ["seira.example.com", "http://203.0.113.9", "https://user:pw@seira.example.com", "https://seira.example.com/other"]) {
    await assert.rejects(connect.connectFromLink({ address, secret: CODE }), { message: "native.connect.notAnAddress" });
  }
  assert.deepEqual(events, []);
});

test("a server that fails or redirects is never opened, and the error does not repeat the code", async () => {
  const redirected = connectWith({ fetch: async () => { throw new TypeError("redirect mode is set to error"); } });
  await assert.rejects(redirected.connect.connectFromLink({ address: "https://seira.example.com", secret: CODE }), (error) => !String(error.message).includes(CODE));
  assert.deepEqual(redirected.events.map((event) => event[0]), ["confirm", "fetch"]);
  const stranger = connectWith({ fetch: async () => new Response("<html>") });
  await assert.rejects(stranger.connect.connectFromLink({ address: "https://seira.example.com", secret: null }), { message: "native.connect.notSeira" });
  assert.equal(stranger.events.some((event) => event[0] === "open"), false);
});

function pairLinks(overrides = {}) {
  const calls = [];
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const links = createPairLinks({
    ready, reveal: () => calls.push("reveal"),
    connect: async (link) => { calls.push(["connect", link.address]); await overrides.hold; return overrides.result ?? true; },
    fail: async (error) => { calls.push(["fail", error.message]); },
    ...overrides.deps,
  });
  return { links, calls, release };
}

test("a link that arrives before the app is ready waits, and is asked about once", async () => {
  const { links, calls, release } = pairLinks();
  assert.equal(links.fromUrl(LINK), true);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  release();
  await links.idle();
  assert.deepEqual(calls, ["reveal", ["connect", "https://seira.example.com"]]);
});

test("a second link while one is open is dropped, so a page cannot stack dialogs", async () => {
  let open;
  const hold = new Promise((resolve) => { open = resolve; });
  const { links, calls, release } = pairLinks({ hold });
  release();
  links.fromUrl(LINK);
  assert.equal(links.fromUrl(LINK), true);
  assert.equal(links.fromArgs(["app", LINK]), true);
  open();
  await links.idle();
  assert.equal(calls.filter((call) => call[0] === "connect").length, 1);
});

test("an invalid link shows one fixed sentence that carries nothing from the link", async () => {
  const { links, calls, release } = pairLinks({ deps: { invalid: () => new Error("fixed sentence") } });
  release();
  assert.equal(links.fromUrl(`seira://pair?address=ftp%3A%2F%2Fevil.example&code=${CODE}`), true);
  await links.idle();
  assert.deepEqual(calls, ["reveal", ["fail", "fixed sentence"]]);
});

test("a link for another handler is not claimed", () => {
  const { links, calls } = pairLinks();
  assert.equal(links.fromUrl("seira://cloud"), false);
  assert.equal(links.fromArgs(["app", "seira://thread/abc"]), false);
  assert.deepEqual(calls, []);
});

test("main's dialogs: Cancel is the default, the question names the normalized origin, and a launch link leaves argv", async () => {
  const shown = [];
  const dialog = { showMessageBox: async (options) => { shown.push(options); return { response: 1 }; } };
  const argv = ["app", LINK];
  let connected = 0;
  const links = installPairLinks({ dialog, t: (key, params) => `${key}${params?.host ? `|${params.host}` : ""}`, argv, reveal: () => {},
    connect: async (link, confirm) => { connected++; return confirm({ origin: new URL(link.address).origin, withSecret: Boolean(link.secret) }); } });
  assert.deepEqual(argv, ["app"]);
  links.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connected, 1);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].defaultId, 1);
  assert.equal(shown[0].message, "native.dialog.connect.title|https://seira.example.com");
  assert.equal(shown[0].detail, "native.dialog.connect.withCode");
  assert.equal(JSON.stringify(shown).includes(CODE), false);
  assert.equal(links.fromUrl("seira://pair?address=ftp%3A%2F%2Fx"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.at(-1).type, "info");
  assert.equal(JSON.stringify(shown).includes("ftp"), false);
});
