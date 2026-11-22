// Host keys that a server announces must never reach the private-key parsers of ssh2. The old PEM reader must take linear
// time, and an encrypted old PEM key must never be opened with the MD5 key derivation of that format.
import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { Client, Server, utils } = require("./vendor/ssh2.cjs");

const GLOBAL_REQUEST = 80;

function sshString(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function pem(type, options) {
  return generateKeyPairSync(type, { ...options, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
}

async function connected(hostKey) {
  const server = new Server({ hostKeys: [hostKey] }, (conn) => {
    conn.on("authentication", (ctx) => ctx.accept()).on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once("ready", resolve).once("error", reject).connect({
      host: "127.0.0.1", port: server.address().port, username: "alice", password: "secret", hostVerifier: () => true,
    });
  });
  return { client, close: () => { client.end(); server.close(); } };
}

function announce(client, keys) {
  const proto = client._protocol;
  const original = proto._handlers.GLOBAL_REQUEST;
  const seen = [];
  proto._handlers.GLOBAL_REQUEST = (_proto, name, _wantReply, data) => seen.push({ name, data });
  try {
    proto._onPayload(Buffer.concat([Buffer.from([GLOBAL_REQUEST]), sshString("hostkeys-00@openssh.com"), Buffer.from([0]), ...keys.map(sshString)]));
  } finally {
    proto._handlers.GLOBAL_REQUEST = original;
  }
  return seen;
}

test("keeps a wire-format host key that the server announces and drops PEM key text", async () => {
  const hostKey = pem("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  const ecText = pem("ec", { namedCurve: "prime256v1", privateKeyEncoding: { type: "sec1", format: "pem" } });
  assert.equal(utils.parseKey(ecText).type, "ecdsa-sha2-nistp256");
  const wire = utils.parseKey(hostKey).getPublicSSH();
  const { client, close } = await connected(hostKey);
  try {
    const seen = announce(client, [wire, ecText, `-----BEGIN RSA PRIVATE KEY-----\n${"a:b\n".repeat(4000)}`]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "hostkeys-00@openssh.com");
    assert.deepEqual(seen[0].data.map((key) => key.type), ["ssh-rsa"]);
    assert.deepEqual(seen[0].data[0].getPublicSSH(), wire);
  } finally {
    close();
  }
});

test("drops a host key blob whose type length runs past its end", async () => {
  const hostKey = pem("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" } });
  const { client, close } = await connected(hostKey);
  try {
    const tiny = Buffer.from([0, 0, 1]);
    const short = Buffer.from([0, 0, 0, 1]);
    const overrun = Buffer.concat([Buffer.from([0, 0, 0, 200]), Buffer.from("ssh-rsa")]);
    const seen = announce(client, [tiny, short, overrun]);
    assert.deepEqual(seen[0].data, []);
  } finally {
    close();
  }
});

function oldPem(type, options, cipher) {
  const encoding = type === "rsa" ? "pkcs1" : "sec1";
  const plain = pem(type, { ...options, privateKeyEncoding: { type: encoding, format: "pem" } });
  return { plain, encrypted: createPrivateKey(plain).export({ type: encoding, format: "pem", cipher, passphrase: "pw" }) };
}

test("reads a long old PEM header block in linear time", () => {
  const input = `-----BEGIN EC PRIVATE KEY-----\n${"9:\n".repeat(20_000)}`;
  const started = performance.now();
  const parsed = utils.parseKey(input);
  const elapsed = performance.now() - started;
  assert.ok(parsed instanceof Error);
  assert.ok(elapsed < 50, `took ${elapsed.toFixed(1)} ms`);
});

test("reads a plain old RSA and EC PEM key with LF or CRLF lines and a trailing line break", () => {
  for (const [type, options, sshType] of [["rsa", { modulusLength: 2048 }, "ssh-rsa"], ["ec", { namedCurve: "prime256v1" }, "ecdsa-sha2-nistp256"]]) {
    const { plain } = oldPem(type, options, "aes-128-cbc");
    for (const text of [plain, plain.trim(), plain.replaceAll("\n", "\r\n")]) {
      const parsed = utils.parseKey(text);
      assert.equal(parsed.type, sshType);
      assert.equal(parsed.isPrivateKey(), true);
    }
  }
});

test("refuses an encrypted old PEM key instead of opening it, with or without a passphrase", () => {
  const { encrypted } = oldPem("rsa", { modulusLength: 2048 }, "aes-128-cbc");
  assert.match(utils.parseKey(encrypted, "pw").message, /not supported/);
  assert.match(utils.parseKey(encrypted).message, /no passphrase given/);
});

test("still reads an old DSA PEM header, and keys in the new OpenSSH format with and without a passphrase", () => {
  const dsa = "-----BEGIN DSA PRIVATE KEY-----\nAAAA\n-----END DSA PRIVATE KEY-----";
  assert.match(utils.parseKey(dsa).message, /Malformed OpenSSH private key/);
  const plain = utils.generateKeyPairSync("ecdsa", { bits: 256 });
  assert.equal(utils.parseKey(plain.private).type, "ecdsa-sha2-nistp256");
  const locked = utils.generateKeyPairSync("ecdsa", { bits: 256, passphrase: "pw", cipher: "aes256-ctr", rounds: 16 });
  assert.equal(utils.parseKey(locked.private, "pw").type, "ecdsa-sha2-nistp256");
  assert.ok(utils.parseKey(locked.private) instanceof Error);
});
