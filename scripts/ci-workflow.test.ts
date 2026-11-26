import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { VITEST_SHARDS, VITEST_WORKERS } from "./ci-scope.mjs";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  shell?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Job {
  name?: string;
  "runs-on"?: string | string[];
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  uses?: string;
  "timeout-minutes"?: number;
  environment?: unknown;
  permissions?: Record<string, string> | string;
  strategy?: { "fail-fast"?: boolean; matrix?: { shard?: number[]; include?: Record<string, string>[]; worker?: string; runner?: string[] } };
  with?: Record<string, unknown>;
  steps?: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
  concurrency?: Record<string, string>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const directory = new URL("../.github/workflows/", import.meta.url);
const files = readdirSync(directory).sort();
const texts = new Map(files.map((file) => [file, readFileSync(new URL(file, directory), "utf8")]));
const workflows = new Map(files.map((file) => [file, parse(texts.get(file)!) as Workflow]));
const workflow = workflows.get("ci.yml")!;
const packageFiles = files.filter((file) => /^package-[a-z0-9-]+\.yml$/.test(file));
const packageWorkflows = packageFiles.map((file) => [file, workflows.get(file)!] as const);
const IMAGE = "server-image.yml";
const NPM = "npm-publish.yml";
const MILESTONES = "milestones.yml";
const SMOKE = "server-image-smoke.yml";
// Uploads the desktop snap to the Snap Store from the `snap-store` environment, when a release is published.
const SNAP = "snap-publish.yml";
// Artifact-only candidate build of the patched Windows browser engine. It never publishes and has no secret.
const VENDOR = "browser-vendor-windows.yml";
const image = workflows.get(IMAGE)!;
const smoke = workflows.get(SMOKE)!;
const LOGIN = "${{ secrets.GITHUB_TOKEN }}";
const FLAGGED = "${{ needs.gate.outputs.pass == 'false' }}";
const APPROVED_NOW = "needs.approval.result == 'success' && needs.approval.outputs.attempt == github.run_attempt";
const GATE_CLEAR = `needs.gate.result == 'success' && (needs.gate.outputs.pass == 'true' || (${APPROVED_NOW}))`;
const MAIN_REF = "github.ref == 'refs/heads/main'";
const REDISPATCH = "redispatch";
const GATE_SCRIPT = "release-gate.mjs";
const MACOS = "package-macos.yml";
const READ_TOKEN = "GH_TOKEN: ${{ github.token }}";
const ATTACH = "attach";
const isAttach = (file: string, id: string) => file === MACOS && id === ATTACH;
const ATTACH_IF = `\${{ !cancelled() && needs.package.result == 'success' && needs.package.outputs.signed == 'true' && startsWith(inputs.ref, 'v') && ${MAIN_REF} && ${GATE_CLEAR} }}`;
const MAC_FILES = [
  "Seira-$VERSION-arm64.dmg", "Seira-$VERSION-x64.dmg",
  "Seira-$VERSION-arm64.zip", "Seira-$VERSION-x64.zip",
  "Seira-$VERSION-arm64.dmg.blockmap", "Seira-$VERSION-x64.dmg.blockmap",
  "Seira-$VERSION-arm64.zip.blockmap", "Seira-$VERSION-x64.zip.blockmap",
  "latest-mac.yml", "Seira.dmg", "Seira-intel.dmg", "SHA256SUMS-mac.txt",
];
const scripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
}).scripts;

const stepsOf = (job: Job) => job.steps ?? [];
const allSteps = () => [...workflows.values()].flatMap((flow) => Object.values(flow.jobs).flatMap(stepsOf));
const allRuns = () => allSteps().flatMap((step) => (step.run === undefined ? [] : [step.run]));
const runs = (job: Job) => stepsOf(job).flatMap((step) => (step.run === undefined ? [] : [step.run]));

