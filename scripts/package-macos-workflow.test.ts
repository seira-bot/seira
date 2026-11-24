import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface Workflow {
  on: {
    release?: unknown;
    workflow_dispatch?: { inputs?: Record<string, { required?: boolean; default?: string }> };
  };
  jobs: Record<
    string,
    { environment?: unknown; permissions?: unknown; needs?: unknown; if?: string; outputs?: Record<string, string>; steps: Step[] }
  >;
}

const text = readFileSync(new URL("../.github/workflows/package-macos.yml", import.meta.url), "utf8");
const flow = parse(text) as Workflow;
const job = flow.jobs.package;
const steps = job.steps;
const findSha = flow.jobs.commit.steps;
const SIGNED = "steps.mode.outputs.signed == 'true'";
const NOT_SKIPPED = "steps.mode.outputs.skip != 'true'";
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
const step = (name: string) =>
  steps.find((each) => each.name === name) ?? findSha.find((each) => each.name === name) ?? flow.jobs.draft.steps.find((each) => each.name === name)!;
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
function runStep(name: string, cwd: string, env: Record<string, string>, path: string[] = []) {
  const output = join(cwd, "github-output");
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step(name).run!], {
    cwd,
    env: {
      PATH: [...path, dirname(process.execPath), process.env.PATH].join(delimiter),
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
  it("starts only by hand, never on a release event, because GitHub starts no workflow for a draft release", () => {
    expect(Object.keys(flow.on)).toEqual(["workflow_dispatch"]);
    expect(flow.on.release).toBeUndefined();
    expect(flow.on.workflow_dispatch?.inputs?.ref?.required).toBe(true);
    expect(flow.on.workflow_dispatch?.inputs?.release_tag).toMatchObject({ required: false, default: "", type: "string" });
    expect(text).not.toMatch(/github\.event\.release|github\.event_name/);
  });

  it("reads the ref and the release tag from the dispatch inputs only", () => {
    expect(text.split("REF: ${{ inputs.ref }}")).toHaveLength(3);
    expect(text.split("${{ inputs.release_tag }}").length - 1).toBeGreaterThanOrEqual(4);
  });

  it("reads only the five Apple secrets, and only behind the release environment", () => {
    const read = new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(([, name]) => name));
    expect([...read].sort()).toEqual([...APPLE_SECRETS].sort());
    expect(Object.keys(flow.jobs)).toEqual(["commit", "approval", "draft", "package", "attach"]);
    expect(flow.jobs.commit.environment).toBeUndefined();
    expect(flow.jobs.commit.permissions).toBeUndefined();
    expect(JSON.stringify(flow.jobs.commit)).not.toContain("secrets.");
    expect(job.environment).toBe("release");
    expect(job.permissions).toBeUndefined();
    expect(flow.jobs.approval.environment).toBe("release-approval");
    expect(flow.jobs.approval.permissions).toEqual({});
    expect(flow.jobs.draft.environment).toBe("release");
    expect(flow.jobs.draft.permissions).toEqual({ contents: "write" });
    expect(JSON.stringify(flow.jobs.draft)).not.toContain("secrets.");
    expect(JSON.stringify(flow.jobs.approval)).not.toContain("secrets.");
  });

  it("checks out the commit that the commit job found, never the ref itself", () => {
    const checkout = steps.find((each) => each.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ needs.commit.outputs.sha }}");
    expect(flow.jobs.commit.outputs).toEqual({ sha: "${{ steps.sha.outputs.sha }}" });
  });

  describe("finds the commit of the ref", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const find = (ref: string, ghScript: string, releaseTag = "") => {
      const cwd = folder();
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), `#!/bin/bash\n${ghScript}\n`, { mode: 0o755 });
      return { ...runStep("Find the commit of the ref", cwd, { REF: ref, RELEASE_TAG: releaseTag, GH_TOKEN: "x", GITHUB_REPOSITORY: "owner/repo" }, [bin]), cwd };
    };

    it.each(["../x", "-x", "a b", "", "a;b", "$(id)"])("refuses the ref %j without echoing it", (ref) => {
      const result = find(ref, `echo ${SHA}`);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
      expect(result.stdout).toContain("::error::The ref is not a tag, branch or commit name.");
      if (ref !== "") expect(result.stdout + result.stderr).not.toContain(ref);
    });

    it("writes the SHA of the ref as the output and in the run summary", () => {
      const result = find("v1.2.3", `echo ${SHA}`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.outputs).toEqual({ sha: SHA });
      const summary = readFileSync(join(result.cwd, "summary.md"), "utf8");
      expect(summary).toContain("v1.2.3");
      expect(summary).toContain(SHA);
    });

    it("stops when the answer is not a 40-character SHA", () => {
      const result = find("main", "echo not-a-sha");
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
    });

    it("stops when the repository has no commit for the ref", () => {
      const result = find("main", "exit 1");
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
    });

    describe("for a release tag", () => {
      // The fake gh answers like `gh api ... --jq`: the object type and the object SHA of the full tag ref, then of the tag object.
      const TAG_OBJECT = "fedcba9876543210fedcba9876543210fedcba98";
      const lightweight = `case "$*" in *git/ref/tags/v1.2.3*) echo "commit ${SHA}";; *) exit 1;; esac`;
      const annotated = `case "$*" in *git/ref/tags/v1.2.3*) echo "tag ${TAG_OBJECT}";; *git/tags/${TAG_OBJECT}*) echo "commit ${SHA}";; *) exit 1;; esac`;

      it("takes the commit of the full tag ref, and follows an annotated tag to its commit", () => {
        for (const script of [lightweight, annotated]) {
          const result = find("v1.2.3", script, "v1.2.3");
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(result.outputs).toEqual({ sha: SHA });
        }
      });

      it("asks for the tag ref, never for a branch or a commit of the same name", () => {
        const result = find("v1.2.3", `echo "$*" >> calls.log\n${lightweight}`, "v1.2.3");
        expect(result.status).toBe(0);
        const calls = readFileSync(join(result.cwd, "calls.log"), "utf8");
        expect(calls).toContain("git/ref/tags/v1.2.3");
        expect(calls).not.toContain("/commits/");
      });

      it.each([
        ["a ref that is not the release tag", "main", "v1.2.3"],
        ["a release tag that is not v1.2.3", "v1.2", "v1.2"],
        ["a release tag with a suffix", "v1.2.3-rc.1", "v1.2.3-rc.1"],
        ["a release tag that holds a path", "../v1.2.3", "../v1.2.3"],
      ])("stops for %s", (_name, ref, tag) => {
        const result = find(ref, lightweight, tag);
        expect(result.status).toBe(1);
        expect(result.outputs).toEqual({});
      });

      it("stops when the tag does not exist, or points at something that is not a commit", () => {
        expect(find("v1.2.3", "exit 1", "v1.2.3").status).toBe(1);
        const tree = find("v1.2.3", `echo "tree ${SHA}"`, "v1.2.3");
        expect(tree.status).toBe(1);
        expect(tree.outputs).toEqual({});
      });
    });
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

    it("skips the build of a draft release when no Apple secret is set, without failing and with a clear message", () => {
      const cwd = folder();
      const result = runStep("Choose a signed or an unsigned build", cwd, {
        RELEASE_TAG: "v1.2.3",
        ...Object.fromEntries(APPLE_SECRETS.map((name) => [name, ""])),
      });
      expect(result.status, result.stdout).toBe(0);
      expect(result.outputs).toEqual({ signed: "false", skip: "true" });
      expect(result.stdout).toContain("::notice::No Apple secret is set, so this draft release gets no macOS build.");
      const summary = readFileSync(join(cwd, "summary.md"), "utf8");
      expect(summary).toContain("macOS build skipped");
      expect(summary).toContain("no macOS assets");
    });

    it("signs the build for a draft release when all five Apple secrets are set, and does not skip", () => {
      const result = runStep("Choose a signed or an unsigned build", folder(), {
        RELEASE_TAG: "v1.2.3",
        ...Object.fromEntries(APPLE_SECRETS.map((name) => [name, "value"])),
      });
      expect(result.status, result.stdout).toBe(0);
      expect(result.outputs).toEqual({ signed: "true" });
    });

    it("stops a draft release run when only some Apple secrets are set, so a half-made setup is not hidden", () => {
      const result = runStep("Choose a signed or an unsigned build", folder(), {
        RELEASE_TAG: "v1.2.3",
        ...Object.fromEntries(APPLE_SECRETS.map((name) => [name, name === "MAC_CERT_PASSWORD" ? "value" : ""])),
      });
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
    });

    it("skips every step after the choice that is not already limited to a signed build", () => {
      const after = steps.slice(position("Choose a signed or an unsigned build") + 1);
      for (const each of after) {
        const name = each.name ?? each.uses;
        if (each.if === undefined) expect.fail(`${name} has no condition, so it would run on a skipped build`);
        expect(each.if === NOT_SKIPPED || each.if.includes(SIGNED), name).toBe(true);
      }
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
        expect(gate.if, gate.name).toBe(NOT_SKIPPED);
        expect(steps.indexOf(gate), gate.name).toBeLessThan(notarize);
      }
    });

    it("verify the signature of both apps before notarization", () => {
      const gate = step("Gate: the signature verifies before notarization");
      expect(gate.run).toContain('codesign --verify --deep --strict "$app"');
      expect(gate.run).toContain("TeamIdentifier");
    });

    it("refuse an app that names another update feed or lacks the dictation helper", () => {
      expect(step("Gate: the update feed file matches the signing mode").run).toMatch(/owner: seira-bot[\s\S]*repo: seira/);
      expect(step("Gate: both apps carry every helper for their own CPU").run).toContain("Seira Speech.app/Contents/MacOS/speech-helper");
    });

    describe("on the update feed file", () => {
      const feedGate = () => step("Gate: the update feed file matches the signing mode");
      const run = (signed: string, withFile: boolean, content = "provider: github\nowner: seira-bot\nrepo: seira\n") => {
        const cwd = folder();
        for (const app of ["release/mac-arm64/Seira.app", "release/mac/Seira.app"]) {
          const resources = join(cwd, app, "Contents", "Resources");
          mkdirSync(resources, { recursive: true });
          if (withFile) writeFileSync(join(resources, "app-update.yml"), content);
        }
        const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", feedGate().run!], {
          cwd, env: { PATH: process.env.PATH!, SIGNED: signed }, encoding: "utf8",
        });
        return result;
      };

      it("passes a signed app that has the file, and stops one that lacks it or names another repository", () => {
        expect(run("true", true).status).toBe(0);
        expect(run("true", false).status).toBe(1);
        expect(run("true", true, "provider: github\nowner: someone\nrepo: seira\n").status).toBe(1);
      });

      it("passes an ad-hoc app without the file, and stops one that has it", () => {
        expect(run("false", false).status).toBe(0);
        const carrying = run("false", true);
        expect(carrying.status).toBe(1);
        expect(carrying.stdout).toContain("must not carry");
      });

      it("asks the packager to leave the file out of ad-hoc builds only", () => {
        const script = step("Package both architectures").run!;
        const [signed, adhoc] = script.split("else");
        expect(adhoc).toContain("export SEIRA_NO_UPDATE_FEED=1");
        expect(signed).not.toContain("SEIRA_NO_UPDATE_FEED");
        expect(adhoc.indexOf("SEIRA_NO_UPDATE_FEED")).toBeLessThan(adhoc.indexOf("pnpm package:mac"));
      });

      it("checks the file before the package is signed off for notarization", () => {
        expect(position("Gate: the update feed file matches the signing mode")).toBeLessThan(notarize);
      });
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
    expect(uploads[0].if).toBe(NOT_SKIPPED);
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


  describe("checks the draft release", () => {
    const draft = flow.jobs.draft;
    const SHA = "0123456789abcdef0123456789abcdef01234567";

    it("runs only for a dispatch with a release tag, behind the same approval as the build, before the build", () => {
      expect(draft.needs).toEqual(["commit", "approval"]);
      expect(draft.if).toContain("inputs.release_tag != ''");
      expect(draft.if).toContain("needs.approval.result == 'success' && needs.approval.outputs.attempt == github.run_attempt");
      expect(draft.if).toContain("!cancelled() && needs.commit.result == 'success'");
      expect(flow.jobs.package.needs).toEqual(["commit", "approval", "draft"]);
      expect(flow.jobs.package.if).toContain("needs.draft.result != 'failure'");
      expect(draft.outputs).toEqual({ release_id: "${{ steps.release.outputs.release_id }}" });
    });

    it("only reads: it creates, edits and deletes nothing", () => {
      const script = draft.steps.map((each) => each.run ?? "").join("\n");
      expect(script).not.toMatch(/--method|-X |gh release|\bPOST\b|\bPATCH\b|\bDELETE\b|git push/);
    });

    // The fake gh answers `gh api ... --jq` from a list of releases, like the real API: a draft is listed for a token that can write.
    const run = (releases: Array<{ id: number; tag_name: string; draft: boolean }>, tag = "v1.2.3") => {
      const cwd = folder();
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const lines = releases.filter((each) => each.tag_name === tag).map((each) => `${each.id} ${each.draft}`).join("\\n");
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/bash\ncase "$*" in *"--jq length"*) echo ${releases.length};; *releases*) printf '${lines}${lines ? "\\n" : ""}';; *) exit 1;; esac\n`,
        { mode: 0o755 },
      );
      return runStep("Find the draft release of the tag", cwd, { TAG: tag, SHA, GH_TOKEN: "x", GITHUB_REPOSITORY: "owner/repo" }, [bin]);
    };

    it("writes the id of the draft release of the tag", () => {
      const result = run([{ id: 5, tag_name: "v1.2.2", draft: false }, { id: 77, tag_name: "v1.2.3", draft: true }]);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.outputs).toEqual({ release_id: "77" });
    });

    it("stops when no release has the tag", () => {
      const result = run([{ id: 5, tag_name: "v1.2.2", draft: true }]);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
      expect(result.stdout).toContain("No release has the tag v1.2.3");
    });

    it("stops when the release is already published", () => {
      const result = run([{ id: 77, tag_name: "v1.2.3", draft: false }]);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
      expect(result.stdout).toContain("already published");
    });

    it("stops when two releases have the tag", () => {
      const result = run([{ id: 76, tag_name: "v1.2.3", draft: true }, { id: 77, tag_name: "v1.2.3", draft: true }]);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
    });

    it.each(["main", "v1.2", "v1.2.3-rc.1", "../v1.2.3", ""])("stops for the tag %j", (tag) => {
      const result = run([{ id: 77, tag_name: tag, draft: true }], tag);
      expect(result.status).toBe(1);
      expect(result.outputs).toEqual({});
    });
  });

  describe("attaches the signed files to the draft release", () => {
    const attach = flow.jobs.attach;
    const upload = () => attach.steps.find((each) => each.name === "Upload the twelve files, update feed last")!;
    const VERSION = "1.2.3";
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const NAMES = [
      ...["arm64.dmg", "x64.dmg", "arm64.zip", "x64.zip"].flatMap((end) => [`Seira-${VERSION}-${end}`, `Seira-${VERSION}-${end}.blockmap`]),
      "latest-mac.yml", "Seira.dmg", "Seira-intel.dmg", "SHA256SUMS-mac.txt",
    ];

    // A fake gh in Node. `release upload` copies the file, `api` answers like GitHub, and every call goes to a log with its folder.
    const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const dir = process.env.FAKE_DIR;
const state = JSON.parse(process.env.FAKE_STATE);
const args = process.argv.slice(2);
fs.mkdirSync(dir + "/up", { recursive: true });
fs.appendFileSync(dir + "/log", process.cwd() + " | " + args.join(" ") + "\\n");
const rest = [];
for (let i = 0; i < args.length; i++) { if (args[i] === "-H" || args[i] === "--jq") { i++; continue; } rest.push(args[i]); }
const jq = args.includes("--jq");
const files = () => fs.readdirSync(dir + "/up").sort();
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
if (rest[0] === "release" && rest[1] === "upload") { fs.copyFileSync(rest[3], dir + "/up/" + path.basename(rest[3])); process.exit(0); }
if (rest[0] !== "api") process.exit(1);
const target = rest[1];
let match;
if ((match = /^repos\\/owner\\/repo\\/releases\\/(\\d+)\\/assets\\?/.exec(target))) {
  out(files().map((name, index) => ({ id: index + 1, name, state: "uploaded", size: fs.statSync(dir + "/up/" + name).size })));
} else if ((match = /^repos\\/owner\\/repo\\/releases\\/assets\\/(\\d+)$/.exec(target))) {
  out(fs.readFileSync(dir + "/up/" + files()[Number(match[1]) - 1], "utf8"));
} else if ((match = /^repos\\/owner\\/repo\\/releases\\/(\\d+)$/.exec(target))) {
  const release = { id: Number(match[1]), tag_name: state.tag, draft: state.draft };
  out(jq ? release.tag_name + " " + release.draft : release);
} else if (target === "repos/owner/repo/git/ref/tags/" + state.tag) {
  out(state.tagKind + " " + state.tagSha);
} else process.exit(1);
`;

    interface Options {
      tag?: string;
      extra?: string;
      real?: boolean;
      state?: Partial<{ tag: string; draft: boolean; tagSha: string }>;
      releaseId?: string;
      makeStage?: (stage: string) => void;
    }
    const run = (options: Options = {}) => {
      const tag = options.tag ?? `v${VERSION}`;
      const cwd = folder();
      const stageDir = join(folder(), "artifact");
      const bin = join(cwd, "bin");
      const fake = join(cwd, "fake");
      mkdirSync(stageDir);
      mkdirSync(bin);
      mkdirSync(fake);
      for (const name of options.extra ? [...NAMES, options.extra] : NAMES) writeFileSync(join(stageDir, name), "x");
      mkdirSync(join(cwd, "scripts"));
      if (options.real) {
        // The files of a real build: the feed and the checksum file name only files that the release holds, with their sizes.
        const packages = NAMES.filter((name) => /\.(dmg|zip)$/.test(name) && name.startsWith(`Seira-${VERSION}-`));
        for (const name of NAMES.filter((each) => each.endsWith(".dmg") || each.endsWith(".zip"))) writeFileSync(join(stageDir, name), name);
        const entries = packages.map((name) => `  - url: ${name}\n    sha512: abc\n    size: ${name.length}\n`).join("");
        writeFileSync(join(stageDir, "latest-mac.yml"), `version: ${VERSION}\nfiles:\n${entries}path: ${packages[2]}\n`);
        writeFileSync(join(stageDir, "SHA256SUMS-mac.txt"), packages.map((name) => `${"a".repeat(64)}  ${name}\n`).join(""));
        copyFileSync(new URL("./release-assets.mjs", import.meta.url), join(cwd, "scripts", "release-assets.mjs"));
      } else {
        writeFileSync(join(cwd, "scripts", "release-assets.mjs"), "console.log('UPLOAD', process.argv.slice(2).join(' '));\n");
      }
      options.makeStage?.(stageDir);
      writeFileSync(join(bin, "gh"), FAKE_GH, { mode: 0o755 });
      const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", upload().run!], {
        cwd,
        env: {
          PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
          HOME: cwd,
          TAG: tag, STAGE: stageDir, GH_TOKEN: "x", GITHUB_WORKSPACE: cwd, GITHUB_REPOSITORY: "owner/repo",
          RELEASE_ID: options.releaseId ?? "77", SHA,
          GITHUB_STEP_SUMMARY: join(cwd, "summary.md"),
          FAKE_DIR: fake,
          FAKE_STATE: JSON.stringify({ tag, draft: true, tagKind: "commit", tagSha: SHA, ...options.state }),
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      const log = existsSync(join(fake, "log")) ? readFileSync(join(fake, "log"), "utf8") : "";
      return { ...result, log, stageDir, uploaded: existsSync(join(fake, "up")) ? readdirSync(join(fake, "up")).sort() : [] };
    };

    it("is a job with a write token only for contents, and reads no secret", () => {
      expect(attach.permissions).toEqual({ contents: "write" });
      expect(attach.environment).toBe("release");
      expect(JSON.stringify(attach)).not.toContain("secrets.");
      expect(JSON.stringify(flow.jobs.commit.permissions ?? {})).not.toContain("write");
      expect(JSON.stringify(flow.jobs.package.permissions ?? {})).not.toContain("write");
      expect(attach.needs).toEqual(["commit", "approval", "draft", "package"]);
    });

    it("runs only after a passed draft check and a signed build, behind the same approval as the build", () => {
      const condition = attach.if!;
      expect(condition).toContain("inputs.release_tag != ''");
      expect(condition).toContain("needs.draft.result == 'success'");
      expect(condition).toContain("needs.package.result == 'success'");
      expect(condition).toContain("needs.package.outputs.signed == 'true'");
      expect(condition).toContain("needs.approval.result == 'success' && needs.approval.outputs.attempt == github.run_attempt");
      expect(condition).toContain("!cancelled() && needs.commit.result == 'success'");
      expect(flow.jobs.package.outputs).toMatchObject({ signed: "${{ steps.mode.outputs.signed }}" });
    });

    it("checks out the built commit, drops the credentials, installs no package and runs no package script", () => {
      const checkout = attach.steps.find((each) => each.uses?.startsWith("actions/checkout@"));
      expect(checkout?.with).toMatchObject({ ref: "${{ needs.commit.outputs.sha }}", "persist-credentials": false });
      const all = attach.steps.map((each) => each.run ?? "").join("\n");
      expect(all).not.toMatch(/\bpnpm\b|\bnpm\b|\bnpx\b|gh release (create|edit|delete)/);
      expect(attach.steps.some((each) => each.uses?.startsWith("actions/download-artifact@"))).toBe(true);
    });

    it("binds the upload to the release id and the repository, and never publishes", () => {
      const script = upload().run!;
      expect(script).toContain('release-assets.mjs" upload "$TAG"');
      expect(script).toContain('--repo "$GITHUB_REPOSITORY" --release-id "$RELEASE_ID"');
      expect(script).not.toMatch(/release-assets\.mjs"? publish/);
      expect(script).toContain("latest-mac.yml Seira.dmg Seira-intel.dmg SHA256SUMS-mac.txt");
      expect(script).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
      expect(upload().env).toMatchObject({
        TAG: "${{ inputs.release_tag }}",
        RELEASE_ID: "${{ needs.draft.outputs.release_id }}",
        SHA: "${{ needs.commit.outputs.sha }}",
      });
    });

    it("passes the stub helper the twelve files, the repository and the release id", () => {
      const ok = run();
      expect(ok.status, ok.stderr + ok.stdout).toBe(0);
      expect(ok.stdout).toContain(`UPLOAD upload v${VERSION} Seira-${VERSION}-arm64.dmg`);
      expect(ok.stdout).toContain("latest-mac.yml Seira.dmg Seira-intel.dmg SHA256SUMS-mac.txt --repo owner/repo --release-id 77");
    });

    it("refuses a tag that is not v1.2.3, and an artifact with another file set, before it uploads", () => {
      for (const tag of ["main", "v1.2", "v1.2.3-rc.1", "../v1.2.3"]) {
        const result = run({ tag });
        expect(result.status, tag).toBe(1);
        expect(result.stdout).not.toContain("UPLOAD");
      }
      const extra = run({ extra: "Seira-unsigned.dmg" });
      expect(extra.status).toBe(1);
      expect(extra.stdout).not.toContain("UPLOAD");
    });

    it.each([
      ["a symbolic link", (stage: string) => { rmSync(join(stage, "Seira.dmg")); symlinkSync("/etc/hostname", join(stage, "Seira.dmg")); }],
      ["a dangling symbolic link", (stage: string) => { rmSync(join(stage, "latest-mac.yml")); symlinkSync("/nonexistent", join(stage, "latest-mac.yml")); }],
      ["a folder", (stage: string) => { rmSync(join(stage, "Seira-intel.dmg")); mkdirSync(join(stage, "Seira-intel.dmg")); }],
    ])("refuses an entry that is %s, before it uploads", (_name, makeStage) => {
      const result = run({ makeStage });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("is not a regular file");
      expect(result.stdout).not.toContain("UPLOAD");
      expect(result.uploaded).toEqual([]);
    });

    it("stops before it uploads when the release is not the draft of the tag", () => {
      for (const state of [{ draft: false }, { tag: "v9.9.9" }]) {
        const result = run({ state });
        expect(result.status, JSON.stringify(state)).toBe(1);
        expect(result.stdout).toContain("is no longer the draft");
        expect(result.stdout).not.toContain("UPLOAD");
      }
      const missing = run({ releaseId: "" });
      expect(missing.status).toBe(1);
      expect(missing.stdout).toContain("release id is missing");
    });

    it("stops before it uploads when the tag no longer points at the built commit", () => {
      const result = run({ state: { tagSha: "f".repeat(40) } });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("no longer points at the built commit");
      expect(result.stdout).not.toContain("UPLOAD");
    });

    describe("with the real helper, a fake gh and an artifact folder outside the checkout", () => {
      it("uploads the twelve files, the feed last, without reading any git remote", () => {
        const result = run({ real: true });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.uploaded).toEqual([...NAMES].sort());
        const uploads = result.log.split("\n").filter((line) => line.includes("release upload"));
        expect(uploads).toHaveLength(12);
        expect(uploads.at(-1)).toContain("latest-mac.yml");
        for (const line of uploads) {
          expect(line).toContain(`release upload v${VERSION} `);
          expect(line).toContain("--repo owner/repo");
          expect(line.split(" | ")[0], "the helper runs in the artifact folder").toBe(result.stageDir);
        }
        expect(result.stdout).toContain("every file that latest-mac.yml names is an uploaded asset");
        expect(result.stdout).not.toMatch(/FAIL|fatal|not a git repository/);
      });

      it("uploads nothing when the release is not the draft that the id names", () => {
        for (const state of [{ draft: false }, { tag: "v9.9.9" }]) {
          const result = run({ real: true, state });
          expect(result.status, JSON.stringify(state)).toBe(1);
          expect(result.uploaded).toEqual([]);
        }
      });
    });
  });
});
