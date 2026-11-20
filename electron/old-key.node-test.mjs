// Secrets that an earlier app name encrypted are opened by a reader under that name and encrypted again under the current one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";
import { OLD_KEY_READER, decryptAfterCopiedSecrets, moveCopiedSecrets, oldKeyReader, readerSwitches, runOldKeyReader, secretFiles, startedByThisApp } from "./old-key.mjs";
import { SETTINGS_MOVE_RECEIPT } from "./settings-folder.mjs";

function folder(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "seira-old-key-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A fake key store: "v11" + key name + ":" + text. Electron 43 resolves decryptStringAsync to { shouldReEncrypt, result }. */
const sealed = (key, text) => Buffer.from(`v11${key}:${text}`);
function keyStore(key, { available = true } = {}) {
  return {
    available: async () => available,
    encrypt: async text => sealed(key, text),
    decrypt: async data => {
      const text = Buffer.from(data).toString("utf8");
      if (!text.startsWith(`v11${key}:`)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.");
      return { shouldReEncrypt: false, result: text.slice(`v11${key}:`.length) };
    },
  };
}
const oldStore = keyStore("old");
const readWithOldKey = calls => async files => {
  calls.push(files.map(file => file.name));
  const texts = {};
  for (const { name, data } of files) {
    try { texts[name] = (await oldStore.decrypt(data)).result; } catch {}
  }
  return texts;
};
function copied(dir, receipt = { copiedAt: "2026-11-20T00:00:00.000Z", keys: "pending", attempts: 0 }) {
  writeFileSync(path.join(dir, SETTINGS_MOVE_RECEIPT), JSON.stringify(receipt));
  writeFileSync(path.join(dir, "credentials.bin"), sealed("old", '{"openaiApiKey":"sk-test"}'), { mode: 0o600 });
  writeFileSync(path.join(dir, "cloud-account-seira.bin"), sealed("old", '{"token":"t"}'), { mode: 0o600 });
  writeFileSync(path.join(dir, "company-connection.bin"), sealed("new", '{"saved":"after the update"}'), { mode: 0o600 });
  writeFileSync(path.join(dir, "desktop-prefs.json"), "{}");
}
const receiptOf = dir => JSON.parse(readFileSync(path.join(dir, SETTINGS_MOVE_RECEIPT), "utf8"));
const opened = async (dir, name, store = keyStore("new")) => (await store.decrypt(readFileSync(path.join(dir, name)))).result;

test("a copied secret is opened with the earlier name and encrypted again under the current one", async t => {
  const dir = folder(t);
  copied(dir);
  const calls = [];
  const logs = [];
  const { replaced, ...result } = await moveCopiedSecrets({ userData: dir, encryption: keyStore("new"), readOld: readWithOldKey(calls), log: line => logs.push(line) });

  assert.deepEqual(result, { status: "done", moved: 2, failed: [] });
  assert.equal(replaced.size, 2);
  assert.deepEqual(calls, [["cloud-account-seira.bin", "credentials.bin"]], "only secrets the current key cannot open go to the reader");
  assert.equal(await opened(dir, "credentials.bin"), '{"openaiApiKey":"sk-test"}');
  assert.equal(await opened(dir, "cloud-account-seira.bin"), '{"token":"t"}');
  assert.equal(await opened(dir, "company-connection.bin"), '{"saved":"after the update"}');
  assert.equal(statSync(path.join(dir, "credentials.bin")).mode & 0o777, 0o600);
  assert.equal(receiptOf(dir).keys, "done");
  assert.ok(!readdirSync(dir).some(name => name.endsWith(".tmp")));
  assert.ok(logs.every(line => !line.includes("sk-test")), "the log never holds a secret");

  calls.length = 0;
  assert.deepEqual(await moveCopiedSecrets({ userData: dir, encryption: keyStore("new"), readOld: readWithOldKey(calls) }), { status: "none" });
  assert.deepEqual(calls, [], "a later start starts no reader");
});

test("a new person, or a folder that was not copied, starts no reader", async t => {
  const dir = folder(t);
  writeFileSync(path.join(dir, "credentials.bin"), sealed("old", "{}"));
  const calls = [];
  assert.deepEqual(await moveCopiedSecrets({ userData: dir, encryption: keyStore("new"), readOld: readWithOldKey(calls) }), { status: "none" });
  assert.deepEqual(calls, []);
});

test("when the key store cannot be read, the secrets stay as they are, and after three starts the store asks to sign in again", async t => {
  const dir = folder(t);
  copied(dir);
  const before = readFileSync(path.join(dir, "credentials.bin"));
  const broken = async () => { throw new Error("the reader did not answer in time"); };
  const logs = [];
  const run = () => moveCopiedSecrets({ userData: dir, encryption: keyStore("new"), readOld: broken, log: line => logs.push(line) });

  assert.deepEqual(await run(), { status: "pending", moved: 0, failed: ["cloud-account-seira.bin", "credentials.bin"], replaced: new Map() });
  assert.deepEqual(readFileSync(path.join(dir, "credentials.bin")), before, "the file is left for the store, never removed here");
  assert.equal(receiptOf(dir).attempts, 1);
  assert.match(logs[0], /could not be read/);
  assert.equal((await run()).status, "pending");
  assert.equal((await run()).status, "unreadable");
  assert.deepEqual(await run(), { status: "none" }, "it stops after three starts");
  await assert.rejects(keyStore("new").decrypt(readFileSync(path.join(dir, "credentials.bin"))), /decrypting/,
    "the store gets the decrypt error it already turns into a sign-in request");
});

test("a reader that opens only some secrets moves those, and keeps trying the rest", async t => {
  const dir = folder(t);
  copied(dir);
  const partial = async () => ({ "credentials.bin": '{"openaiApiKey":"sk-test"}', "cloud-account-seira.bin": "not json" });
  const { replaced, ...result } = await moveCopiedSecrets({ userData: dir, encryption: keyStore("new"), readOld: partial });
  assert.deepEqual(result, { status: "pending", moved: 1, failed: ["cloud-account-seira.bin"] });
  assert.deepEqual([...replaced.keys()], [sealed("old", '{"openaiApiKey":"sk-test"}').toString("base64")]);
  assert.equal(await opened(dir, "credentials.bin"), '{"openaiApiKey":"sk-test"}');
});

test("while the key store is not available, nothing is read and no attempt is counted", async t => {
  const dir = folder(t);
  copied(dir);
  const calls = [];
  assert.deepEqual(await moveCopiedSecrets({ userData: dir, encryption: keyStore("new", { available: false }), readOld: readWithOldKey(calls) }), { status: "pending" });
  assert.deepEqual(calls, []);
  assert.equal(receiptOf(dir).attempts, 0);
});

test("a store that read a copied file before the keys moved still opens it after the move", async t => {
  const dir = folder(t);
  copied(dir);
  const store = keyStore("new");
  let ready;
  const app = { whenReady: () => new Promise(resolve => { ready = resolve; }), getPath: () => dir };
  const safeStorage = { isAsyncEncryptionAvailable: store.available, encryptStringAsync: store.encrypt, decryptStringAsync: store.decrypt };
  const decrypt = decryptAfterCopiedSecrets({ app, safeStorage, readOld: readWithOldKey([]) });

  const early = decrypt(readFileSync(path.join(dir, "credentials.bin")));
  ready();
  assert.deepEqual(await early, { shouldReEncrypt: false, result: '{"openaiApiKey":"sk-test"}' });
  assert.equal((await decrypt(readFileSync(path.join(dir, "company-connection.bin")))).result, '{"saved":"after the update"}');
  await assert.rejects(decrypt(sealed("other", "{}")), /decrypting/, "a secret that no key opens still fails for its store");
});

test("only small top-level .bin files with a safeStorage prefix count as secrets", t => {
  const dir = folder(t);
  writeFileSync(path.join(dir, "a.bin"), "v10x");
  writeFileSync(path.join(dir, "b.bin"), "v11x");
  writeFileSync(path.join(dir, "c.bin"), "plain");
  writeFileSync(path.join(dir, "d.json"), "v11x");
  writeFileSync(path.join(dir, "e.bin"), Buffer.concat([Buffer.from("v11"), Buffer.alloc(1024 * 1024 + 1)]));
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "f.bin"), "v11x");
  assert.deepEqual(secretFiles(dir), ["a.bin", "b.bin"]);
});

