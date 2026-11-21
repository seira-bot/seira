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

// ssh2 1.17.0 runs each key that a server sends in hostkeys-00@openssh.com through parseKey. Its old PEM pattern
// backtracks for about 130 ms on a 34 KB packet, in the Electron main process. These keys are SSH wire-format blobs,
// so the patched handler reads them only with the wire-format parser.
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

function patchHostKeys(source, file) {
  return HOSTKEYS_PATCH.reduce((text, [from, to]) => {
    if (text.split(from).length !== 2) throw new Error(`ssh2 hostkeys patch does not apply to ${file}: ${JSON.stringify(from)}`);
    return text.replace(from, () => to);
  }, source);
}

let hostKeysPatched = false;
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
    name: "ssh2-hostkeys",
    setup(plugin) {
      plugin.onLoad({ filter: /[\\/]ssh2[\\/]lib[\\/]protocol[\\/]handlers\.misc\.js$/ }, async ({ path }) => {
        hostKeysPatched = true;
        return { contents: patchHostKeys(await readFile(path, "utf8"), path), loader: "js" };
      });
    },
  }],
});
if (!hostKeysPatched) throw new Error("ssh2 hostkeys patch found no lib/protocol/handlers.misc.js");
for (const file of outputFiles) await writeFile(file.path, file.contents);