describe("snap publish workflow", () => {
  const flow = workflows.get(SNAP)!;
  const text = texts.get(SNAP)!;
  const { redispatch, commit, gate, approval, build, publish } = flow.jobs as Record<string, Job>;
  const find = (job: Job, name: string) => stepsOf(job).find((step) => step.name === name)!;
  const check = find(commit!, "Find the commit of the tag");
  const RUN_IF = `!cancelled() && github.event_name == 'workflow_dispatch' && ${MAIN_REF} && needs.commit.result == 'success'`;
  const CLEAR = `needs.gate.result == 'success' && (needs.gate.outputs.pass == 'true' || (${APPROVED_NOW}))`;

  // Runs the shell of the `commit` job with `gh` and `git` replaced by fakes, to see which release states it rejects.
  const runCommit = (env: { ref?: string; tag?: string; channel?: string; position?: string; release?: string | null; sha?: string }) => {
    const sha = env.sha ?? "a".repeat(40);
    const dir = mkdtempSync(join(tmpdir(), "snap-commit-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const tag = env.tag ?? "v1.2.3";
    const lsRemote = sha === "" ? "exit 0" : `printf '%s\\trefs/tags/${tag}\\n' ${sha}; exit 0`;
    writeFileSync(join(bin, "git"), `#!/bin/bash\n[ "$1" = ls-remote ] && { ${lsRemote}; }\nexit 1\n`, { mode: 0o755 });
    const release = env.release === undefined ? "false\\tfalse" : env.release;
    writeFileSync(join(bin, "gh"), [
      "#!/bin/bash",
      'case "$2" in',
      `  */compare/*) echo "${env.position ?? "behind"}" ;;`,
      release === null ? "  */releases/tags/*) exit 1 ;;" : `  */releases/tags/*) printf '${release}\\n' ;;`,
      "esac", "",
    ].join("\n"), { mode: 0o755 });
    const out = join(dir, "out");
    const result = spawnSync("bash", ["-c", check.run!], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "o/r", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, "sum"),
        REF: env.ref ?? "refs/heads/main", TAG: tag, CHANNEL: env.channel ?? "stable", GH_TOKEN: "x",
      },
    });
    const written = existsSync(out) ? readFileSync(out, "utf8") : "";
    rmSync(dir, { recursive: true, force: true });
    return { status: result.status, output: result.stdout + result.stderr, written };
  };

  it("starts on a published release and by hand, with a tag and a channel", () => {
    expect(Object.keys(flow.on).sort()).toEqual(["release", "workflow_dispatch"]);
    expect(flow.on.release).toEqual({ types: ["published"] });
    const channel = (flow.on.workflow_dispatch as { inputs: { channel: { default: string; options: string[] } } }).inputs.channel;
    expect(channel.default).toBe("stable");
    expect(channel.options).toEqual(["stable", "candidate", "beta", "edge"]);
    expect(flow.concurrency).toEqual({ group: "snap-publish", "cancel-in-progress": false });
  });

  it("starts the run on main for a release, and skips a draft and a prerelease", () => {
    expect(redispatch!.if).toContain("github.event_name == 'release'");
    expect(redispatch!.if).toContain("!github.event.release.draft");
    expect(redispatch!.if).toContain("!github.event.release.prerelease");
    expect(redispatch!.permissions).toEqual({ actions: "write", contents: "read" });
    expect(redispatch!.environment).toBeUndefined();
    expect(runs(redispatch!).join("\n")).toContain('--ref main -f tag="$TAG" -f channel=stable');
  });

  it("runs the release gate on the commit of the tag, and asks a person to approve a flagged run", () => {
    expect(commit!.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(gate!.needs).toBe("commit");
    expect(find(gate!, "Run the release gate").env?.SHA).toBe("${{ needs.commit.outputs.sha }}");
    expect(find(gate!, "Run the release gate").run).toContain('--tag "$TAG" --sha "$SHA"');
    expect(approval!.needs).toBe("gate");
  });

  it("builds and uploads only on main, after the gate passed or after an approval in this attempt", () => {
    expect(build!.needs).toEqual(["commit", "gate", "approval"]);
    expect(build!.if).toBe(`\${{ ${RUN_IF} && ${CLEAR} }}`);
    expect(publish!.needs).toEqual(["commit", "gate", "approval", "build"]);
    expect(publish!.if).toBe(`\${{ ${RUN_IF} && needs.build.result == 'success' && ${CLEAR} }}`);
    for (const job of [build!, publish!]) expect(job.if).not.toContain("'skipped'");
  });

  it("builds the commit SHA, never the tag name, and checks the checkout", () => {
    const checkout = stepsOf(build!).find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toBe("${{ needs.commit.outputs.sha }}");
    expect(text).not.toContain("refs/tags/${{");
    expect(find(build!, "Check the version").run).toContain('"$(git rev-parse HEAD)" = "$SHA"');
    expect(find(build!, "Check the version").run).toContain('[ "$TAG" = "v$version" ]');
    expect(build!.environment).toBeUndefined();
    expect(JSON.stringify(build)).not.toContain("secrets.");
    expect(runs(build!).join("\n")).toContain("node scripts/check-snap.mjs");
    expect(runs(build!).join("\n")).toContain("pnpm package:snap");
    expect(scripts["package:snap"]).toMatch(/electron-builder --linux snap --x64 --publish never$/);
  });

  it("uploads only from the snap-store environment, with the secret in the env of one step, and runs no repository code", () => {
    expect(publish!.environment).toBe("snap-store");
    expect(publish!.permissions).toEqual({ contents: "read" });
    expect(stepsOf(publish!).some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    const upload = stepsOf(publish!).find((step) => step.run?.includes("snapcraft upload"))!;
    expect(upload.env?.SNAPCRAFT_STORE_CREDENTIALS).toBe("${{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}");
    expect(upload.env?.CHANNEL).toBe("${{ needs.commit.outputs.channel }}");
    expect(upload.run).toContain("exit 1");
    expect(upload.run).toContain('--release="$CHANNEL"');
  });

  it("allows a release that is published, not a prerelease, and in main", () => {
    const result = runCommit({});
    expect(result.status, result.output).toBe(0);
    expect(result.written).toContain(`sha=${"a".repeat(40)}`);
    expect(result.written).toContain("channel=stable");
  });

  it("allows a non-stable channel for a commit in main without a release", () => {
    for (const channel of ["edge", "beta", "candidate"]) {
      const result = runCommit({ channel, release: null, position: "identical" });
      expect(result.status, result.output).toBe(0);
      expect(result.written).toContain(`channel=${channel}`);
    }
  });

  it("rejects a run on a ref that is not main", () => {
    for (const ref of ["refs/heads/m21/snap-publish", "refs/tags/v1.2.3", "refs/pull/1/merge"]) {
      const result = runCommit({ ref });
      expect(result.status, ref).toBe(1);
      expect(result.output).toContain("Run it from main");
      expect(result.written).toBe("");
    }
  });

  it("rejects a draft, a prerelease and a missing release for the stable channel", () => {
    for (const release of ["true\\tfalse", "false\\ttrue", "true\\ttrue", null]) {
      const result = runCommit({ release });
      expect(result.status, String(release)).toBe(1);
      expect(result.output).toContain("stable channel needs a published");
      expect(result.written).toBe("");
    }
  });

  it("rejects a commit that is not in the history of main, and a tag that does not exist", () => {
    for (const position of ["ahead", "diverged"]) {
      const result = runCommit({ position, channel: "edge" });
      expect(result.status, position).toBe(1);
      expect(result.output).toContain("not in the history of main");
    }
    const none = runCommit({ sha: "" });
    expect(none.status).toBe(1);
    expect(none.output).toContain("no commit for this tag");
  });

  it("rejects a tag and a channel that have the wrong shape", () => {
    for (const tag of ["1.2.3", "v1.2", "v1.2.3-rc.1", "main"]) expect(runCommit({ tag }).status, tag).toBe(1);
    expect(runCommit({ channel: "latest" }).status).toBe(1);
  });

  it("refuses an upload with no store credentials", () => {
    const upload = stepsOf(publish!).find((step) => step.run?.includes("snapcraft upload"))!;
    const result = spawnSync("bash", ["-c", upload.run!], { encoding: "utf8", env: { PATH: process.env.PATH, FILE: "x.snap", CHANNEL: "stable", TAG: "v1.2.3", SHA: "a" } });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("SNAPCRAFT_STORE_CREDENTIALS is missing");
  });
});

describe("CI workflows", () => {
  it("keeps the CI workflow, the milestones workflow, the npm publish workflow, the package workflows, the Windows browser vendor build, the two server image workflows and the snap publish workflow only", () => {
    expect(files).toEqual([VENDOR, "ci.yml", MILESTONES, NPM, ...packageFiles, SMOKE, IMAGE, SNAP]);
  });

  it("runs on pull requests, merge queue entries, pushes to main and manual starts only", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["merge_group", "pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    expect(workflow.on.merge_group).toEqual({ types: ["checks_requested"] });
    for (const [file, flow] of workflows) {
      for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) {
        expect(flow.on, `${file} uses ${trigger}`).not.toHaveProperty(trigger);
      }
    }
  });

  it("gives every workflow a read-only token, and write access only to a job behind the release environment, except the milestones job", () => {
    for (const [file, flow] of workflows) {
      expect(flow.permissions, file).toEqual({ contents: "read" });
      for (const [id, job] of Object.entries(flow.jobs)) {
        if (file === MILESTONES && id === "milestones") {
          expect(job.permissions, `${file} job ${id}`).toEqual({ contents: "read", issues: "write", "pull-requests": "write" });
          expect(job.environment, `${file} job ${id}`).toBeUndefined();
          continue;
        }
        const grants = JSON.stringify(job.permissions ?? {});
        if ((file === NPM || file === SNAP) && id === REDISPATCH) {
          expect(job.permissions, `${file} job ${id}`).toEqual({ actions: "write", contents: "read" });
          expect(job.environment, `${file} job ${id}`).toBeUndefined();
          continue;
        }
        if (grants.includes("write")) expect(job.environment, `${file} job ${id}`).toBe("release");
      }
    }
  });

  it("uses the release-approval environment only in a job with no permission, no secret and one exact condition", () => {
    for (const [file, flow] of workflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        const where = `${file} job ${id}`;
        if (job.environment === undefined) continue;
        if (file === SNAP && id === "publish") {
          expect(job.environment, where).toBe("snap-store");
          continue;
        }
        expect(["release", "release-approval"], where).toContain(job.environment);
        if (job.environment !== "release-approval") continue;
        expect(id, where).toBe("approval");
        expect(job.permissions, where).toEqual({});
        expect(JSON.stringify(job), where).not.toContain("secrets.");
        expect(job.needs, where).toBe("gate");
        expect(job.if, where).toBe(FLAGGED);
        expect(job.outputs, where).toEqual({ attempt: "${{ github.run_attempt }}" });
      }
    }
  });

  it("runs a job behind the release environment only on main, after the gate passed or after an approval in the same attempt", () => {
    const gated = [...workflows].flatMap(([file, flow]) =>
      Object.entries(flow.jobs)
        .filter(([, job]) => job.environment === "release")
        .map(([id, job]) => ({ where: `${file} job ${id}`, job })),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const { where, job } of gated) {
      expect([job.needs].flat(), where).toEqual(expect.arrayContaining(["gate", "approval"]));
      expect(job.if, where).toContain(MAIN_REF);
      expect(job.if, where).toContain(GATE_CLEAR);
      expect(job.if, where).not.toContain("'skipped'");
    }
  });

  it("uses no RELEASE_MAINTAINERS list anywhere", () => {
    for (const [file, text] of texts) expect(text, file).not.toContain("RELEASE_MAINTAINERS");
  });

  it("runs the release gate in a read-only job before every approval, with the reviewer list and no secret", () => {
    for (const file of [NPM, IMAGE, MACOS, SNAP]) {
      const gate = workflows.get(file)!.jobs.gate!;
      expect(gate.permissions, file).toEqual({ contents: "read", "pull-requests": "read" });
      expect(gate.environment, file).toBeUndefined();
      expect(gate.outputs, file).toEqual({ pass: "${{ steps.gate.outputs.pass }}", ...(file === IMAGE ? { sha: "${{ steps.gate.outputs.sha }}" } : {}) });
      expect(JSON.stringify(gate), file).not.toContain("secrets.");
      const step = stepsOf(gate).find((each) => each.id === "gate")!;
      expect(step.run, file).toContain(`node scripts/${GATE_SCRIPT}`);
      expect(step.env?.GH_TOKEN, file).toBe("${{ github.token }}");
      expect(step.env?.RELEASE_HUMAN_REVIEWERS, file).toBe("${{ vars.RELEASE_HUMAN_REVIEWERS }}");
      expect(step.run, file).toContain('1) echo "pass=false" >> "$GITHUB_OUTPUT"');
      expect(step.run, file).toContain("*) exit 1");
      expect(stepsOf(gate).find((each) => each.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"], file).toBe(false);
    }
  });

  it("reads no token, except the server image workflow once to sign in to the registry, the macOS commit step once to read the repository, the macOS attach step once to upload to the release and the milestones step once to call the GitHub API", () => {
    expect(texts.get(IMAGE)!.split(LOGIN)).toHaveLength(2);
    expect(texts.get(IMAGE)!.split(READ_TOKEN)).toHaveLength(2);
    expect(texts.get(NPM)!.split(READ_TOKEN)).toHaveLength(3);
    expect(texts.get(SNAP)!.split(READ_TOKEN)).toHaveLength(4);
    expect(texts.get(MACOS)!.split(READ_TOKEN)).toHaveLength(4);
    expect(texts.get(MILESTONES)!.split(READ_TOKEN)).toHaveLength(2);
    for (const [file, original] of texts) {
      const text = (file === IMAGE ? original.replace(LOGIN, "") : original).replaceAll(READ_TOKEN, "");
      for (const forbidden of ["github.token", "GITHUB_TOKEN", "GH_TOKEN"]) {
        expect(text, `${file} reads ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("reads a secret only in a job behind the release environment", () => {
    const count = (text: string) => text.split("secrets.").length - 1;
    for (const [file, flow] of workflows) {
      const jobs = Object.entries(flow.jobs);
      const inJobs = jobs.reduce((sum, [, job]) => sum + count(JSON.stringify(job)), 0);
      expect(count(texts.get(file)!), `${file} reads a secret outside a job`).toBe(inJobs);
      for (const [id, job] of jobs) {
        expect(job, `${file} job ${id} passes secrets on`).not.toHaveProperty("secrets");
        if (count(JSON.stringify(job)) > 0) expect(job.environment, `${file} job ${id}`).toBe(file === SNAP ? "snap-store" : "release");
      }
    }
  });

  it("puts a secret only into a step's env, never into a command line or an action input", () => {
    for (const [file, flow] of workflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        expect(JSON.stringify({ ...job, steps: undefined }), `${file} job ${id}`).not.toContain("secrets.");
        for (const step of stepsOf(job)) {
          const where = `${file} job ${id} step ${step.name ?? step.uses}`;
          expect(JSON.stringify({ ...step, env: undefined }), where).not.toContain("secrets.");
          for (const value of Object.values(step.env ?? {})) {
            if (String(value).includes("secrets.")) expect(value, where).toMatch(/^\$\{\{ secrets\.[A-Z][A-Z0-9_]* \}\}$/);
          }
        }
      }
    }
  });

  it("reads a secret only in the macOS package workflow, for the Apple signature, in the server image workflow and in the snap publish workflow", () => {
    expect(files.filter((file) => texts.get(file)!.includes("secrets."))).toEqual(["package-macos.yml", IMAGE, SNAP]);
  });

  it("drops the credentials of every checkout", () => {
    const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
  });

  it("pins every action to a full commit SHA, and calls a workflow of this repository only by its path", () => {
    const uses = [...workflows.values()].flatMap((flow) => Object.values(flow.jobs).flatMap((job) => [
      ...(job.uses === undefined ? [] : [job.uses]),
      ...stepsOf(job).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    ]));
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) {
      if (value.startsWith("./")) {
        expect(value).toMatch(/^\.\/\.github\/workflows\/[a-z0-9-]+\.yml$/);
        expect(files).toContain(value.replace("./.github/workflows/", ""));
      } else {
        expect(value).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("passes event values and inputs through env, never into a command line", () => {
    for (const run of allRuns()) expect(run).not.toMatch(/\$\{\{[^}]*\b(github\.event|github\.head_ref|inputs\.)/);
  });

  it("never creates a tag or publishes a release or a package from a command line, except the server image and npm publish jobs", () => {
    for (const [file, flow] of workflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        const publishes = file === IMAGE && id === "publish";
        const publishesToNpm = file === NPM && id === "publish";
        for (const run of runs(job)) {
          for (const forbidden of ["gh release", "git tag", "git push", ...(publishesToNpm ? [] : ["npm publish"])]) expect(run).not.toContain(forbidden);
          if (!publishes) {
            expect(run, `${file} job ${id}`).not.toContain("docker push");
            expect(run, `${file} job ${id}`).not.toContain("imagetools create");
          }
          expect(run).not.toMatch(/--publish(?!\s+never\b)/);
        }
      }
    }
  });
});

describe("Milestones workflow", () => {
  const flow = workflows.get(MILESTONES)!;
  const text = texts.get(MILESTONES)!;
  const job = flow.jobs.milestones!;

  it("starts only on a push to main and on a published release", () => {
    expect(flow.on).toEqual({ push: { branches: ["main"] }, release: { types: ["published"] } });
  });

  it("has no concurrency group, so no run is dropped", () => {
    expect(flow).not.toHaveProperty("concurrency");
  });

  it("has one job on a GitHub-hosted runner, with a timeout, no environment, no needs and no condition", () => {
    expect(Object.keys(flow.jobs)).toEqual(["milestones"]);
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job).toHaveProperty("timeout-minutes");
    expect(job.environment).toBeUndefined();
    expect(job.needs).toBeUndefined();
    expect(job.if).toBeUndefined();
  });

  it("checks out main without credentials and only the script, then runs the script with the read token in env", () => {
    const steps = stepsOf(job);
    expect(steps).toHaveLength(2);
    expect(steps[0]!.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(steps[0]!.with).toEqual({
      ref: "main",
      "persist-credentials": false,
      "sparse-checkout": "scripts/milestones.mjs",
      "sparse-checkout-cone-mode": false,
    });
    expect(steps[1]!.run).toBe("node scripts/milestones.mjs");
    expect(steps[1]!.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
  });

  it("reads no secret and installs no dependency", () => {
    for (const forbidden of ["secrets.", "pnpm", "npm install", "npm ci"]) expect(text).not.toContain(forbidden);
  });
});

describe("Server image smoke workflow", () => {
  const build = smoke.jobs.image!;

  it("is called by other workflows only, with a tag and a save flag", () => {
    expect(Object.keys(smoke.on)).toEqual(["workflow_call"]);
    expect(smoke.on.workflow_call).toEqual({
      inputs: {
        tag: { description: expect.any(String), required: false, type: "string", default: "" },
        sha: { description: expect.any(String), required: false, type: "string", default: "" },
        save: { description: expect.any(String), required: false, type: "boolean", default: false },
      },
    });
    expect(smoke.concurrency).toBeUndefined();
    expect(Object.keys(smoke.jobs)).toEqual(["image", "cloud-home", "connector"]);
  });

  it("builds the connector image for amd64 from connector/, saves it, and publishes it only from the publish job on main", () => {
    const connector = smoke.jobs.connector!;
    expect(connector.permissions).toBeUndefined();
    expect(connector.environment).toBeUndefined();
    expect(runs(connector).join("\n")).toContain("-t seira-connector:ci connector");
    expect(runs(connector).join("\n")).not.toMatch(/docker (login|push)/);
    const publish = image.jobs.publish!;
    expect(publish.if).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
    expect(publish.environment).toBe("release");
    const step = stepsOf(publish).find((each) => each.name === "Publish the connector image")!;
    expect(step.run).toContain('image="ghcr.io/${REPOSITORY,,}"');
    expect(step.run).toContain('image="$image-connector"');
    expect(step.run).toContain("imagetools create");
  });

  it("checks the commit that is built: the gate resolves the tag once, and the connector publish compares the image revision with it", () => {
    const gate = stepsOf(image.jobs.gate!).find((each) => each.id === "gate")!;
    expect(gate.env?.TAG).toBe("${{ inputs.tag }}");
    expect(gate.run).toContain('commits/refs/tags/$TAG');
    expect(gate.run).toContain('node scripts/release-gate.mjs --tag "$TAG" --sha "$sha"');
    expect(gate.run).toContain('node scripts/release-gate.mjs --sha "$sha"');
    expect(gate.run).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    const step = stepsOf(image.jobs.publish!).find((each) => each.name === "Publish the connector image")!;
    expect(step.env?.CHECKED_SHA).toBe("${{ needs.gate.outputs.sha }}");
    expect(step.run).toContain('[ "$revision" = "$CHECKED_SHA" ]');
    expect(step.run.indexOf('"$revision" = "$CHECKED_SHA"')).toBeLessThan(step.run.indexOf("imagetools create"));
  });

  it("builds the commit that the gate approved for a release run, and keeps the normal checkout otherwise", () => {
    expect(image.jobs.image!.needs).toBe("gate");
    expect(image.jobs.image!.if).toBe("${{ !cancelled() && (needs.gate.result == 'success' || needs.gate.result == 'skipped') }}");
    for (const id of ["image", "cloud-home", "connector"]) {
      const checkout = stepsOf(smoke.jobs[id]!).find((each) => each.uses?.startsWith("actions/checkout@"))!;
      expect(checkout.with?.ref, id).toBe("${{ inputs.sha || (inputs.tag && format('refs/tags/{0}', inputs.tag)) || '' }}");
    }
  });

  it("checks the loaded connector image revision before the first registry push", () => {
    const run = stepsOf(image.jobs.publish!).find((each) => each.name === "Publish the connector image")!.run;
    const check = run.indexOf('[ "$loaded" = "$CHECKED_SHA" ]');
    expect(run).toContain("docker image inspect -f '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' seira-connector:amd64");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(run.indexOf("docker push"));
  });

  it("keeps the single connector manifest when it adds the release tags", () => {
    const run = stepsOf(image.jobs.publish!).find((each) => each.name === "Publish the connector image")!.run;
    expect(run).toContain('docker buildx imagetools create --prefer-index=false "${targets[@]}" "$ref"');
  });

  it("promotes the digest that this job's push reported, under a build tag of this run, and checks the result", () => {
    const step = stepsOf(image.jobs.publish!).find((each) => each.name === "Publish the connector image")!;
    expect(step.run).toContain('build="$image:build-amd64-$RUN_ID-$RUN_ATTEMPT"');
    expect(step.run).toContain("grep -Eo 'digest: sha256:[0-9a-f]{64}'");
    expect(step.run).toContain('ref="$image@$digest"');
    expect(step.run).toContain('"${targets[@]}" "$ref"');
    expect(step.run).not.toMatch(/imagetools inspect "\$image:build-amd64"/);
    expect(step.run).toContain('= "$digest" ]');
  });

  it("uses GitHub's own actions only", () => {
    const uses = stepsOf(build).flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    for (const value of uses) expect(value).toMatch(/^actions\//);
  });

  it("builds and smoke-tests each platform on its own GitHub-hosted runner, without permissions, secrets or an environment", () => {
    expect(build.strategy?.matrix?.include).toEqual([
      { arch: "amd64", runner: "ubuntu-24.04" },
      { arch: "arm64", runner: "ubuntu-24.04-arm" },
    ]);
    expect(build.strategy?.["fail-fast"]).toBe(false);
    expect(build["runs-on"]).toBe("${{ matrix.runner }}");
    expect(build.permissions).toBeUndefined();
    expect(build.environment).toBeUndefined();
    expect(JSON.stringify(smoke)).not.toContain("secrets.");
    expect(runs(build).join("\n")).not.toMatch(/docker (login|push)/);
  });

  it("boots the container and checks the server, the UI and the user", () => {
    const boot = stepsOf(build).find((step) => step.name === "Boot the container and prove the server and UI answer");
    expect(boot?.run).toContain("docker run -d -e SEIRA_COMPOSIO_BROKER=off --name seira seira-server:ci");
    expect(boot?.run).toContain("http://127.0.0.1:8799/api/health");
    expect(boot?.run).toContain("UI not served");
    expect(boot?.run).toContain("server does not run as seira");
  });

  it("saves and uploads the image only when the caller asks", () => {
    const uploads = stepsOf(build).filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.if).toBe("${{ inputs.save }}");
    expect(uploads[0]!.with?.["if-no-files-found"]).toBe("error");
    expect(stepsOf(build).find((step) => step.name === "Save the image for the publish job")?.if).toBe("${{ inputs.save }}");
  });

  it("checks out a release tag only by its full tag name, and the commit of the caller when there is no tag", () => {
    const checkouts = stepsOf(build).filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with?.ref).toBe("${{ inputs.sha || (inputs.tag && format('refs/tags/{0}', inputs.tag)) || '' }}");
  });

  it("reads the tag only through env, and labels the image with the tag or main", () => {
    for (const step of stepsOf(build)) {
      if (step.run?.includes("TAG")) expect(step.env?.TAG, step.name).toBe("${{ inputs.tag }}");
    }
    expect(runs(build).join("\n")).toContain('--label "org.opencontainers.image.version=${TAG:-main}"');
  });

  it("uses no build cache", () => {
    expect(stepsOf(build).some((step) => step.uses?.startsWith("actions/cache"))).toBe(false);
    expect(runs(build).join("\n")).not.toMatch(/--cache-(from|to)\b/);
  });
});

describe("Server image workflow", () => {
  const build = image.jobs.image!;
  const approval = image.jobs.approval!;
  const gate = image.jobs.gate!;
  const publish = image.jobs.publish!;
  const ON_MAIN = "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'";

  it("starts by hand only", () => {
    expect(Object.keys(image.on)).toEqual(["workflow_dispatch"]);
  });

  it("never cancels a publish that is running", () => {
    expect(image.concurrency?.["cancel-in-progress"]).toBe(false);
  });

  it("calls the smoke workflow with the tag, and saves the images only on main", () => {
    expect(build.uses).toBe("./.github/workflows/server-image-smoke.yml");
    expect(build.with).toEqual({ tag: "${{ inputs.tag }}", sha: "${{ needs.gate.outputs.sha }}", save: "${{ github.ref == 'refs/heads/main' }}" });
    expect(build.steps).toBeUndefined();
    expect(build.permissions).toBeUndefined();
    expect(build.environment).toBeUndefined();
  });

  it("runs the release gate on main only, on the commit of the run, or on the commit of the tag for a tagged run", () => {
    expect(gate.if).toBe(ON_MAIN);
    expect(gate.needs).toBeUndefined();
    const step = stepsOf(gate).find((each) => each.id === "gate")!;
    expect(step.env?.SHA).toBe("${{ github.sha }}");
    expect(step.run).toContain('sha="$SHA"');
    expect(step.run).toContain('node scripts/release-gate.mjs --sha "$sha"');
  });

  it("asks a person to approve a run that the gate flagged", () => {
    expect(approval.needs).toBe("gate");
    expect(approval.if).toBe(FLAGGED);
    expect(approval.environment).toBe("release-approval");
    expect(approval.permissions).toEqual({});
    expect(approval["runs-on"]).toBe("ubuntu-24.04");
  });

  it("publishes only from a manual run on main, after a successful build and the gate or the approval, behind the release environment", () => {
    expect(publish.needs).toEqual(["image", "gate", "approval"]);
    expect(publish.if).toBe(
      `\${{ !cancelled() && ${ON_MAIN} && needs.image.result == 'success' && ${GATE_CLEAR} }}`,
    );
    expect(publish.environment).toBe("release");
    expect(publish.permissions).toEqual({ contents: "read", packages: "write" });
    expect(publish["runs-on"]).toBe("ubuntu-24.04");
  });

  it("runs no code of the repository in the publish job, and uses no build cache", () => {
    expect(stepsOf(publish).some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    const steps = Object.values(image.jobs).flatMap(stepsOf);
    expect(steps.some((step) => step.uses?.startsWith("actions/cache"))).toBe(false);
    expect(Object.values(image.jobs).flatMap(runs).join("\n")).not.toMatch(/--cache-(from|to)\b/);
  });

  it("downloads the images that the smoke workflow saved", () => {
    const download = stepsOf(publish).find((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(download?.with?.pattern).toBe("seira-server-*");
  });

  it("publishes to this repository's own package only", () => {
    const step = stepsOf(publish).find((each) => each.run?.includes("imagetools create"));
    expect(step?.env?.REPOSITORY).toBe("${{ github.repository }}");
    expect(step?.run).toContain('image="ghcr.io/${REPOSITORY,,}"');
    for (const run of runs(publish)) {
      for (const [name] of run.matchAll(/ghcr\.io\S*/g)) expect(["ghcr.io", 'ghcr.io/${REPOSITORY,,}"']).toContain(name);
    }
  });
});

describe("Package workflows", () => {
  it("include the Windows installer and the macOS apps", () => {
    expect(packageFiles).toContain("package-windows.yml");
    expect(packageFiles).toContain("package-macos.yml");
  });

  it("start only by hand, so a pull request never runs them", () => {
    for (const [file, flow] of packageWorkflows) expect(Object.keys(flow.on), file).toEqual(["workflow_dispatch"]);
  });

  it("ask for no job permission, so the token stays read-only", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        const expected = id === "approval" ? {} : id === "gate" ? { contents: "read", "pull-requests": "read" } : isAttach(file, id) ? { contents: "write" } : undefined;
        expect(job.permissions, `${file} job ${id}`).toEqual(expected);
      }
    }
  });

  it("use an environment only to read the signing secrets, and only the release environment", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        if (job.environment === undefined || id === "approval") continue;
        expect(job.environment, `${file} job ${id}`).toBe("release");
        if (isAttach(file, id)) continue;
        expect(JSON.stringify(job), `${file} job ${id}`).toContain("secrets.");
      }
    }
  });

  it("run the release gate, and ask a person to approve a flagged run, before the job that reads the secrets", () => {
    for (const [file, flow] of packageWorkflows) {
      const gated = Object.entries(flow.jobs).filter(([id, job]) => job.environment === "release" && !isAttach(file, id));
      if (gated.length === 0) continue;
      expect(flow.jobs.approval?.environment, file).toBe("release-approval");
      expect(flow.jobs.approval?.if, file).toBe(FLAGGED);
      expect(flow.jobs.approval?.needs, file).toBe("gate");
      expect(flow.jobs.gate?.needs, file).toBe("commit");
      for (const [id, job] of gated) {
        expect(job.needs, `${file} job ${id}`).toEqual(["commit", "gate", "approval"]);
        expect(job.if, `${file} job ${id}`).toBe(
          `\${{ !cancelled() && needs.commit.result == 'success' && ${MAIN_REF} && ${GATE_CLEAR} }}`,
        );
      }
    }
  });

  it("use no dependency cache, so no other run can change what a package contains", () => {
    for (const [file, flow] of packageWorkflows) {
      const steps = Object.values(flow.jobs).flatMap(stepsOf);
      expect(steps.some((step) => step.uses?.startsWith("actions/cache")), file).toBe(false);
      const nodes = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(nodes.length, file).toBeGreaterThan(0);
      for (const step of nodes) {
        expect(step.with?.cache, file).toBeUndefined();
        expect(step.with?.["package-manager-cache"], file).toBe(false);
      }
      if (file !== SNAP) continue;
      for (const step of steps.filter((step) => step.uses?.startsWith("pnpm/action-setup@"))) {
        expect(step.with?.cache, file).toBe(false);
      }
    }
  });

  it("run on GitHub-hosted runners only", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        expect(job["runs-on"], `${file} job ${id}`).toMatch(/^(ubuntu|windows|macos)-[0-9a-z.-]+$/);
      }
    }
  });

  it("package only through package.json scripts that never publish", () => {
    for (const [file, flow] of packageWorkflows) {
      const commands = Object.values(flow.jobs).flatMap(runs);
      expect(commands.some((run) => run.includes("electron-builder")), file).toBe(false);
      const used = commands.flatMap((run) => [...run.matchAll(/\bpnpm (package:[\w:-]+)/g)].map(([, name]) => name));
      expect(used.length, file).toBeGreaterThan(0);
      for (const name of used) {
        expect(scripts[name], `${file} runs ${name}`).toMatch(/electron-builder .*--publish never$/);
      }
    }
  });

  it("upload their packages as one workflow artifact and fail when no file matches", () => {
    for (const [file, flow] of packageWorkflows) {
      const uploads = Object.values(flow.jobs).flatMap(stepsOf).filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
      expect(uploads.length, file).toBe(file === "package-windows.yml" ? 2 : 1);
      for (const upload of uploads) expect(upload.with?.["if-no-files-found"], file).toBe("error");
    }
  });

  it("upload the Microsoft Store package apart from the Windows installer", () => {
    const uploads = Object.values(workflows.get("package-windows.yml")!.jobs).flatMap(stepsOf).filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(uploads.map((step) => step.with?.name)).toEqual([
      "seira-${{ steps.version.outputs.version }}-windows-x64",
      "seira-${{ steps.version.outputs.version }}-windows-x64-store",
    ]);
    expect(uploads[1].with?.path).toBe("${{ runner.temp }}/seira-windows-x64-store/");
    expect(uploads[1].with?.["retention-days"]).toBe(14);
  });
});

describe("macOS attach job", () => {
  const flow = workflows.get(MACOS)!;
  const text = texts.get(MACOS)!;
  const job = flow.jobs[ATTACH]!;
  const steps = stepsOf(job);
  const upload = steps.find((step) => step.run?.includes('release-assets.mjs" upload'))!;
  const check = steps.find((step) => step.run?.includes("sha256sum -c SHA256SUMS-mac.txt"))!;
  const download = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));

  it("is the last job of the macOS workflow, and the package job hands it three outputs", () => {
    expect(Object.keys(flow.jobs)).toEqual(["commit", "gate", "approval", "package", ATTACH]);
    expect(flow.jobs.package!.outputs).toEqual({
      signed: "${{ steps.mode.outputs.signed }}",
      version: "${{ steps.version.outputs.version }}",
      artifact: "${{ steps.version.outputs.artifact }}",
    });
  });

  it("runs only for a signed build of a v* tag on main, after the package job succeeded, after the gate passed or after an approval in the same attempt", () => {
    expect(job.if).toBe(ATTACH_IF);
  });

  it("needs the commit, gate, approval and package jobs", () => {
    expect(job.needs).toEqual(["commit", "gate", "approval", "package"]);
  });

  it("runs on a GitHub-hosted runner with a short timeout, behind the release environment", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.environment).toBe("release");
  });

  it("asks for the write permission on contents and nothing else", () => {
    expect(job.permissions).toEqual({ contents: "write" });
  });

  it("reads no secret", () => {
    expect(JSON.stringify(job)).not.toContain("secrets.");
    expect(job).not.toHaveProperty("secrets");
    expect(text.slice(text.indexOf("\n  attach:"))).not.toContain("secrets.");
  });

  it("checks out only the script, from the workflow commit, without credentials", () => {
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]!.with).toEqual({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
      "sparse-checkout": "scripts/release-assets.mjs",
      "sparse-checkout-cone-mode": false,
    });
  });

  it("downloads the artifact that the package job names, into a folder of the runner", () => {
    const downloads = steps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.uses).toMatch(/^actions\/download-artifact@[0-9a-f]{40}$/);
    expect(downloads[0]!.with).toEqual({
      name: "${{ needs.package.outputs.artifact }}",
      path: "${{ runner.temp }}/seira-macos",
    });
  });

  it("checks the file set and the SHA-256 sums after the download and before the upload", () => {
    expect(steps.indexOf(check)).toBeGreaterThan(download);
    expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(upload));
    expect(check.run).toContain("set -euo pipefail");
    expect(check.run).toContain("exactly the twelve expected files");
    for (const file of MAC_FILES) expect(check.run, file).toContain(file);
  });

  it("uploads the twelve files in the documented order, to this repository, then checks the release", () => {
    expect(upload.run).toContain('release-assets.mjs" upload "$TAG"');
    expect(upload.run).toContain('--repo "$GITHUB_REPOSITORY"');
    const listed = [...upload.run!.matchAll(/"(Seira-\$VERSION-[^"]+)"|\b(latest-mac\.yml|Seira\.dmg|Seira-intel\.dmg|SHA256SUMS-mac\.txt)\b/g)].map(
      (match) => match[1] ?? match[2],
    );
    expect(listed).toEqual(MAC_FILES);
    const checkCommand = 'release-assets.mjs" check "$TAG" --repo "$GITHUB_REPOSITORY"';
    expect(upload.run!.indexOf(checkCommand)).toBeGreaterThan(upload.run!.indexOf('--repo "$GITHUB_REPOSITORY"'));
  });

  it("stops when the ref is not v plus the version of the build", () => {
    expect(upload.run).toContain('[ "$TAG" = "v$VERSION" ]');
  });

  it("passes the token, the tag and the version through env only", () => {
    expect(upload.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      TAG: "${{ inputs.ref }}",
      VERSION: "${{ needs.package.outputs.version }}",
      STAGE: "${{ runner.temp }}/seira-macos",
    });
    for (const run of runs(job)) expect(run).not.toContain("${{");
  });

  it("never publishes, creates, edits or uploads a release from a command line", () => {
    const all = runs(job).join("\n");
    for (const forbidden of ["publish", "gh release create", "gh release edit", "gh release upload", "gh release", "git tag", "git push"]) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });

  it("leaves every other job of the package workflows without a write permission", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, other] of Object.entries(flow.jobs)) {
        if (isAttach(file, id)) continue;
        expect(other.permissions, `${file} job ${id}`).toEqual(id === "approval" ? {} : id === "gate" ? { contents: "read", "pull-requests": "read" } : undefined);
      }
    }
  });
});

describe("CI vitest job", () => {
  const job = workflow.jobs.vitest;
  const shards = VITEST_SHARDS["ubuntu-latest"];

  it("runs the shard count that scripts/ci-scope.mjs names", () => {
    expect(job.strategy?.matrix?.shard).toEqual(Array.from({ length: shards }, (_, index) => index + 1));
    expect(job.name).toContain(`/${shards}`);
    const command = runs(job).find((run) => run.includes("--shard="));
    expect(command).toContain(`--shard=\${{ matrix.shard }}/${shards}`);
  });

  it("runs the worker count that scripts/ci-scope.mjs names", () => {
    const tests = stepsOf(job).find((step) => step.run?.includes("--shard="));
    expect(Number(tests?.env?.SEIRA_VITEST_WORKERS)).toBe(VITEST_WORKERS["ubuntu-latest"]);
  });
});

describe("CI workers job", () => {
  const job = workflow.jobs.workers!;

  it("starts after checks and takes its matrix from the scope output", () => {
    expect(job.needs).toBe("checks");
    expect(job.strategy?.matrix?.worker).toBe("${{ fromJSON(needs.checks.outputs.workers) }}");
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job.name).toBe("worker (${{ matrix.worker.name }})");
    expect(workflow.jobs.checks.outputs?.workers).toBe("${{ steps.scope.outputs.workers }}");
  });

  it("skips a draft pull request, and a run with no Worker in scope", () => {
    expect(job.if).toBe("${{ github.event.pull_request.draft != true && needs.checks.outputs.workers != '[]' }}");
  });

  it("runs the check and the test of the Worker through env", () => {
    const check = stepsOf(job).find((step) => step.run === 'pnpm run "$CHECK"');
    const test = stepsOf(job).find((step) => step.run === 'pnpm run "$TEST"');
    expect(check?.env).toEqual({ CHECK: "${{ matrix.worker.check }}" });
    expect(test?.env).toEqual({ TEST: "${{ matrix.worker.test }}" });
    expect(runs(job).some((run) => run.includes("pnpm install --frozen-lockfile"))).toBe(true);
  });

  it("has a GitHub-hosted runner, no permission, no secret and no environment, and never deploys", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secrets.");
    for (const run of runs(job)) expect(run).not.toMatch(/deploy|wrangler/);
  });

  it("leaves the Worker and Electron unit tests out of the Vitest shards", () => {
    const shardRuns = runs(workflow.jobs.vitest).join("\n");
    expect(shardRuns).not.toContain("broker:test");
    expect(shardRuns).not.toContain("test:electron");
    const electron = stepsOf(workflow.jobs.build).find((step) => step.name === "Electron unit tests");
    expect(electron?.run).toBe("pnpm test:electron");
    expect(electron?.if).toBeUndefined();
  });
});

describe("CI native job", () => {
  const job = workflow.jobs.native!;

  it("starts after checks, and skips a draft and a change that cannot break the native files", () => {
    expect(job.needs).toBe("checks");
    expect(job.if).toBe("${{ github.event.pull_request.draft != true && needs.checks.outputs.native == 'true' }}");
    expect(workflow.jobs.checks.outputs?.native).toBe("${{ steps.scope.outputs.native }}");
  });

  it("runs on a GitHub-hosted Windows and macOS runner, with no permission, no secret and no environment", () => {
    expect(job.strategy?.matrix?.runner).toEqual(["windows-2025", "macos-15"]);
    expect(job.strategy?.["fail-fast"]).toBe(false);
    expect(job["runs-on"]).toBe("${{ matrix.runner }}");
    expect(job.permissions).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secrets.");
  });

  it("builds the helper on Windows only, and runs the native tests without the dependencies", () => {
    const build = stepsOf(job).find((step) => step.run?.includes("prepare-job-fence"));
    expect(build?.run).toBe("node scripts/prepare-job-fence.mjs --test");
    expect(build?.if).toBe("${{ runner.os == 'Windows' }}");
    expect(runs(job)).toContain('node --test "native/**/*.test.mjs"');
    expect(runs(job).some((run) => run.includes("pnpm"))).toBe(false);
  });
});

describe("CI server image job", () => {
  const job = workflow.jobs["server-image"]!;

  it("calls the smoke workflow when the heavy jobs run, and not for a draft", () => {
    expect(job.uses).toBe("./.github/workflows/server-image-smoke.yml");
    expect(job.needs).toBe("checks");
    expect(job.if).toBe("${{ github.event.pull_request.draft != true && needs.checks.outputs.heavy == 'true' }}");
    expect(job.with).toBeUndefined();
    expect(job.permissions).toBeUndefined();
  });
});

describe("CI required checks", () => {
  it("runs the locale, lint and local-detail checks in the checks job", () => {
    const commands = runs(workflow.jobs.checks);
    for (const command of ["pnpm i18n:check", "pnpm lint", "node scripts/check-local-leaks.mjs", "node scripts/check-brand-names.mjs"]) {
      expect(commands.some((run) => run.includes(command)), command).toBe(true);
    }
  });

  it("runs the type check in the build job", () => {
    expect(runs(workflow.jobs.build).some((run) => run.includes("pnpm typecheck"))).toBe(true);
  });
});

const SOME_WORKERS = '[{"name":"push-relay","check":"push:check","test":"push:test"}]';

describe("CI gate", () => {
  const gate = workflow.jobs.gate;
  const others = Object.keys(workflow.jobs).filter((id) => id !== "gate");

  /** Run the real gate script, not a copy of its logic. */
  function runGate(needs: Record<string, { result: string }>, extra: Record<string, string> = {}) {
    const command = runs(gate).find((run) => run.includes("node --input-type=module")) as string;
    const script = /node --input-type=module -e '([^']+)'/.exec(command);
    expect(script).not.toBeNull();
    const check = spawnSync(process.execPath, ["--input-type=module", "-e", script![1]], {
      env: { ...process.env, DRAFT: "", HEAVY: "true", WORKERS: SOME_WORKERS, ...extra, NEEDS: JSON.stringify(needs) },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(check.error).toBeUndefined();
    return check;
  }

  const allWith = (result: string) => Object.fromEntries(others.map((id) => [id, { result }]));

  it("is the one required check, named CI, and runs even after a failure", () => {
    expect(gate.name).toBe("CI");
    expect(gate.if).toBe("${{ !cancelled() }}");
    expect(others.length).toBeGreaterThan(0);
  });

  it("waits for every other job", () => {
    const needs = Array.isArray(gate.needs) ? gate.needs : [gate.needs];
    expect([...needs].sort()).toEqual([...others].sort());
  });

  it("passes when every job succeeded", () => {
    const check = runGate(allWith("success"));
    expect(check.status, check.stderr).toBe(0);
  });

  it.each(["failure", "cancelled", "skipped"])("fails when a job ends as %s", (result) => {
    const check = runGate({ ...allWith("success"), [others[0]]: { result } });
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(others[0]);
  });
});

describe("CI skips jobs only when it may", () => {
  const gate = workflow.jobs.gate;
  const heavy = ["build", "vitest", "server-image"];
  const NONE = "[]";
  type Needs = Record<string, { result: string }>;
  const needs = (result: string): Needs => ({
    checks: { result: "success" },
    build: { result },
    vitest: { result },
    workers: { result },
    "server-image": { result },
    native: { result },
  });
  const run = (extra: Record<string, string>, jobs: Needs) => {
    const command = runs(gate).find((line) => line.includes("node --input-type=module")) as string;
    const script = /node --input-type=module -e '([^']+)'/.exec(command)![1];
    return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, DRAFT: "", HEAVY: "true", WORKERS: SOME_WORKERS, ...extra, NEEDS: JSON.stringify(jobs) }, encoding: "utf8", timeout: 10_000,
    });
  };
  const skipped = (...ids: string[]): Needs => ({ ...needs("success"), ...Object.fromEntries(ids.map((id) => [id, { result: "skipped" }])) });

  it("listens for a draft that becomes ready, with the default types", () => {
    expect((workflow.on.pull_request as { types: string[] }).types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  });

  it("skips build, the shards and the image on a draft, and on a pull request that changes light files only", () => {
    for (const id of heavy) {
      const condition = String(workflow.jobs[id].if);
      expect(condition, id).toContain("github.event.pull_request.draft != true");
      expect(condition, id).toContain("needs.checks.outputs.heavy == 'true'");
      expect(workflow.jobs[id].needs, id).toBe("checks");
    }
    expect(workflow.jobs.checks.if).toBeUndefined();
    expect(workflow.jobs.checks.outputs?.heavy).toBe("${{ steps.scope.outputs.heavy }}");
  });

  it("passes when a draft skipped every job after checks", () => {
    expect(run({ DRAFT: "true" }, needs("skipped")).status).toBe(0);
  });

  it("passes when the scope skipped the heavy jobs and no Worker is in scope", () => {
    expect(run({ HEAVY: "false", WORKERS: NONE, NATIVE: "false" }, needs("skipped")).status).toBe(0);
  });

  it("passes when no Worker is in scope and the heavy jobs ran", () => {
    expect(run({ WORKERS: NONE }, skipped("workers")).status).toBe(0);
  });

  it("passes when the heavy jobs were skipped and a Worker ran", () => {
    expect(run({ HEAVY: "false" }, skipped(...heavy)).status).toBe(0);
  });

  it("fails when workers was skipped while a Worker is in scope", () => {
    const check = run({}, skipped("workers"));
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("workers");
  });

  it("passes when the native job was skipped because its files are not in scope", () => {
    expect(run({ NATIVE: "false" }, skipped("native")).status).toBe(0);
  });

  it("fails when the native job was skipped while its files are in scope", () => {
    const check = run({ NATIVE: "true" }, skipped("native"));
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("native");
  });

  it("fails when the server image was skipped while the heavy jobs run", () => {
    const check = run({}, skipped("server-image"));
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("server-image");
  });

  it("fails when build or the shards were skipped without a reason", () => {
    const check = run({}, skipped("build", "vitest"));
    expect(check.status).toBe(1);
    expect(check.stderr).toContain("build, vitest");
  });

  it("fails when checks did not pass, even on a draft, and when its outputs are empty", () => {
    for (const result of ["failure", "skipped", "cancelled"]) {
      expect(run({ DRAFT: "true" }, { ...needs("skipped"), checks: { result } }).status, result).toBe(1);
    }
    expect(run({ HEAVY: "", WORKERS: "" }, { ...needs("skipped"), checks: { result: "failure" } }).status).toBe(1);
  });

  it.each(["failure", "cancelled"])("fails when any job ends as %s, even when it could be skipped", (result) => {
    for (const id of ["build", "vitest", "workers", "server-image", "native"]) {
      expect(run({ DRAFT: "true" }, { ...needs("skipped"), [id]: { result } }).status, id).toBe(1);
      expect(run({ HEAVY: "false", WORKERS: NONE, NATIVE: "false" }, { ...needs("skipped"), [id]: { result } }).status, id).toBe(1);
    }
  });

  it("cancels an older run of the same pull request only, never a run on main, in the merge queue or a manual start", () => {
    expect(workflow.concurrency?.["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    expect(workflow.concurrency?.group).toContain("format('pr-{0}', github.event.pull_request.number)");
    expect(workflow.concurrency?.group).toContain("format('manual-{0}', github.run_id)");
    expect(workflow.concurrency?.group).toContain("github.ref");
  });

  it("decides the scope from the base and head commits of a pull request or a merge queue entry through env", () => {
    const step = stepsOf(workflow.jobs.checks).find((item) => item.id === "scope");
    expect(step?.run).toBe("node scripts/ci-heavy.mjs");
    expect(step?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}",
    });
  });
});

describe("Release job conditions", () => {
  type Result = "success" | "failure" | "skipped";
  interface Case {
    name: string;
    pass?: string;
    gate?: Result;
    approval: Result;
    approvalAttempt?: number;
    attempt?: number;
    ref?: string;
    first?: Result;
    runs: boolean;
  }

  const cases: Case[] = [
    { name: "runs with no person when the gate passed", pass: "true", approval: "skipped", runs: true },
    { name: "runs again with no person when the gate passes in a later attempt", pass: "true", approval: "skipped", attempt: 2, runs: true },
    { name: "runs when the gate flagged the run and the wait ended in this attempt", pass: "false", approval: "success", approvalAttempt: 1, runs: true },
    { name: "does not run when the gate flagged the run and nobody approved", pass: "false", approval: "skipped", runs: false },
    { name: "does not run when the approval is rejected", pass: "false", approval: "failure", runs: false },
    { name: "does not run on an approval of an earlier attempt", pass: "false", approval: "success", approvalAttempt: 1, attempt: 2, runs: false },
    { name: "runs on an approval of this attempt after a re-run of all jobs", pass: "false", approval: "success", approvalAttempt: 2, attempt: 2, runs: true },
    { name: "does not run when the gate refused", gate: "failure", approval: "skipped", runs: false },
    { name: "does not run when the gate was skipped", gate: "skipped", approval: "skipped", runs: false },
    { name: "does not run when the gate gave no answer", pass: "", approval: "skipped", runs: false },
    { name: "does not run outside main, even when the gate passed", pass: "true", approval: "skipped", ref: "refs/heads/feature", runs: false },
    { name: "does not run outside main, even after an approval", pass: "false", approval: "success", approvalAttempt: 1, ref: "refs/tags/v1.0.0", runs: false },
    { name: "does not run when the first job failed", pass: "true", approval: "skipped", first: "failure", runs: false },
  ];

  const evaluate = (condition: string, scope: Record<string, unknown>) => {
    const expression = condition.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "");
    const startsWith = (text: unknown, start: unknown) =>
      String(text ?? "").toLowerCase().startsWith(String(start).toLowerCase());
    const names = ["needs", "github", "inputs", "cancelled", "startsWith"];
    const values = [scope.needs, scope.github, scope.inputs, () => false, startsWith];
    return Boolean(new Function(...names, `return (${expression});`)(...values));
  };

  const flows = [
    { file: MACOS, job: "package", first: "commit" },
    { file: NPM, job: "publish", first: "commit" },
    { file: IMAGE, job: "publish", first: "image" },
    { file: SNAP, job: "build", first: "commit" },
  ];

  for (const flow of flows) {
    describe(`${flow.file} job ${flow.job}`, () => {
      it.each(cases)("$name", (each) => {
        const needs: Record<string, unknown> = {
          [flow.first]: { result: each.first ?? "success", outputs: {} },
          gate: { result: each.gate ?? "success", outputs: { pass: each.pass } },
          approval: {
            result: each.approval,
            outputs: each.approvalAttempt === undefined ? {} : { attempt: each.approvalAttempt },
          },
        };
        const github = { run_attempt: each.attempt ?? 1, ref: each.ref ?? "refs/heads/main", event_name: "workflow_dispatch" };
        const condition = workflows.get(flow.file)!.jobs[flow.job]!.if!;
        expect(evaluate(condition, { needs, github, inputs: {} })).toBe(each.runs);
      });
    });
  }

  it("never runs the npm publish job for a release event", () => {
    const needs = { commit: { result: "success", outputs: {} }, gate: { result: "success", outputs: { pass: "true" } }, approval: { result: "skipped", outputs: {} } };
    const github = { run_attempt: 1, ref: "refs/heads/main", event_name: "release" };
    expect(evaluate(workflows.get(NPM)!.jobs.publish!.if!, { needs, github, inputs: {} })).toBe(false);
  });

  it.each(cases)("snap-publish.yml job publish: $name", (each) => {
    const needs: Record<string, unknown> = {
      commit: { result: each.first ?? "success", outputs: {} },
      build: { result: "success", outputs: {} },
      gate: { result: each.gate ?? "success", outputs: { pass: each.pass } },
      approval: { result: each.approval, outputs: each.approvalAttempt === undefined ? {} : { attempt: each.approvalAttempt } },
    };
    const github = { run_attempt: each.attempt ?? 1, ref: each.ref ?? "refs/heads/main", event_name: "workflow_dispatch" };
    expect(evaluate(workflows.get(SNAP)!.jobs.publish!.if!, { needs, github, inputs: {} })).toBe(each.runs);
  });

  it("does not run the snap publish job when the build failed or was skipped", () => {
    for (const result of ["failure", "skipped", "cancelled"]) {
      const needs = { commit: { result: "success", outputs: {} }, build: { result, outputs: {} }, gate: { result: "success", outputs: { pass: "true" } }, approval: { result: "skipped", outputs: {} } };
      const github = { run_attempt: 1, ref: "refs/heads/main", event_name: "workflow_dispatch" };
      expect(evaluate(workflows.get(SNAP)!.jobs.publish!.if!, { needs, github, inputs: {} }), result).toBe(false);
    }
  });

  it("never runs the snap build or publish job for a release event", () => {
    const needs = { commit: { result: "success", outputs: {} }, build: { result: "success", outputs: {} }, gate: { result: "success", outputs: { pass: "true" } }, approval: { result: "skipped", outputs: {} } };
    const github = { run_attempt: 1, ref: "refs/heads/main", event_name: "release" };
    for (const id of ["build", "publish"]) expect(evaluate(workflows.get(SNAP)!.jobs[id]!.if!, { needs, github, inputs: {} }), id).toBe(false);
  });

  it.each([
    { pass: "false", asks: true },
    { pass: "true", asks: false },
    { pass: "", asks: false },
    { pass: undefined, asks: false },
  ])("asks for approval when the gate output is $pass: $asks", ({ pass, asks }) => {
    for (const flow of flows) {
      const condition = workflows.get(flow.file)!.jobs.approval!.if!;
      expect(evaluate(condition, { needs: { gate: { outputs: { pass } } }, github: {}, inputs: {} }), flow.file).toBe(asks);
    }
  });
});

describe("Release gate step", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const GATE_FLOWS: { file: string; cases: { name: string; env: Record<string, string> }[] }[] = [
    { file: IMAGE, cases: [{ name: "tag", env: { TAG: "v0.1.1" } }, { name: "commit", env: { TAG: "" } }] },
    { file: NPM, cases: [{ name: "tag", env: { TAG: "v0.1.1" } }] },
    { file: SNAP, cases: [{ name: "tag", env: { TAG: "v0.1.1" } }] },
    { file: MACOS, cases: [{ name: "tag", env: { REF: "v0.1.1" } }, { name: "branch", env: { REF: "main" } }] },
  ];
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  // GitHub starts a `shell: bash` step as `bash --noprofile --norc -eo pipefail`, so the step must survive a non-zero gate exit status.
  const run = (file: string, env: Record<string, string>, gateStatus: number) => {
    const folder = mkdtempSync(join(tmpdir(), "gate-step-"));
    folders.push(folder);
    const bin = join(folder, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/bin/sh\nexit ${gateStatus}\n`, { mode: 0o755 });
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho ${SHA}\n`, { mode: 0o755 });
    const output = join(folder, "output");
    writeFileSync(output, "");
    const step = stepsOf(workflows.get(file)!.jobs.gate!).find((each) => each.id === "gate")!;
    expect(step.shell, file).toBe("bash");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run!], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: output, GH_TOKEN: "token", REPOSITORY: "owner/repo", SHA, TAG: "", REF: "", ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, lines: readFileSync(output, "utf8").split("\n").filter(Boolean) };
  };

  for (const { file, cases } of GATE_FLOWS) {
    describe(file, () => {
      it.each(cases)("writes pass=true when the gate passes ($name run)", ({ env }) => {
        const result = run(file, env, 0);
        expect(result.status).toBe(0);
        expect(result.lines).toContain("pass=true");
        expect(result.lines).not.toContain("pass=false");
      });

      it.each(cases)("writes pass=false and succeeds when the gate flags the run, so the approval job can ask ($name run)", ({ env }) => {
        const result = run(file, env, 1);
        expect(result.status).toBe(0);
        expect(result.lines).toContain("pass=false");
        expect(result.lines).not.toContain("pass=true");
      });

      it.each(cases)("fails and writes no pass when the gate refuses the run or fails ($name run)", ({ env }) => {
        for (const gateStatus of [2, 127]) {
          const result = run(file, env, gateStatus);
          expect(result.status, `exit ${gateStatus}`).toBe(1);
          expect(result.lines.filter((line) => line.startsWith("pass=")), `exit ${gateStatus}`).toEqual([]);
        }
      });
    });
  }

  it("covers every workflow that runs the release gate", () => {
    const gated = [...workflows]
      .filter(([, flow]) => Object.values(flow.jobs).some((job) => runs(job).some((line) => line.includes(`node scripts/${GATE_SCRIPT}`))))
      .map(([file]) => file)
      .sort();
    expect(gated).toEqual(GATE_FLOWS.map((flow) => flow.file).sort());
  });
});
