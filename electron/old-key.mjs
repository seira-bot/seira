// Electron binds safeStorage to the app name when the process starts: on Linux the Secret Service or KWallet item and on
// macOS the Keychain item carry that name. A secret that the earlier name encrypted opens only in a process that starts
// under that name, so a short reader process of this same app opens the copied secrets, and this process encrypts them
// again under the current name. Windows keeps its key in `Local State` inside the copied folder and needs no reader.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LEGACY_APP_NAME } from "./legacy-names.mjs";
import { SETTINGS_MOVE_RECEIPT } from "./settings-folder.mjs";

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
  if (waiting.length) {
    let texts = {};
    try {
      texts = await readOld(waiting);
    } catch (error) {
      log(`saved keys: the earlier key could not be read (${error?.message ?? error})`);
    }
    for (const { name } of waiting) {
      const text = texts?.[name];
      if (!json(text)) {
        failed.push(name);
        continue;
      }
      const file = path.join(userData, name);
      const temporary = `${file}.${process.pid}.tmp`;
      fsApi.writeFileSync(temporary, await encryption.encrypt(text), { mode: 0o600 });
      fsApi.renameSync(temporary, file);
    }
  }

  const attempts = (Number(receipt.attempts) || 0) + (failed.length ? 1 : 0);
  const keys = failed.length === 0 ? "done" : attempts >= MAX_ATTEMPTS ? "unreadable" : "pending";
  const temporary = `${receiptFile}.${process.pid}.tmp`;
  fsApi.writeFileSync(temporary, `${JSON.stringify({ ...receipt, keys, attempts })}\n`, { mode: 0o600 });
  fsApi.renameSync(temporary, receiptFile);
  log(`saved keys: ${waiting.length - failed.length} moved to the current name, ${failed.length} unreadable (${keys})`);
  return { status: keys, moved: waiting.length - failed.length, failed };
}

/** Chromium switches the reader needs to pick the same key store and sandbox as this process. */
export function readerSwitches(commandLine) {
  const switches = [];
  const store = commandLine.getSwitchValue("password-store");
  if (store) switches.push(`--password-store=${store}`);
  if (commandLine.hasSwitch("no-sandbox")) switches.push("--no-sandbox");
  return switches;
}

/** Starts this app as the reader and returns the opened texts by file name. Ciphertext goes in by file, text comes back by pipe. */
export function oldKeyReader({ execPath = process.execPath, appArgs = [], switches = [], spawnImpl = spawn, fsApi = fs, tmp = os.tmpdir(),
  timeoutMs = 30_000 } = {}) {
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

/** The reader side: starts under the earlier name in a private profile, opens the given ciphertext, answers once, and exits. */
export function runOldKeyReader({ app, safeStorage, argv = process.argv, fsApi = fs, write = (text, done) => process.stdout.write(text, done) }) {
  const input = argv.find(entry => entry.startsWith(`${OLD_KEY_READER}=`))?.slice(OLD_KEY_READER.length + 1);
  if (!input) {
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
