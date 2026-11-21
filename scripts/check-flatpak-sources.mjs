import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGENERATE = "flatpak-node-generator pnpm pnpm-lock.yaml -o packaging/flatpak/generated-sources.json";
const LIST_LIMIT = 20;

/** Maps each sha512 (hex) in the `packages:` section of a pnpm lockfile (lockfileVersion 9.0) to its package key. */
export function lockIntegrities(lockText) {
  const found = new Map();
  let inPackages = false;
  let key = "";
  for (const line of lockText.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.startsWith("packages:");
      continue;
    }
    if (!inPackages) continue;
    const entry = /^ {2}(\S.*):$/.exec(line);
    if (entry) {
      key = entry[1].replace(/^'(.*)'$/, "$1");
      continue;
    }
    const integrity = /integrity: sha512-([A-Za-z0-9+/]+={0,2})/.exec(line);
    if (integrity) found.set(Buffer.from(integrity[1], "base64").toString("hex"), key);
  }
  return found;
}

/** Maps each sha512 (hex) of a flatpak-node-generator source list to its url. */
export function sourceHashes(sources) {
  const found = new Map();
  for (const source of sources) {
    if (typeof source.sha512 === "string") found.set(source.sha512, source.url ?? source.sha512);
  }
  return found;
}

export function compareSources(lockText, sources) {
  const locked = lockIntegrities(lockText);
  const listed = sourceHashes(sources);
  return {
    missing: [...locked].filter(([hash]) => !listed.has(hash)).map(([, key]) => key),
    extra: [...listed].filter(([hash]) => !locked.has(hash)).map(([, url]) => url),
    total: locked.size,
  };
}

const capped = (items) => [...items.slice(0, LIST_LIMIT).map((item) => `  ${item}`), ...(items.length > LIST_LIMIT ? [`  ... and ${items.length - LIST_LIMIT} more`] : [])];

function main(argv) {
  const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const lockPath = option("--lock", "pnpm-lock.yaml");
  const sourcesPath = option("--sources", "packaging/flatpak/generated-sources.json");
  const { missing, extra, total } = compareSources(readFileSync(lockPath, "utf8"), JSON.parse(readFileSync(sourcesPath, "utf8")));
  if (missing.length === 0 && extra.length === 0) {
    console.log(`flatpak sources: ${total} packages match pnpm-lock.yaml`);
    return;
  }
  console.error(`flatpak sources: ${sourcesPath} does not match ${lockPath}`);
  if (missing.length > 0) console.error([`${missing.length} package(s) in the lockfile have no source:`, ...capped(missing)].join("\n"));
  if (extra.length > 0) console.error([`${extra.length} source(s) are not in the lockfile:`, ...capped(extra)].join("\n"));
  console.error(`Regenerate the list with:\n  ${REGENERATE}`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
