import assert from "node:assert/strict";
import test from "node:test";

import { createPairLinks, isPlainOriginText, pairLinkFromCommandLine, pairLinkIntent } from "./pair-link.mjs";
import { installPairLinks } from "./pair-link-main.mjs";
import { createServerConnect } from "./server-probe.mjs";

const CODE = "7KQ2-M9XD-H4TP";
const LINK = `seira://pair?address=${encodeURIComponent("https://seira.example.com")}`;
const WITH_CODE = `${LINK}&code=${CODE}`;

test("reads the link a server's Open in app button makes, and nothing else", () => {
  assert.deepEqual(pairLinkIntent(LINK), { valid: true, address: "https://seira.example.com" });
  assert.deepEqual(pairLinkIntent("seira://pair?address=http%3A%2F%2F192.168.1.20%3A8799"), { valid: true, address: "http://192.168.1.20:8799" });
  assert.deepEqual(pairLinkIntent("seira://pair?address=https%3A%2F%2Fmini.example&name=mini"), { valid: true, address: "https://mini.example" });
  assert.deepEqual(pairLinkIntent("SEIRA://pair?address=https%3A%2F%2Fseira.example.com"), { valid: true, address: "https://seira.example.com" });
  assert.equal("secret" in pairLinkIntent(LINK), false);
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
    `seira://pair?${address}&code=${CODE}`,
    `seira://pair?${address}&token=seira_pair_${"a".repeat(43)}`,
    "seira://pair?address=seira.example.com",
    "seira://pair?address=ftp%3A%2F%2Fseira.example.com",
    "seira://pair?address=javascript%3Aalert(1)",
    `seira://pair?${address}&${address}`,
    `seira://pair?${address}&redirect=https%3A%2F%2Fevil.example`,
    `seira://pair/extra?${address}`,
    `seira://user@pair?${address}`,
    `seira://pair:80?${address}`,
    `seira://pair?${address}#more`,
    `seira://pair?${address}#`,
    `seira://pair?${address}&name=x#`,
    `seira://pair#?${address}`,
    "seira://pair?address=https%3A%2F%2Fseira.example.com%2F.",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%2F%2F",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%2F%2e",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%2Fx",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%3F",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%23",
    "seira://pair?address=https%3A%2F%2Fuser%40seira.example.com",
    "seira://pair?address=https%3A%2F%2F",
    "seira://pair?address=https%3A%2F%2Fseira.example.com%5C",
    `seira://pair?${address}&x=${"a".repeat(3000)}`,
    `seira://pair?${address}\nseira://pair?${address}`,
    `seira://pair?${address} `.replace(" ", "\u0000"),
  ]) assert.deepEqual(pairLinkIntent(bad), { valid: false }, bad);
});

