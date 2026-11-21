import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSavedHosts, fingerprint, hostKeyStatus, hostLabel, keyType, parseKnownHosts, preferredHostKeyAlgorithms } from "./vps-install-hosts.mjs";

const blob = (type, body) => { const name = Buffer.from(type); const head = Buffer.alloc(4); head.writeUInt32BE(name.length); return Buffer.concat([head, name, body]); };
const edKey = () => blob("ssh-ed25519", randomBytes(36));
const line = (names, key) => `${names} ${keyType(key)} ${key.toString("base64")}`;

test("the fingerprint is the SHA256 form OpenSSH prints, without padding", () => {
  const key = edKey();
  assert.equal(fingerprint(key), `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=/g, "")}`);
  assert.match(fingerprint(key), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(keyType(key), "ssh-ed25519");
});

test("a plain, a bracketed and a hashed known_hosts line each match their own address", () => {
  const key = edKey();
  const salt = randomBytes(20);
  const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("[203.0.113.9]:2222").digest("base64")}`;
  for (const [names, host, port] of [["203.0.113.9", "203.0.113.9", 22], ["[203.0.113.9]:2222", "203.0.113.9", 2222], [hashed, "203.0.113.9", 2222], ["other.example,203.0.113.9", "203.0.113.9", 22]]) {
    assert.equal(hostKeyStatus({ host, port, key, knownHosts: `${line(names, key)}\n`, saved: [] }), "known", names);
  }
  assert.equal(hostKeyStatus({ host: "203.0.113.10", port: 22, key, knownHosts: line("203.0.113.9", key), saved: [] }), "unknown");
  assert.equal(hostKeyStatus({ host: "203.0.113.9", port: 2222, key, knownHosts: line("203.0.113.9", key), saved: [] }), "unknown");
  assert.equal(hostLabel("Example.COM", 22), "example.com");
  assert.equal(hostLabel("example.com", 2200), "[example.com]:2200");
});

test("another key for a known address is changed, from either source", () => {
  const known = edKey(), other = edKey();
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: other, knownHosts: line("h.example", known), saved: [] }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: other, knownHosts: "", saved: [{ host: "h.example", port: 22, fingerprint: fingerprint(known) }] }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: known, knownHosts: line("h.example", other), saved: [{ host: "h.example", port: 22, fingerprint: fingerprint(known) }] }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: known, knownHosts: "", saved: [{ host: "H.example", port: 22, fingerprint: fingerprint(known) }] }), "known");
});

test("comments, certificate authority lines and unreadable lines are skipped; a revoked key is changed", () => {
  const key = edKey();
  const text = ["# a comment", "", `@cert-authority * ${keyType(key)} ${key.toString("base64")}`, "garbage line", `@revoked h.example ${keyType(key)} ${key.toString("base64")}`].join("\n");
  assert.equal(parseKnownHosts(text).length, 1);
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key, knownHosts: text, saved: [] }), "changed");
});

test("a revoked line counts only for its own key, and an unrelated entry of the same type does not make a known key changed", () => {
  const key = edKey(), other = edKey();
  const revokedOther = `@revoked h.example ${keyType(other)} ${other.toString("base64")}`;
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key, knownHosts: `${revokedOther}\n${line("h.example", key)}`, saved: [] }), "known");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key, knownHosts: revokedOther, saved: [] }), "unknown");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: other, knownHosts: revokedOther, saved: [] }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key, knownHosts: `${line("h.example", other)}\n${line("h.example", key)}`, saved: [] }), "known");
});

test("known_hosts patterns with * ? and ! are matched, and a negation excludes the address", () => {
  const key = edKey(), other = edKey();
  const status = (names, host) => hostKeyStatus({ host, port: 22, key: other, knownHosts: line(names, key), saved: [] });
  assert.equal(status("*.example.com", "vps.example.com"), "changed");
  assert.equal(status("vps-?.example.com", "vps-1.example.com"), "changed");
  assert.equal(status("vps-?.example.com", "vps-12.example.com"), "unknown");
  assert.equal(status("*.example.com,!vps.example.com", "vps.example.com"), "unknown");
  assert.equal(status("*.example.com,!vps.example.com", "web.example.com"), "changed");
  const revoked = `@revoked *.example.com ${keyType(key)} ${key.toString("base64")}`;
  assert.equal(hostKeyStatus({ host: "x.example.com", port: 22, key, knownHosts: revoked, saved: [] }), "changed");
});

test("the algorithms to offer follow the key types the person already trusts", () => {
  assert.deepEqual(preferredHostKeyAlgorithms(["ssh-rsa", "ssh-ed25519"]), ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa", "ssh-ed25519"]);
});

test("the saved list keeps only host, port and fingerprint, in a private file, and replaces an address's earlier entry", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-hosts-"));
  try {
    const saved = createSavedHosts({ dir });
    assert.deepEqual(saved.read(), []);
    saved.remember({ host: "A.example", port: 22, fingerprint: "SHA256:one", extra: "never kept" });
    saved.remember({ host: "a.example", port: 22, fingerprint: "SHA256:two" });
    saved.remember({ host: "b.example", port: 2200, fingerprint: "SHA256:three" });
    assert.deepEqual(saved.read(), [{ host: "a.example", port: 22, fingerprint: "SHA256:two" }, { host: "b.example", port: 2200, fingerprint: "SHA256:three" }]);
    if (process.platform !== "win32") assert.equal(statSync(saved.file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(saved.file, "utf8")).hosts[0]).sort(), ["fingerprint", "host", "port"]);
    writeFileSync(saved.file, "not json");
    assert.deepEqual(saved.read(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a saved entry with a key type matches only that type, and a key of another type for a known address is changed; an old entry without a type still matches any", () => {
  const ed = edKey(), rsa = blob("ssh-rsa", randomBytes(40));
  const typed = [{ host: "h.example", port: 22, fingerprint: fingerprint(ed), type: "ssh-ed25519" }];
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: rsa, knownHosts: "", saved: typed }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: rsa, knownHosts: `${line("h.example", ed)}\n`, saved: [] }), "changed");
  assert.equal(hostKeyStatus({ host: "other.example", port: 22, key: rsa, knownHosts: "", saved: typed }), "unknown");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: ed, knownHosts: "", saved: typed }), "known");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: edKey(), knownHosts: "", saved: typed }), "changed");
  assert.equal(hostKeyStatus({ host: "h.example", port: 22, key: rsa, knownHosts: "", saved: [{ host: "h.example", port: 22, fingerprint: fingerprint(ed) }] }), "changed");
});

test("the saved list keeps the key type, keeps one entry per type, and reads an old entry without one", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "seira-hosts-"));
  try {
    const saved = createSavedHosts({ dir });
    saved.remember({ host: "a.example", port: 22, fingerprint: "SHA256:one", type: "ssh-ed25519" });
    saved.remember({ host: "a.example", port: 22, fingerprint: "SHA256:two", type: "ssh-rsa" });
    saved.remember({ host: "a.example", port: 22, fingerprint: "SHA256:three", type: "ssh-rsa" });
    assert.deepEqual(saved.read(), [{ host: "a.example", port: 22, fingerprint: "SHA256:one", type: "ssh-ed25519" }, { host: "a.example", port: 22, fingerprint: "SHA256:three", type: "ssh-rsa" }]);
    writeFileSync(saved.file, JSON.stringify({ hosts: [{ host: "old.example", port: 22, fingerprint: "SHA256:x" }] }));
    assert.deepEqual(saved.read(), [{ host: "old.example", port: 22, fingerprint: "SHA256:x" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
