// Electron binds safeStorage to the app name when the process starts: on Linux the Secret Service or KWallet item and on
// macOS the Keychain item carry that name. A secret that the earlier name encrypted opens only in a process that starts
// under that name, so a short reader process of this same app opens the copied secrets, and this process encrypts them
// again under the current name. Windows keeps its key in `Local State` inside the copied folder and needs no reader.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";
import { SETTINGS_MOVE_RECEIPT, settingsFolderChoice } from "./settings-folder.mjs";

export const OLD_KEY_READER = "--seira-read-old-key";
const ANSWER = "seira-old-key:";
const MAX_ATTEMPTS = 3;
const MAX_SECRET_BYTES = 1024 * 1024;

const textOf = decrypted => (typeof decrypted === "string" ? decrypted : decrypted?.result);
function json(text) {
  if (typeof text !== "string") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Top-level files that safeStorage wrote: `.bin`, small, with its "v10" or "v11" prefix. Every store keeps JSON in them. */
export function secretFiles(userData, fsApi = fs) {
  const names = [];
  for (const entry of fsApi.readdirSync(userData, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".bin")) continue;
    const file = path.join(userData, entry.name);
    if (fsApi.statSync(file).size > MAX_SECRET_BYTES) continue;
    const data = fsApi.readFileSync(file);
    if (/^v1\d$/.test(data.subarray(0, 3).toString("latin1"))) names.push(entry.name);
  }
  return names.sort();
}

/**
 * Encrypts again, under the current name, each copied secret that the current key cannot open. A secret that neither key
 * opens stays as it is, and its store asks the person to sign in again. The reader runs at most three starts.
 */
export async function moveCopiedSecrets({ userData, encryption, readOld, fsApi = fs, log = () => {} }) {
  const receiptFile = path.join(userData, SETTINGS_MOVE_RECEIPT);
  let receipt;
  try {
    receipt = JSON.parse(fsApi.readFileSync(receiptFile, "utf8"));
  } catch {
    return { status: "none" };
  }
  if (receipt?.keys !== "pending") return { status: "none" };
  if (!(await encryption.available())) {
    log("saved keys: the key store is not available yet; a later start moves the copied secrets");
    return { status: "pending" };
  }

  const waiting = [];
  for (const name of secretFiles(userData, fsApi)) {
    const data = fsApi.readFileSync(path.join(userData, name));
    let opened = false;
    try {
      opened = json(textOf(await encryption.decrypt(data)));
    } catch {}
    if (!opened) waiting.push({ name, data });
  }

  const failed = [];
  const replaced = new Map();
  if (waiting.length) {
    let texts = {};
    try {
      texts = await readOld(waiting);
    } catch (error) {
      log(`saved keys: the earlier key could not be read (${error?.message ?? error})`);
    }
    for (const { name, data } of waiting) {
      const text = texts?.[name];
      if (!json(text)) {
        failed.push(name);
        continue;
      }
      const file = path.join(userData, name);
      const temporary = `${file}.${process.pid}.tmp`;
      const encrypted = await encryption.encrypt(text);
      fsApi.writeFileSync(temporary, encrypted, { mode: 0o600 });
      fsApi.renameSync(temporary, file);
      replaced.set(Buffer.from(data).toString("base64"), encrypted);
    }
  }

  const attempts = (Number(receipt.attempts) || 0) + (failed.length ? 1 : 0);
  const keys = failed.length === 0 ? "done" : attempts >= MAX_ATTEMPTS ? "unreadable" : "pending";
  const temporary = `${receiptFile}.${process.pid}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify({ ...receipt, keys, attempts })}\n`, { mode: 0o600 });
  fsApi.renameSync(temporary, receiptFile);
  log(`saved keys: ${waiting.length - failed.length} moved to the current name, ${failed.length} unreadable (${keys})`);
  return { status: keys, moved: waiting.length - failed.length, failed, replaced };
}

/** Chromium switches the reader needs to pick the same key store and sandbox as this process. */
export function readerSwitches(commandLine) {
  const switches = [];
  const store = commandLine.getSwitchValue("password-store");
  if (store) switches.push(`--password-store=${store}`);
  if (commandLine.hasSwitch("no-sandbox")) switches.push("--no-sandbox");
  return switches;
}

/**
 * True when this process is a direct child of the same app binary. The reader opens secrets of the earlier name, so it
 * answers only the app that started it, never another program that starts the binary with the reader switch.
 */