test("a control character that the link only spells (percent-encoded) is refused in the decoded address: C0, DEL and C1, at any place", () => {
  const origin = "https%3A%2F%2Fseira.example.com";
  const controls = ["%00", "%01", "%08", "%09", "%0A", "%0D", "%1F", "%7F", "%C2%80", "%C2%85", "%C2%9F"];
  for (const control of controls) {
    for (const bad of [`${origin}${control}`, `${control}${origin}`, `https%3A%2F%2Fseira${control}.example.com`, `${origin}%2F${control}`]) {
      assert.deepEqual(pairLinkIntent(`seira://pair?address=${bad}`), { valid: false }, bad);
    }
  }
  assert.deepEqual(pairLinkIntent(`seira://pair?address=${origin}&name=Mini%0A`), { valid: true, address: "https://seira.example.com" }, "the name is not an address and is not read");
  for (const control of ["\u0000", "\u0009", "\u000a", "\u000d", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f"]) {
    for (const bad of [`https://seira.example.com${control}`, `${control}https://seira.example.com`, `https://seira${control}.example.com/`]) assert.equal(isPlainOriginText(bad), false, JSON.stringify(bad));
  }
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

test("a known pair link leaves the relaunch arguments whatever its length or content, so a secret in it does not come back", () => {
  const long = `${LINK}&name=${"a".repeat(20_000)}`, huge = `${LINK}&name=${"a".repeat(200_000)}`;
  const argv = ["app", WITH_CODE, long, "--x", huge, "seira://user@pair?address=x", `seira://pair?address=https%3A%2F%2Fa.example#${CODE}`];
  assert.deepEqual(pairLinkFromCommandLine(argv), { valid: false });
  assert.deepEqual(argv, ["app", "--x"]);
  assert.equal(JSON.stringify(argv).includes(CODE), false);
  assert.deepEqual(pairLinkFromCommandLine(["app", long]), { valid: false });
});

test("a link that carries a pairing code or token is refused whole, and the code is not kept anywhere", () => {
  for (const key of ["code", "token"]) {
    const intent = pairLinkIntent(`${LINK}&${key}=${CODE}`);
    assert.deepEqual(intent, { valid: false });
    assert.equal(JSON.stringify(intent).includes(CODE), false);
  }
});

test("the origin text is checked as spelled: one scheme, one host, an optional port, at most one slash", () => {
  for (const good of ["https://seira.example.com", "https://seira.example.com/", "HTTP://192.168.1.20:8799", "https://[fd00::1]:8443/", "https://seira.example.com:443/"]) assert.equal(isPlainOriginText(good), true, good);
  for (const bad of ["https://seira.example.com/.", "https://seira.example.com//", "https://seira.example.com/%2e", "https://seira.example.com/a", "https://seira.example.com?", "https://seira.example.com#", "https://u@seira.example.com", "https://", "https:///x", "seira.example.com", "ftp://x.example", "https://a.example\\", "https://a b.example", "", null, 7]) assert.equal(isPlainOriginText(bad), false, String(bad));
});

function connectWith({ fetch, answers = [true], log = [] } = {}) {
  const events = [];
  const connect = createServerConnect({
    fetch: async (url, options) => { events.push(["fetch", String(url), options.redirect, JSON.stringify(options)]); return fetch(url); },
    ownEnvironmentId: async () => null,
    ask: async () => { events.push(["ask"]); return true; },
    open: (found) => events.push(["open", found.origin, found.code ?? "", found.credential ?? ""]),
    t: (key) => key,
  });
  const confirm = async (shown) => { events.push(["confirm", shown]); return answers.shift() ?? false; };
  return { connect: { connectFromLink: (link) => connect.connectFromLink(link, confirm) }, events, log };
}
const descriptor = () => new Response(JSON.stringify({ environmentId: "env-a", label: "mini" }), { headers: { "content-type": "application/json" } });

test("asks about the normalized origin before any network request, then opens the pairing page once, with no code", async () => {
  const { connect, events } = connectWith({ fetch: descriptor });
  assert.equal(await connect.connectFromLink({ address: "HTTPS://Seira.Example.com:443/" }), true);
  assert.deepEqual(events.map((event) => event[0]), ["confirm", "fetch", "open"]);
  assert.deepEqual(events[0], ["confirm", { origin: "https://seira.example.com" }]);
  assert.equal(events[1][2], "error");
  assert.deepEqual(events[2], ["open", "https://seira.example.com", "", ""]);
});

test("a declined question makes no request and saves nothing", async () => {
  const { connect, events } = connectWith({ fetch: descriptor, answers: [false] });
  assert.equal(await connect.connectFromLink({ address: "https://seira.example.com" }), false);
  assert.deepEqual(events.map((event) => event[0]), ["confirm"]);
});

test("a link that names no clear origin is refused before the question and before any request", async () => {
  const { connect, events } = connectWith({ fetch: descriptor });
  for (const address of ["seira.example.com", "http://203.0.113.9", "https://user:pw@seira.example.com", "https://seira.example.com/other", "https://seira.example.com/.", "https://seira.example.com//", "https://seira.example.com/%2e", "https://seira.example.com#", "https://seira.example.com?"]) {
    await assert.rejects(connect.connectFromLink({ address }), { message: "native.connect.notAnAddress" }, address);
  }
  assert.deepEqual(events, []);
});

test("an address with a control character is refused before the question and before any request, whatever reaches the connect step", async () => {
  const { connect, events } = connectWith({ fetch: descriptor });
  for (const control of ["\u0000", "\u0009", "\u000a", "\u007f", "\u0085"]) {
    for (const address of [`https://seira.example.com${control}`, `https://seira.example.com/${control}`, `https://seira${control}.example.com`]) {
      await assert.rejects(connect.connectFromLink({ address }), { message: "native.connect.notAnAddress" }, JSON.stringify(address));
    }
  }
  assert.deepEqual(events, []);
  const decoded = pairLinkIntent("seira://pair?address=https%3A%2F%2Fseira.example.com%0A");
  assert.deepEqual(decoded, { valid: false }, "the link itself never reaches the connect step");
});

test("a server that fails or redirects is never opened", async () => {
  const redirected = connectWith({ fetch: async () => { throw new TypeError("redirect mode is set to error"); } });
  await assert.rejects(redirected.connect.connectFromLink({ address: "https://seira.example.com" }));
  assert.deepEqual(redirected.events.map((event) => event[0]), ["confirm", "fetch"]);
  const stranger = connectWith({ fetch: async () => new Response("<html>") });
  await assert.rejects(stranger.connect.connectFromLink({ address: "https://seira.example.com" }), { message: "native.connect.notSeira" });
  assert.equal(stranger.events.some((event) => event[0] === "open"), false);
});

test("the handoff stays on the confirmed origin: every request and the page that opens name that origin only, and no code is sent", async () => {
  const link = pairLinkIntent(`${LINK}&name=mini`);
  const { connect, events } = connectWith({ fetch: descriptor });
  assert.equal(await connect.connectFromLink({ address: link.address }), true);
  const confirmed = events.find((event) => event[0] === "confirm")[1].origin;
  for (const event of events.filter((one) => one[0] === "fetch")) {
    assert.equal(new URL(event[1]).origin, confirmed, "a request left the confirmed origin");
    assert.equal(event[2], "error", "a redirect would be followed");
    assert.equal(event[3].includes("credentials\":\"omit"), true);
  }
  assert.deepEqual(events.filter((event) => event[0] === "open").map((event) => event[1]), [confirmed]);
  assert.equal(JSON.stringify(events).includes(CODE), false);
  // A server that answers with a redirect to another origin gets nothing further: the request fails and no page opens.
  const hop = connectWith({ fetch: async () => { throw new TypeError("redirect mode is set to error"); } });
  await assert.rejects(hop.connect.connectFromLink({ address: link.address }));
  assert.deepEqual(hop.events.filter((event) => event[0] === "fetch").map((event) => new URL(event[1]).origin), [confirmed]);
  assert.equal(hop.events.some((event) => event[0] === "open"), false);
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
    connect: async (link, confirm) => { connected++; return confirm({ origin: new URL(link.address).origin }); } });
  assert.deepEqual(argv, ["app"]);
  links.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connected, 1);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].defaultId, 1);
  assert.equal(shown[0].message, "native.dialog.connect.title|https://seira.example.com");
  assert.equal(shown[0].detail, "native.dialog.connect.noCode");
  assert.equal(JSON.stringify(shown).includes(CODE), false);
  assert.equal(links.fromUrl("seira://pair?address=ftp%3A%2F%2Fx"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.at(-1).type, "info");
  assert.equal(JSON.stringify(shown).includes("ftp"), false);
});