test("the reader gets the same key store and sandbox switches as this process", () => {
  const commandLine = values => ({ getSwitchValue: name => values[name] ?? "", hasSwitch: name => name in values });
  assert.deepEqual(readerSwitches(commandLine({})), []);
  assert.deepEqual(readerSwitches(commandLine({ "password-store": "kwallet6", "no-sandbox": "" })), ["--password-store=kwallet6", "--no-sandbox"]);
});

test("the reader process answers by pipe, and its input folder is removed", async t => {
  const tmp = folder(t);
  // A stand-in for the app that the reader flag starts: it reads its input file and answers like runOldKeyReader.
  const standIn = `
    const fs = require("node:fs");
    const input = process.argv.find(a => a.startsWith(${JSON.stringify(`${OLD_KEY_READER}=`)})).slice(${OLD_KEY_READER.length + 1});
    const texts = {};
    for (const { name, data } of JSON.parse(fs.readFileSync(input, "utf8"))) texts[name] = Buffer.from(data, "base64").toString("utf8").replace(/^v11old:/, "");
    process.stderr.write("noise from Chromium\\n");
    process.stdout.write("other line\\nseira-old-key:" + Buffer.from(JSON.stringify(texts)).toString("base64") + "\\n");
  `;
  const read = oldKeyReader({ execPath: process.execPath, appArgs: ["-e", standIn, "--"], tmp });
  assert.deepEqual(await read([{ name: "credentials.bin", data: sealed("old", '{"k":1}') }]), { "credentials.bin": '{"k":1}' });
  assert.deepEqual(readdirSync(tmp), [], "the ciphertext file and the reader profile are gone");

  const silent = oldKeyReader({ execPath: process.execPath, appArgs: ["-e", "", "--"], tmp });
  await assert.rejects(silent([{ name: "a.bin", data: Buffer.from("v11") }]), /no answer/);
  const slow = oldKeyReader({ execPath: process.execPath, appArgs: ["-e", "setTimeout(() => {}, 60000)", "--"], tmp, timeoutMs: 200 });
  await assert.rejects(slow([{ name: "a.bin", data: Buffer.from("v11") }]), /in time/);
  assert.deepEqual(readdirSync(tmp), []);
});

