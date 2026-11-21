// Host keys that a server announces must never reach the private-key parsers of ssh2, whose old PEM pattern backtracks.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
