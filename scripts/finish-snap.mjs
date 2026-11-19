// electron-builder names a snap after linux.executableName and always adds --no-sandbox to a classic snap's launcher.
// This hook unpacks each built .snap, names it seira, removes that switch, packs it again, and fails the build when the
// switch is still anywhere in the result.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SNAP_NAME = "seira";
const SANDBOX_OFF = /--no-sandbox\b|--disable-setuid-sandbox\b|--disable-gpu-sandbox\b/;

export function renameSnapYaml(text, from) {
  const next = text
    .replace(/^name: .*$/m, `name: ${SNAP_NAME}`)
    .replace(new RegExp(`^  ${from}:$`, "m"), `  ${SNAP_NAME}:`);
  if (!/^name: seira$/m.test(next) || !new RegExp(`^  ${SNAP_NAME}:$`, "m").test(next)) {
    throw new Error(`snap.yaml does not name the snap and its app ${SNAP_NAME}`);
  }
  return next;
}

export function dropSandboxSwitch(launcher) {
  return launcher.replace(/ '(?:--no-sandbox|--disable-setuid-sandbox|--disable-gpu-sandbox)'/g, "");
}

// The builder's launcher calls helper scripts of a 2019 template (desktop-init.sh and others) that it leaves in the snap as an
// unextracted tar. A classic snap uses the host libraries, so the launcher only has to start the app.
export function plainLauncher(launcher) {
  const binary = [...dropSandboxSwitch(launcher).matchAll(/"\$SNAP\/([^"]+)"/g)]
    .map((match) => match[1])
    .filter((name) => !name.endsWith(".sh"))
    .at(-1);
  if (!binary) throw new Error("command.sh does not start an app binary");
  return `#!/bin/bash -e\nexec "$SNAP/${binary}" "$@"\n`;
}

export function renameDesktopEntry(text, from) {
  return text
    .replace(new RegExp(`^Exec=${from}( |$)`, "m"), `Exec=${SNAP_NAME}$1`)
    .replace(/^Icon=.*$/m, "Icon=${SNAP}/meta/gui/icon.svg");
}

/** Throws when a sandbox-off switch is in the launcher or the snap metadata, or a setuid helper ships. */
export function assertSandboxOn(files) {
  for (const [name, text] of Object.entries(files)) {
    if (SANDBOX_OFF.test(text)) throw new Error(`${name} still turns the Chromium sandbox off`);
  }
}

/** The entries of an `unsquashfs -ll` listing whose mode has a setuid or setgid bit; a store rejects them. */
export function setuidEntries(listing) {
  return listing.split("\n")
    .filter((line) => /^[-dlcbps]([rwx-]{2}[sS]|[rwx-]{5}[sS])/.test(line))
    .map((line) => line.split(/\s+/).at(-1));
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  }
  return result.stdout;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

/** Reads the launcher files of a snap straight from its image, as the checks in the store review would. */
export function readSnapFiles(snap, names) {
  return Object.fromEntries(names.map((name) => [name, run("unsquashfs", ["-cat", snap, name])]));
}

export function finishSnap(snap) {
  const work = mkdtempSync(path.join(tmpdir(), "seira-snap-"));
  try {
    const root = path.join(work, "root");
    run("unsquashfs", ["-no-progress", "-d", root, snap]);
    const yamlFile = path.join(root, "meta", "snap.yaml");
    const oldName = /^name: (.+)$/m.exec(readFileSync(yamlFile, "utf8"))?.[1];
    if (!oldName) throw new Error("snap.yaml has no name");
    writeFileSync(yamlFile, renameSnapYaml(readFileSync(yamlFile, "utf8"), oldName));
    const launcher = path.join(root, "command.sh");
    writeFileSync(launcher, plainLauncher(readFileSync(launcher, "utf8")));
    for (const entry of readdirSync(root).filter((name) => /^snap-template-.*\.tar$/.test(name))) rmSync(path.join(root, entry));
    for (const file of walk(path.join(root, "meta", "gui")).filter((file) => file.endsWith(".desktop"))) {
      writeFileSync(file, renameDesktopEntry(readFileSync(file, "utf8"), oldName));
    }
    const setuid = setuidEntries(run("unsquashfs", ["-ll", snap]));
    if (setuid.length > 0) throw new Error(`The snap ships setuid files: ${setuid.join(", ")}`);
    const output = path.join(work, "out.snap");
    run(process.env.MKSQUASHFS_PATH || "mksquashfs", [
      root, output, "-no-progress", "-quiet", "-noappend", "-comp", "xz", "-no-xattrs", "-no-fragments", "-all-root",
    ]);
    assertSandboxOn(readSnapFiles(output, ["command.sh", "meta/snap.yaml"]));
    copyFileSync(output, snap);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export default async function afterAllArtifactBuild({ artifactPaths = [] } = {}) {
  for (const file of artifactPaths.filter((file) => file.endsWith(".snap"))) finishSnap(file);
  return [];
}