/** A fake Electron app whose settings folder holds a receipt with the given key state. */
function readerApp(dir, keys = "pending") {
  const appData = path.join(dir, "appData");
  mkdirSync(path.join(appData, "Seira"), { recursive: true });
  if (keys) writeFileSync(path.join(appData, "Seira", SETTINGS_MOVE_RECEIPT), JSON.stringify({ keys }));
  const steps = [];
  let ready;
  const app = {
    getName: () => "Seira",
    getPath: key => { assert.equal(key, "appData"); return appData; },
    setName: name => steps.push(`name ${name}`),
    setPath: (key, value) => steps.push(`path ${key} ${value}`),
    whenReady: () => new Promise(resolve => { ready = resolve; }),
    exit: code => steps.push(`exit ${code}`),
  };
  return { app, steps, ready: () => ready() };
}

test("the reader starts under the earlier name in a private profile, before the app is ready", async t => {
  const dir = folder(t);
  const input = path.join(dir, "secrets.json");
  writeFileSync(input, JSON.stringify([{ name: "credentials.bin", data: sealed("old", '{"k":1}').toString("base64") }, { name: "x.bin", data: Buffer.from("v11other:1").toString("base64") }]));
  const { app, steps, ready } = readerApp(dir);
  const safeStorage = { decryptStringAsync: async data => {
    assert.ok(steps.includes(`name ${LEGACY_APP_NAME}`));
    return oldStore.decrypt(data);
  } };
  let answer = "";
  runOldKeyReader({ app, safeStorage, argv: ["seira", `${OLD_KEY_READER}=${input}`], trusted: () => true, write: (text, done) => { answer += text; done(); } });
  assert.deepEqual(steps, [`name ${LEGACY_APP_NAME}`, `path userData ${path.join(dir, "profile")}`]);
  ready();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(steps.at(-1), "exit 0");
  const texts = JSON.parse(Buffer.from(answer.trim().slice("seira-old-key:".length), "base64").toString("utf8"));
  assert.deepEqual(texts, { "credentials.bin": '{"k":1}' });
});

