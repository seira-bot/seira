// Bundle ssh2 into one self-contained file the packaged app can require: it ships no node_modules.
// The optional native speed-ups stay external: ssh2 loads them inside a try block and falls back to pure JavaScript.
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = require.resolve("ssh2");

// ssh2 1.17.0 runs each key that a server sends in hostkeys-00@openssh.com through parseKey, in the Electron main
// process. These keys are SSH wire-format blobs, so the patched handler reads them only with the wire-format parser.
const HOSTKEYS_PATCH = [
  [
    "const {\n  parseKey,\n} = require('./keyParser.js');",
    `const {
  parseDERKey,
} = require('./keyParser.js');

function parseHostKeyBlob(blob) {
  if (blob.length < 4)
    return new Error('Malformed host key');
  const typeEnd = 4 + blob.readUInt32BE(0);
  if (typeEnd > blob.length)
    return new Error('Malformed host key');
  return parseDERKey(blob.subarray(typeEnd), blob.toString('utf8', 4, typeEnd));
}`,
  ],
  ["const key = parseKey(keyRaw);", "const key = parseHostKeyBlob(keyRaw);"],
];

// ssh2 1.17.0 matches an old PEM key ("BEGIN RSA|DSA|EC PRIVATE KEY") with a pattern that backtracks on long input,
// and decrypts an encrypted one with the MD5 key derivation of that format. The patch reads the PEM lines without a
// pattern and refuses the encrypted form. electron/vps-install.mjs decrypts that form with Node crypto first.
const OLD_PEM_PATCH = [
  [
    String.raw`  const regexp = /^-----BEGIN (RSA|DSA|EC) PRIVATE KEY-----(?:\r\n|\n)((?:[^:]+:\s*[\S].*(?:\r\n|\n))*)([\s\S]+)(?:\r\n|\n)-----END (RSA|DSA|EC) PRIVATE KEY-----$/;
  OpenSSH_Old_Private.parse = (str, passphrase) => {
    const m = regexp.exec(str);`,
    String.raw`  const OLD_PEM_TYPES = ['RSA', 'DSA', 'EC'];
  const matchOldPEM = (str) => {
    const lines = str.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    if (lines.length < 3)
      return null;
    const type = OLD_PEM_TYPES.find((name) => lines[0] === '-----BEGIN ' + name + ' PRIVATE KEY-----');
    const endType = OLD_PEM_TYPES.find((name) => lines[lines.length - 1] === '-----END ' + name + ' PRIVATE KEY-----');
    if (type === undefined || endType === undefined)
      return null;
    let body = 1;
    while (body < lines.length - 1 && lines[body].indexOf(':') > 0)
      ++body;
    const base64 = lines.slice(body, -1).join('\n');
    if (base64.length === 0)
      return null;
    return [str, type, lines.slice(1, body).map((line) => line + '\n').join(''), base64, endType];
  };
  OpenSSH_Old_Private.parse = (str, passphrase) => {
    const m = matchOldPEM(str);`,
  ],
  [
    `          const ivSlice = bufferSlice(cipherIV, 0, 8);
          let cipherKey = createHash('md5')
                            .update(passphrase)
                            .update(ivSlice)
                            .digest();
          while (cipherKey.length < encInfo.keyLen) {
            cipherKey = combineBuffers(
              cipherKey,
              createHash('md5')
                .update(cipherKey)
                .update(passphrase)
                .update(ivSlice)
                .digest()
            );
          }
          if (cipherKey.length > encInfo.keyLen)
            cipherKey = bufferSlice(cipherKey, 0, encInfo.keyLen);
          try {
            const decipher = createDecipheriv(cipherName, cipherKey, cipherIV);
            decipher.setAutoPadding(false);
            privBlob = combineBuffers(decipher.update(privBlob),
                                      decipher.final());
            decrypted = true;
          } catch (ex) {
            return ex;
          }`,
    "          return new Error('Encrypted old PEM private key is not supported');",
  ],
];

const PATCHES = new Map([
  ["handlers.misc.js", HOSTKEYS_PATCH],
  ["keyParser.js", OLD_PEM_PATCH],
]);

function patchSource(source, file, patch) {
  return patch.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`ssh2 patch does not apply to ${file}: ${JSON.stringify(from.slice(0, 80))}`);
    return text.replace(from, () => to);
  }, source);
}

const patched = new Set();
const { outputFiles } = await build({
  entryPoints: [entryPoint],
  absWorkingDir: entryPoint.split(`${sep}node_modules${sep}`)[0],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["cpu-features", "*.node"],
  outfile: join(root, "electron/vendor/ssh2.cjs"),
  logLevel: "info",
  write: false,
  plugins: [{
    name: "ssh2-patches",
    setup(plugin) {
      plugin.onLoad({ filter: /[\\/]ssh2[\\/]lib[\\/]protocol[\\/](handlers\.misc|keyParser)\.js$/ }, async ({ path }) => {
        const name = path.split(/[\\/]/).pop();
        patched.add(name);
        return { contents: patchSource(await readFile(path, "utf8"), path, PATCHES.get(name)), loader: "js" };
      });
    },
  }],
});
const missing = [...PATCHES.keys()].filter((name) => !patched.has(name));
if (missing.length) throw new Error(`ssh2 patch found no lib/protocol/${missing.join(", lib/protocol/")}`);
for (const file of outputFiles) await writeFile(file.path, file.contents);
