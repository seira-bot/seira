import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import afterAllArtifactBuild, {
  assertSandboxOn,
  dropSandboxSwitch,
  finishSnap,
  plainLauncher,
  readSnapFiles,
  renameDesktopEntry,
  renameSnapYaml,
} from "./finish-snap.mjs";

const LAUNCHER = `#!/bin/bash -e\nexec "$SNAP/desktop-init.sh" "$SNAP/desktop-common.sh" "$SNAP/seira" '--no-sandbox' "$@"`;
const YAML = "base: core22\nconfinement: classic\nname: seira\napps:\n  seira:\n    command: command.sh\n";
const DESKTOP = "[Desktop Entry]\nName=Seira\nExec=seira %U\nIcon=${SNAP}/meta/gui/icon.png\n";

const haveTools = ["unsquashfs", "mksquashfs"].every((tool) => spawnSync("which", [tool]).status === 0);
const temporary = [];
afterEach(() => temporary.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function builtSnap({ launcher = LAUNCHER, yaml = YAML } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seira-finish-snap-"));
  temporary.push(dir);
  const root = path.join(dir, "root");
  fs.mkdirSync(path.join(root, "meta", "gui"), { recursive: true });
  fs.writeFileSync(path.join(root, "command.sh"), launcher, { mode: 0o755 });
  fs.writeFileSync(path.join(root, "meta", "snap.yaml"), yaml);
  fs.writeFileSync(path.join(root, "meta", "gui", "bot.seira.app.desktop"), DESKTOP);
  const snap = path.join(dir, "Seira.snap");
  const made = spawnSync("mksquashfs", [root, snap, "-quiet", "-noappend", "-comp", "xz", "-no-xattrs", "-all-root"]);
  expect(made.status).toBe(0);
  return snap;
}

describe("snap launcher edits", () => {
  it("removes the sandbox switch and keeps every other argument", () => {
    const fixed = dropSandboxSwitch(LAUNCHER);
    expect(fixed).not.toContain("--no-sandbox");
    expect(fixed).toBe(`#!/bin/bash -e\nexec "$SNAP/desktop-init.sh" "$SNAP/desktop-common.sh" "$SNAP/seira" "$@"`);
  });

  it("starts the app binary directly, without the template helper scripts", () => {
    expect(plainLauncher(LAUNCHER)).toBe(`#!/bin/bash -e\nexec "$SNAP/seira" "$@"\n`);
    expect(() => plainLauncher("#!/bin/bash\nexec true")).toThrow(/does not start an app binary/);
  });

  it("names the snap and its app seira, and fails when it cannot", () => {
    const named = renameSnapYaml(YAML, "seira");
    expect(named).toContain("name: seira\n");
    expect(named).toContain("\n  seira:\n    command: command.sh");
    expect(() => renameSnapYaml("name: other\n", "seira")).toThrow(/does not name/);
  });

  it("points the desktop entry at the seira command and the shipped icon", () => {
    const entry = renameDesktopEntry(DESKTOP, "seira");
    expect(entry).toContain("Exec=seira %U");
    expect(entry).toContain("Icon=${SNAP}/meta/gui/icon.svg");
  });
});

describe("the sandbox check", () => {
  it("passes a launcher and metadata with the sandbox on", () => {
    expect(() => assertSandboxOn({ "command.sh": dropSandboxSwitch(LAUNCHER), "meta/snap.yaml": YAML })).not.toThrow();
  });

  it("fails when the launcher or the metadata turns the sandbox off", () => {
    expect(() => assertSandboxOn({ "command.sh": LAUNCHER })).toThrow(/command\.sh still turns the Chromium sandbox off/);
    expect(() => assertSandboxOn({ "meta/snap.yaml": "apps:\n  seira:\n    command: command.sh --no-sandbox\n" })).toThrow(/snap\.yaml/);
    expect(() => assertSandboxOn({ "command.sh": "exec app --disable-setuid-sandbox" })).toThrow();
  });
});

describe.skipIf(!haveTools)("a packed snap", () => {
  it("is renamed, loses the switch, and is checked after it is packed again", async () => {
    const snap = builtSnap();
    await afterAllArtifactBuild({ artifactPaths: [snap, "/not/a/snap.AppImage"] });
    const files = readSnapFiles(snap, ["command.sh", "meta/snap.yaml"]);
    expect(files["command.sh"]).not.toContain("--no-sandbox");
    expect(files["command.sh"]).not.toContain("desktop-init.sh");
    expect(files["meta/snap.yaml"]).toContain("name: seira");
    expect(files["meta/snap.yaml"]).toContain("confinement: classic");
  });

  it("fails the build when the switch survives in the metadata, which the hook does not edit", () => {
    const snap = builtSnap({ yaml: `${YAML}    environment:\n      ELECTRON_EXTRA_LAUNCH_ARGS: --no-sandbox\n` });
    expect(() => finishSnap(snap)).toThrow(/snap\.yaml still turns the Chromium sandbox off/);
    expect(readSnapFiles(snap, ["meta/snap.yaml"])["meta/snap.yaml"]).toContain("name: seira");
  });

  it("fails the build when the snap ships a setuid file", () => {
    const snap = builtSnap();
    const dir = path.dirname(snap);
    const root = path.join(dir, "root");
    const helper = path.join(root, "chrome-sandbox");
    fs.writeFileSync(helper, "x");
    fs.chmodSync(helper, 0o4755);
    const bad = path.join(dir, "Setuid.snap");
    expect(spawnSync("mksquashfs", [root, bad, "-quiet", "-noappend", "-comp", "xz", "-no-xattrs", "-all-root"]).status).toBe(0);
    expect(() => finishSnap(bad)).toThrow(/setuid/);
  });
});
