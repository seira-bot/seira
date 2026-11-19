// Builds the two generated files of the startup screen: the character kit and the page script.
// Run `node scripts/build-splash.mjs` after a change to electron/splash/, the character runtime or the character art.
// `--check` fails when the files on disk are not what this script would write.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kitDir = path.join(root, "src/assets/seira-character");
const outDir = path.join(root, "electron/resources");
const dataUrl = (file) => "data:image/webp;base64," + fs.readFileSync(path.join(kitDir, file)).toString("base64");

function kitJson() {
  const kit = JSON.parse(fs.readFileSync(path.join(kitDir, "kit.json"), "utf8"));
  const views = {};
  for (const [name, view] of Object.entries(kit.styles.seira.views)) {
    const { hair: _hair, ...rest } = view;
    views[name] = { ...rest, file: dataUrl(view.file), visor: dataUrl(view.visor) };
  }
  const hands = Object.fromEntries(Object.entries(kit.hands).map(([name, hand]) => [name, { ...hand, side: "right", file: dataUrl(hand.file) }]));
  const fx = Object.fromEntries(Object.entries(kit.fx).map(([name, sticker]) => [name, { ...sticker, frames: sticker.frames.map(dataUrl) }]));
  return JSON.stringify({
    bases: { version: 2, size: [768, 768], styles: { seira: { label: "Seira", gender: "f", recolor: false, views } } },
    stickers: { version: 2, hands, accessories: {}, fx },
  });
}

async function pageScript() {
  const result = await build({
    entryPoints: [path.join(root, "electron/splash/page.js")],
    bundle: true, minify: true, format: "iife", target: "chrome120", charset: "ascii", write: false, legalComments: "none",
  });
  return result.outputFiles[0].text;
}

const files = { "splash-kit.json": kitJson(), "splash-page.js": await pageScript() };
const stale = [];
for (const [name, text] of Object.entries(files)) {
  const target = path.join(outDir, name);
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== text) stale.push(name);
  } else {
    fs.writeFileSync(target, text);
    console.log(`electron/resources/${name}: ${Math.round(text.length / 1024)} KB`);
  }
}
if (stale.length) {
  console.error(`Out of date: ${stale.join(", ")}. Run: node scripts/build-splash.mjs`);
  process.exit(1);
}
