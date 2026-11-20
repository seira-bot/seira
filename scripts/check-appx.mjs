import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STARTUP_TASK_ID, storeVersion } from "./appx-manifest.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPECTED = Object.freeze({
  displayName: "Seira",
  publisherDisplayName: "PT GLOBAL RAYA ORIS WIJAYA",
  protocol: "openmausbot",
});

/** electron-builder 26.15.3 writes the Identity Publisher in single quotes. */
const attribute = (tag, name) => {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match?.[1] ?? match?.[2];
};

export function checkManifest(xml, { version }) {
  const errors = [];
  const identityTag = /<Identity\b[^>]*>/.exec(xml)?.[0] ?? "";
  const identity = { name: attribute(identityTag, "Name"), publisher: attribute(identityTag, "Publisher") };

  if (!xml.includes(`<DisplayName>${EXPECTED.displayName}</DisplayName>`)) errors.push(`the manifest has no DisplayName ${EXPECTED.displayName}`);
  if (!xml.includes(`<PublisherDisplayName>${EXPECTED.publisherDisplayName}</PublisherDisplayName>`)) {
    errors.push(`the manifest has no PublisherDisplayName ${EXPECTED.publisherDisplayName}`);
  }

  const wanted = storeVersion(version);
  const found = attribute(identityTag, "Version");
  if (found !== wanted) errors.push(`Identity Version is ${found ?? "missing"}, not ${wanted}`);

  const protocols = [...xml.matchAll(/<(?:\w+:)?Extension\b[^>]*Category="windows\.protocol"[^>]*>([\s\S]*?)<\/(?:\w+:)?Extension>/g)];
  if (!protocols.some(([, body]) => new RegExp(`<(?:\\w+:)?Protocol\\b[^>]*\\sName="${EXPECTED.protocol}"`).test(body))) {
    errors.push(`the manifest has no windows.protocol with Name ${EXPECTED.protocol}`);
  }

  if (!/<(?:\w+:)?Capability\b[^>]*\sName="runFullTrust"/.test(xml)) errors.push("the manifest has no runFullTrust capability");

  const task = [...xml.matchAll(/<(?:\w+:)?StartupTask\b[^>]*>/g)].map(([tag]) => tag).find((tag) => attribute(tag, "TaskId") === STARTUP_TASK_ID);
  if (!task) errors.push(`the manifest has no startup task ${STARTUP_TASK_ID}`);
  else if (attribute(task, "Enabled") !== "false") errors.push(`the startup task ${STARTUP_TASK_ID} is not off by default`);

  return { errors, identity };
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

export function checkAssets(packageDir, sourceDir) {
  const errors = [];
  for (const name of readdirSync(sourceDir).sort()) {
    const packaged = path.join(packageDir, "assets", name);
    if (!existsSync(packaged)) errors.push(`assets/${name} is not in the package`);
    else if (sha256(packaged) !== sha256(path.join(sourceDir, name))) errors.push(`assets/${name} differs from build/appx/${name}`);
  }
  for (const file of walk(packageDir)) {
    if (path.basename(file).includes("SampleAppx")) errors.push(`the package holds a sample logo: ${path.relative(packageDir, file)}`);
  }
  return errors;
}

export function main(argv = process.argv.slice(2)) {
  const packageDir = argv[0];
  if (!packageDir || !existsSync(path.join(packageDir, "AppxManifest.xml"))) {
    console.error("::error::usage: node scripts/check-appx.mjs <extracted package folder with AppxManifest.xml>");
    return 1;
  }
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const { errors: manifestErrors, identity } = checkManifest(readFileSync(path.join(packageDir, "AppxManifest.xml"), "utf8"), { version });
  const errors = [...manifestErrors, ...checkAssets(packageDir, path.join(root, "build/appx"))];
  console.log(`Identity Name:      ${identity.name ?? "(none)"}`);
  console.log(`Identity Publisher: ${identity.publisher ?? "(none)"}`);
  for (const message of errors) console.error(`::error::${message}`);
  if (errors.length === 0) console.log("The package manifest and logos are correct.");
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
