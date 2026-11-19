import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: { workflow_dispatch?: { inputs?: Record<string, { required?: boolean; default?: string }> } };
  jobs: Record<string, { environment?: unknown; permissions?: unknown; steps: Step[] }>;
}

const text = readFileSync(new URL("../.github/workflows/package-macos.yml", import.meta.url), "utf8");
const flow = parse(text) as Workflow;
const job = flow.jobs.package;
const steps = job.steps;
const SIGNED = "steps.mode.outputs.signed == 'true'";
const APPLE_SECRETS = [
  "MAC_CERT_P12_BASE64",
  "MAC_CERT_PASSWORD",
  "APPLE_API_KEY_P8_BASE64",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER_ID",
];

const position = (name: string) => {
  const found = steps.findIndex((step) => step.name === name);
  expect(found, name).toBeGreaterThanOrEqual(0);
  return found;
};
const step = (name: string) => steps[position(name)];
const gates = steps.filter((each) => each.name?.startsWith("Gate: "));
const notarize = position("Notarize the two dmg and the two zip files");

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function folder() {
  const created = mkdtempSync(join(tmpdir(), "seira-package-macos-"));
  folders.push(created);
  return created;
}

/** Run a step's real script the way `shell: bash` runs it on the runner. */
function runStep(name: string, cwd: string, env: Record<string, string>) {
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step(name).run!], {
    cwd,
    env: {
      PATH: [dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: cwd,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(cwd, "summary.md"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => line.split("=", 2) as [string, string]),
  );
  return { ...result, outputs };
}

describe("package-macos.yml", () => {
  it("starts only by hand, from a ref that a maintainer names", () => {
    expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
    expect(flow.on.workflow_dispatch?.inputs?.ref?.required).toBe(true);
  });

  it("reads only the five Apple secrets, and only behind the release environment", () => {
    const read = new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(([, name]) => name));
    expect([...read].sort()).toEqual([...APPLE_SECRETS].sort());
    expect(Object.keys(flow.jobs)).toEqual(["approval", "package"]);
    expect(job.environment).toBe("release");
    expect(job.permissions).toBeUndefined();
    expect(flow.jobs.approval.environment).toBe("release-approval");
    expect(flow.jobs.approval.permissions).toEqual({});
    expect(JSON.stringify(flow.jobs.approval)).not.toContain("secrets.");
  });

  describe("chooses a signed or an unsigned build", () => {
    const choose = (set: string[]) =>
      runStep("Choose a signed or an unsigned build", folder(), Object.fromEntries(
        APPLE_SECRETS.map((name) => [name, set.includes(name) ? "value" : ""]),
      ));

    it("signs when all five Apple secrets are set", () => {
      const result = choose(APPLE_SECRETS);
      expect(result.status, result.stdout).toBe(0);
      expect(result.outputs).toEqual({ signed: "true" });
    });

    it("builds a test that is not for release when no Apple secret is set", () => {
      const result = choose([]);
      expect(result.status, result.stdout).toBe(0);
      expect(result.outputs).toEqual({ signed: "false" });
      expect(result.stdout).toContain("NOT FOR RELEASE");
    });

    it.each([
      [["MAC_CERT_P12_BASE64", "MAC_CERT_PASSWORD"]],
      [APPLE_SECRETS.slice(2)],
      [APPLE_SECRETS.filter((name) => name !== "APPLE_API_ISSUER_ID")],
    ])("stops before the build and names each missing secret when only %j are set", (set) => {
      const result = choose(set);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
      for (const name of APPLE_SECRETS.filter((each) => !set.includes(each))) expect(result.stdout).toContain(name);
    });

    it("chooses before it checks out, installs, or builds anything", () => {
      expect(position("Choose a signed or an unsigned build")).toBe(0);
    });
  });

  describe("names the build", () => {
    const check = (ref: string, signed: string) => {
      const cwd = folder();
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "1.2.3" }));
      return runStep("Check the version", cwd, { REF: ref, SIGNED: signed });
    };

    it("names a signed build after its version", () => {
      const result = check("v1.2.3", "true");
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs).toEqual({ version: "1.2.3", artifact: "seira-1.2.3-macos" });
    });

    it("marks an unsigned build NOT-FOR-RELEASE", () => {
      const result = check("main", "false");
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs.artifact).toBe("seira-1.2.3-macos-NOT-FOR-RELEASE");
    });

    it("stops when a version tag does not match package.json", () => {
      const result = check("v1.2.2", "true");
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("tag v1.2.2 holds package.json version 1.2.3");
    });
  });

  describe("gates", () => {
    it("run on signed and unsigned builds, before notarization", () => {
      expect(gates.length).toBeGreaterThan(0);
      for (const gate of gates.filter((each) => !each.name!.includes("Gatekeeper"))) {
        expect(gate.if, gate.name).toBeUndefined();
        expect(steps.indexOf(gate), gate.name).toBeLessThan(notarize);
      }
    });

    it("verify the signature of both apps before notarization", () => {
      const gate = step("Gate: the signature verifies before notarization");
      expect(gate.run).toContain('codesign --verify --deep --strict "$app"');
      expect(gate.run).toContain("TeamIdentifier");
    });

    it("refuse an app that names another update feed or lacks the dictation helper", () => {
      expect(step("Gate: both apps use the Seira update feed").run).toMatch(/owner: seira-bot[\s\S]*repo: seira/);
      expect(step("Gate: both apps carry every helper for their own CPU").run).toContain("Seira Speech.app/Contents/MacOS/speech-helper");
    });
  });

  it("signs, notarizes, staples, makes the feed again, and asks Gatekeeper, in that order, only with the secrets", () => {
    const order = [
      "Import the Developer ID certificate into a temporary keychain",
      "Package both architectures",
      "Gate: the signature verifies before notarization",
      "Notarize the two dmg and the two zip files",
      "Staple, zip again, and make the blockmaps and the update feed again",
      "Gate: Gatekeeper accepts the stapled apps and disk images",
      "Stage and verify the files to upload",
    ].map(position);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const name of [
      "Import the Developer ID certificate into a temporary keychain",
      "Notarize the two dmg and the two zip files",
      "Staple, zip again, and make the blockmaps and the update feed again",
      "Gate: Gatekeeper accepts the stapled apps and disk images",
    ]) {
      expect(step(name).if, name).toBe(SIGNED);
    }
    expect(step("Staple, zip again, and make the blockmaps and the update feed again").run).toMatch(
      /stapler staple[\s\S]*ditto[\s\S]*regenerate-blockmaps\.mjs[\s\S]*regenerate-mac-feed\.mjs/,
    );
    expect(step("Gate: Gatekeeper accepts the stapled apps and disk images").run).toMatch(/stapler validate[\s\S]*spctl --assess/);
    expect(step("Delete the temporary keychain").if).toBe(`always() && ${SIGNED}`);
  });

  it("uploads one artifact, the staged folder, after every gate", () => {
    const uploads = steps.filter((each) => each.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].if).toBeUndefined();
    expect(uploads[0].with).toMatchObject({
      name: "${{ steps.version.outputs.artifact }}",
      path: "${{ runner.temp }}/seira-macos/",
      "if-no-files-found": "error",
    });
    expect(steps.indexOf(uploads[0])).toBeGreaterThan(position("Stage and verify the files to upload"));
    for (const gate of gates) expect(steps.indexOf(gate), gate.name).toBeLessThan(steps.indexOf(uploads[0]));
  });

  describe("stages the files to upload", () => {
    const version = "1.2.3";
    const packages = ["arm64.dmg", "x64.dmg", "arm64.zip", "x64.zip"].map((end) => `Seira-${version}-${end}`);

    function build() {
      const cwd = folder();
      const release = join(cwd, "release");
      mkdirSync(release);
      const entries = packages.map((file) => {
        const bytes = Buffer.from(`bytes of ${file}`);
        writeFileSync(join(release, file), bytes);
        writeFileSync(join(release, `${file}.blockmap`), "blockmap");
        const sha512 = createHash("sha512").update(bytes).digest("base64");
        return `  - url: ${file}\n    sha512: ${sha512}\n    size: ${bytes.length}\n`;
      });
      writeFileSync(join(release, "latest-mac.yml"), `version: ${version}\nfiles:\n${entries.join("")}path: ${packages[2]}\n`);
      return cwd;
    }
    const stage = (cwd: string, signed: string) =>
      runStep("Stage and verify the files to upload", cwd, { VERSION: version, SIGNED: signed, STAGE: join(cwd, "stage") });

    it("stages the release set of a signed build, with stable names and checksums", () => {
      const cwd = build();
      const result = stage(cwd, "true");
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(join(cwd, "stage")).sort()).toEqual([
        ...packages,
        ...packages.map((file) => `${file}.blockmap`),
        "latest-mac.yml",
        "Seira.dmg",
        "Seira-intel.dmg",
        "SHA256SUMS-mac.txt",
      ].sort());
      expect(readFileSync(join(cwd, "stage", "Seira.dmg"))).toEqual(readFileSync(join(cwd, "release", packages[0])));
      expect(readFileSync(join(cwd, "stage", "Seira-intel.dmg"))).toEqual(readFileSync(join(cwd, "release", packages[1])));
      const sums = readFileSync(join(cwd, "stage", "SHA256SUMS-mac.txt"), "utf8");
      for (const file of [...packages, "Seira.dmg", "Seira-intel.dmg"]) expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  ${file}$`, "m"));
    });

    it("stages no update feed and no stable name for an unsigned build", () => {
      const cwd = build();
      const result = stage(cwd, "false");
      expect(result.status, result.stderr).toBe(0);
      expect(readdirSync(join(cwd, "stage")).sort()).toEqual([...packages, "NOT-FOR-RELEASE.txt"].sort());
      expect(readFileSync(join(cwd, "summary.md"), "utf8")).toContain("NOT FOR RELEASE");
    });

    it("stops when latest-mac.yml does not match a package", () => {
      const cwd = build();
      appendFileSync(join(cwd, "release", packages[1]), "changed after the feed");
      const result = stage(cwd, "true");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`the SHA-512 in latest-mac.yml does not match ${packages[1]}`);
    });

    it("stops when the build did not write a package", () => {
      const cwd = build();
      rmSync(join(cwd, "release", packages[3]));
      const result = stage(cwd, "false");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`the build did not write release/${packages[3]}`);
      expect(existsSync(join(cwd, "stage", "NOT-FOR-RELEASE.txt"))).toBe(false);
    });
  });
});
