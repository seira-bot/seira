// Host keys for the "Install on my server" flow: the fingerprint the person confirms, the person's own known_hosts
// (read only, never written) and the short list this app keeps of servers the person already confirmed.
import { createHmac, createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `SHA256:` and the unpadded base64 digest of the key blob, the way OpenSSH prints it. */
export function fingerprint(keyBlob) {
  return `SHA256:${createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "")}`;
}

/** The wire name of the key ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa") at the start of a key blob. */
export function keyType(keyBlob) {
  if (keyBlob.length < 4) return "";
  const length = keyBlob.readUInt32BE(0);
  return length > 0 && length < 64 && keyBlob.length >= 4 + length ? keyBlob.subarray(4, 4 + length).toString("latin1") : "";
}

/** The name a known_hosts line uses for this address: the bare host on port 22, `[host]:port` on any other. */
export function hostLabel(host, port) {
  const name = host.toLowerCase();
  return port === 22 ? name : `[${name}]:${port}`;
}

const TYPES = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/;

/** The usable lines of a known_hosts file. `@cert-authority` lines are skipped; `@revoked` lines carry `revoked`. */
export function parseKnownHosts(text) {
  const entries = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let fields = line.split(/\s+/);
    let revoked = false;
    if (fields[0].startsWith("@")) {
      if (fields[0] !== "@revoked") continue;
      revoked = true;
      fields = fields.slice(1);
    }
    if (fields.length < 3 || !TYPES.test(fields[1])) continue;
    let blob;
    try { blob = Buffer.from(fields[2], "base64"); } catch { continue; }
    if (!blob.length) continue;
    const hashed = /^\|1\|([^|]+)\|([^|]+)$/.exec(fields[0]);
    entries.push({
      names: hashed ? null : fields[0].split(",").map((name) => name.toLowerCase()),
      salt: hashed ? Buffer.from(hashed[1], "base64") : null,
      digest: hashed ? Buffer.from(hashed[2], "base64") : null,
      type: fields[1], blob, revoked,
    });
  }
  return entries;
}

const patternCache = new Map();
function patternMatches(pattern, label) {
  let regex = patternCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    patternCache.set(pattern, regex);
  }
  return regex.test(label);
}

function entryNames(entry, label) {
  if (entry.names) {
    let positive = false;
    for (const name of entry.names) {
      if (name.startsWith("!")) { if (patternMatches(name.slice(1), label)) return false; }
      else if (name === label || patternMatches(name, label)) positive = true;
    }
    return positive;
  }
  return createHmac("sha1", entry.salt).update(label).digest().equals(entry.digest);
}

/** The key types the person's known_hosts holds for this address, in file order. */
export function knownTypes(entries, host, port) {
  const label = hostLabel(host, port);
  return entries.filter((entry) => entryNames(entry, label)).map((entry) => entry.type);
}

/**
 * `known` when a source holds this key, `changed` when a source holds another key, or none of this key's type, for the
 * address, or lists this exact key as revoked; `unknown` otherwise. One `changed` from either source wins.
 * @param {{ host: string, port: number, key: Buffer, knownHosts: string, saved: { host: string, port: number, fingerprint: string, type?: string }[] }} input
 */
export function hostKeyStatus({ host, port, key, knownHosts, saved }) {
  const seen = fingerprint(key), type = keyType(key), label = hostLabel(host, port);
  let systemHeld = false, systemKnown = false;
  for (const entry of parseKnownHosts(knownHosts)) {
    if (!entryNames(entry, label)) continue;
    if (entry.revoked) { if (entry.blob.equals(key)) return "changed"; continue; }
    systemHeld = true;
    if (entry.type === type && entry.blob.equals(key)) systemKnown = true;
  }
  let savedHeld = false, savedKnown = false;
  for (const item of saved) {
    if (item.host.toLowerCase() !== host.toLowerCase() || item.port !== port) continue;
    savedHeld = true;
    if ((!item.type || item.type === type) && item.fingerprint === seen) savedKnown = true;
  }
  if ((systemHeld && !systemKnown) || (savedHeld && !savedKnown)) return "changed";
  return systemKnown || savedKnown ? "known" : "unknown";
}

/** Which sources hold any key for this address: the person's known_hosts (`system`) and the app's saved list (`saved`). */
export function hostKeySources({ host, port, knownHosts, saved }) {
  const label = hostLabel(host, port);
  return {
    system: parseKnownHosts(knownHosts).some((entry) => entryNames(entry, label)),
    saved: saved.some((item) => item.host.toLowerCase() === host.toLowerCase() && item.port === port),
  };
}

/** The `serverHostKey` list to offer: the types the person already trusts for this address first, so the server answers with one of them. */
export function preferredHostKeyAlgorithms(types) {
  const out = [];
  for (const type of types) {
    for (const name of type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type]) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The app's own list of confirmed servers: `<dataDir>/ssh/install-hosts.json`, mode 600, holding host, port, key type and fingerprint only. */
export function createSavedHosts({ dir }) {
  const file = path.join(dir, "ssh", "install-hosts.json");
  const read = () => {
    try {
      const list = JSON.parse(readFileSync(file, "utf8"))?.hosts;
      return Array.isArray(list) ? list.filter((item) => item && typeof item.host === "string" && Number.isInteger(item.port) && typeof item.fingerprint === "string")
        .map(({ host, port, fingerprint: seen, type }) => ({ host, port, fingerprint: seen, ...(typeof type === "string" && TYPES.test(type) ? { type } : {}) })) : [];
    } catch { return []; }
  };
  const remember = ({ host, port, fingerprint: seen, type }) => {
    const kind = typeof type === "string" && TYPES.test(type) ? type : undefined;
    const rest = read().filter((item) => !(item.host.toLowerCase() === host.toLowerCase() && item.port === port && (!item.type || !kind || item.type === kind)));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ hosts: [...rest, { host: host.toLowerCase(), port, fingerprint: seen, ...(kind ? { type: kind } : {}) }] }, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* a file system without modes */ }
    renameSync(temporary, file);
  };
  const forget = ({ host, port }) => {
    const rest = read().filter((item) => !(item.host.toLowerCase() === host.toLowerCase() && item.port === port));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ hosts: rest }, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* a file system without modes */ }
    renameSync(temporary, file);
  };
  return { file, read, remember, forget };
}
