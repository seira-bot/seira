// Bundle ssh2 into one self-contained file the packaged app can require: it ships no node_modules.
// The optional native speed-ups stay external: ssh2 loads them inside a try block and falls back to pure JavaScript.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = require.resolve("ssh2");

await build({
  entryPoints: [entryPoint],
  absWorkingDir: entryPoint.split(`${sep}node_modules${sep}`)[0],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["cpu-features", "*.node"],
  outfile: join(root, "electron/vendor/ssh2.cjs"),
  logLevel: "info",
});