export function startedByThisApp({ platform = process.platform, ppid = process.ppid, execPath = process.execPath, fsApi = fs, run = execFileSync } = {}) {
  try {
    const self = fsApi.realpathSync(execPath);
    if (platform === "linux") return fsApi.realpathSync(`/proc/${ppid}/exe`) === self;
    if (platform === "darwin") return fsApi.realpathSync(run("/bin/ps", ["-o", "comm=", "-p", String(ppid)], { encoding: "utf8" }).trim()) === self;
  } catch {}
  return false;
}

/** Starts this app as the reader and returns the opened texts by file name. Ciphertext goes in by file, text comes back by pipe. */
export function oldKeyReader({ execPath = process.execPath, appArgs = [], switches = [], spawnImpl = spawn, fsApi = fs, tmp = os.tmpdir(),
  timeoutMs = 30_000, platform = process.platform } = {}) {
  // The copied `Local State` keeps the Windows key; a reader under another name has no key at all.
  if (platform === "win32") return async () => ({});
  return async files => {
    const work = fsApi.mkdtempSync(path.join(tmp, "seira-old-key-"));
    try {
      const input = path.join(work, "secrets.json");
      fsApi.writeFileSync(input, JSON.stringify(files.map(({ name, data }) => ({ name, data: Buffer.from(data).toString("base64") }))), { mode: 0o600 });
      const output = await new Promise((resolve, reject) => {
        const child = spawnImpl(execPath, [...appArgs, ...switches, `${OLD_KEY_READER}=${input}`], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let text = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("the reader did not answer in time"));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", chunk => { text += chunk; });
        child.on("error", error => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(text);
        });
      });
      const line = output.split("\n").find(entry => entry.startsWith(ANSWER));
      if (!line) throw new Error("the reader gave no answer");
      return JSON.parse(Buffer.from(line.slice(ANSWER.length), "base64").toString("utf8"));
    } finally {
      fsApi.rmSync(work, { recursive: true, force: true });
    }
  };
}

/**
 * Returns the decrypt that every saved-key store uses. It waits until secrets copied from the earlier settings folder are
 * encrypted again under the current name. A store can read a file before it calls decrypt, so a copied ciphertext that
 * was encrypted again is opened from its replacement.
 */
export function decryptAfterCopiedSecrets({ app, safeStorage, log = () => {}, readOld = null }) {
  const copied = app.whenReady().then(() => {
    const choice = settingsFolderChoice();
    if (choice?.copied || choice?.reason) log(`settings folder: ${choice.copied ? "copied from the earlier name" : `kept the earlier name (${choice.reason})`}`);
    return moveCopiedSecrets({
      userData: app.getPath("userData"),
      encryption: { available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: value => safeStorage.encryptStringAsync(value),
        decrypt: value => safeStorage.decryptStringAsync(value) },
      readOld: readOld ?? oldKeyReader({ appArgs: app.isPackaged ? [] : [app.getAppPath()], switches: readerSwitches(app.commandLine) }),
      log,
    });
  }).catch(error => log(`saved keys: moving copied secrets failed (${error?.message ?? error})`));
  return async value => {
    const fresh = (await copied)?.replaced?.get(Buffer.from(value).toString("base64"));
    return safeStorage.decryptStringAsync(fresh ?? value);
  };
}

function copyWaitsForKeys(app, fsApi) {
  try {
    return JSON.parse(fsApi.readFileSync(path.join(app.getPath("appData"), app.getName(), SETTINGS_MOVE_RECEIPT), "utf8"))?.keys === "pending";
  } catch {
    return false;
  }
}

/**
 * The reader side: starts under the earlier name in a private profile, opens the given ciphertext, answers once, and
 * exits. It runs only for the app that started it, and only while a copied settings folder still waits for its keys.
 */
export function runOldKeyReader({ app, safeStorage, argv = process.argv, fsApi = fs, trusted = startedByThisApp,
  write = (text, done) => process.stdout.write(text, done) }) {
  const input = argv.find(entry => entry.startsWith(`${OLD_KEY_READER}=`))?.slice(OLD_KEY_READER.length + 1);
  if (!input || !trusted() || !copyWaitsForKeys(app, fsApi)) {
    app.exit(2);
    return;
  }
  app.setName(LEGACY_APP_NAME);
  app.setPath("userData", path.join(path.dirname(input), "profile"));
  app.dock?.hide();
  app.whenReady().then(async () => {
    const texts = {};
    for (const { name, data } of JSON.parse(fsApi.readFileSync(input, "utf8"))) {
      try {
        texts[name] = textOf(await safeStorage.decryptStringAsync(Buffer.from(data, "base64")));
      } catch {}
    }
    write(`${ANSWER}${Buffer.from(JSON.stringify(texts)).toString("base64")}\n`, () => app.exit(0));
  }).catch(() => app.exit(1));
}