test("the reader opens nothing for another program, or when no copied folder waits for its keys", t => {
  const dir = folder(t);
  const input = path.join(dir, "secrets.json");
  writeFileSync(input, "[]");
  const safeStorage = { decryptStringAsync: async () => assert.fail("nothing is opened") };
  const write = () => assert.fail("nothing is answered");
  for (const [label, keys, trusted] of [["another program", "pending", false], ["keys already moved", "done", true], ["no copy", null, true]]) {
    const { app, steps } = readerApp(folder(t), keys);
    runOldKeyReader({ app, safeStorage, argv: ["seira", `${OLD_KEY_READER}=${input}`], trusted: () => trusted, write });
    assert.deepEqual(steps, ["exit 2"], label);
  }
});

test("the reader trusts only a parent that runs the same app binary", () => {
  const links = { "/opt/Seira/seira": "/opt/Seira/seira", "/usr/bin/seira": "/opt/Seira/seira", "/proc/10/exe": "/opt/Seira/seira", "/proc/11/exe": "/usr/bin/python3" };
  const fsApi = { realpathSync: file => {
    if (!(file in links)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
    return links[file];
  } };
  const check = options => startedByThisApp({ platform: "linux", execPath: "/usr/bin/seira", fsApi, ...options });
  assert.equal(check({ ppid: 10 }), true);
  assert.equal(check({ ppid: 11 }), false, "another program");
  assert.equal(check({ ppid: 12 }), false, "a parent that cannot be checked");
  assert.equal(startedByThisApp({ platform: "darwin", ppid: 10, execPath: "/usr/bin/seira", fsApi, run: () => "/opt/Seira/seira\n" }), true);
  assert.equal(startedByThisApp({ platform: "darwin", ppid: 10, execPath: "/usr/bin/seira", fsApi, run: () => { throw new Error("no ps"); } }), false);
  assert.equal(startedByThisApp({ platform: "win32", ppid: 10, execPath: "/usr/bin/seira", fsApi }), false);
});

test("on Linux, a direct child of the same binary passes and a child of a shell does not", { skip: process.platform !== "linux" }, () => {
  const probe = `import { startedByThisApp } from ${JSON.stringify(new URL("./old-key.mjs", import.meta.url).href)}; console.log(startedByThisApp());`;
  const direct = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(direct.stdout.trim(), "true", direct.stderr);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const viaShell = spawnSync("/bin/sh", ["-c", `${quote(process.execPath)} --input-type=module -e ${quote(probe)}; true`], { encoding: "utf8" });
  assert.equal(viaShell.stdout.trim(), "false", viaShell.stderr);
});

test("on Windows no reader starts: the copied folder keeps its own key", async () => {
  const read = oldKeyReader({ platform: "win32", spawnImpl: () => assert.fail("no reader on Windows") });
  assert.deepEqual(await read([{ name: "credentials.bin", data: Buffer.from("v10x") }]), {});
});
