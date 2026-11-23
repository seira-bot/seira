import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { VITEST_SHARDS, VITEST_WORKERS } from "./ci-scope.mjs";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
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
const image = workflows.get(IMAGE)!;
const smoke = workflows.get(SMOKE)!;
const LOGIN = "${{ secrets.GITHUB_TOKEN }}";
const MAINTAINER_CHECK = "startsWith(vars.RELEASE_MAINTAINERS || '[]', '[') && contains(fromJSON(vars.RELEASE_MAINTAINERS || '[]'), github.triggering_actor)";
const NOT_MAINTAINER = `!(${MAINTAINER_CHECK})`;
const IS_MAINTAINER = `(${MAINTAINER_CHECK})`;
const APPROVED_NOW = "needs.approval.result == 'success' && needs.approval.outputs.attempt == github.run_attempt";
const MACOS = "package-macos.yml";
const READ_TOKEN = "GH_TOKEN: ${{ github.token }}";
const scripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
}).scripts;

const stepsOf = (job: Job) => job.steps ?? [];
const allSteps = () => [...workflows.values()].flatMap((flow) => Object.values(flow.jobs).flatMap(stepsOf));
const allRuns = () => allSteps().flatMap((step) => (step.run === undefined ? [] : [step.run]));
const runs = (job: Job) => stepsOf(job).flatMap((step) => (step.run === undefined ? [] : [step.run]));

describe("CI workflows", () => {
  it("keeps the CI workflow, the milestones workflow, the npm publish workflow, the package workflows and the two server image workflows only", () => {
    expect(files).toEqual(["ci.yml", MILESTONES, NPM, ...packageFiles, SMOKE, IMAGE]);
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
        if (grants.includes("write")) expect(job.environment, `${file} job ${id}`).toBe("release");
      }
    }
  });

  it("uses the release-approval environment only in a job with no permission, no secret and one exact condition", () => {
    for (const [file, flow] of workflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        const where = `${file} job ${id}`;
        if (job.environment === undefined) continue;
        expect(["release", "release-approval"], where).toContain(job.environment);
        if (job.environment !== "release-approval") continue;
        expect(id, where).toBe("approval");
        expect(job.permissions, where).toEqual({});
        expect(JSON.stringify(job), where).not.toContain("secrets.");
        expect(job.if, where).toContain(NOT_MAINTAINER);
        expect(job.outputs, where).toEqual({ attempt: "${{ github.run_attempt }}" });
        const condition = String(job.if).replace("${{ ", "").replace(" }}", "");
        expect(condition.endsWith(NOT_MAINTAINER), where).toBe(true);
        expect(condition.split("RELEASE_MAINTAINERS"), where).toHaveLength(3);
      }
    }
  });

  it("runs a job behind the release environment only for a maintainer or after an approval in the same attempt", () => {
    const gated = [...workflows].flatMap(([file, flow]) =>
      Object.entries(flow.jobs)
        .filter(([, job]) => job.environment === "release")
        .map(([id, job]) => ({ where: `${file} job ${id}`, job })),
    );
    expect(gated.length).toBeGreaterThan(0);
    for (const { where, job } of gated) {
      expect([job.needs].flat(), where).toContain("approval");
      expect(job.if, where).toContain(`(${IS_MAINTAINER} || (${APPROVED_NOW}))`);
      expect(job.if, where).not.toContain("'skipped'");
    }
  });

  it("reads no token, except the server image workflow once to sign in to the registry, the macOS commit step once to read the repository and the milestones step once to call the GitHub API", () => {
    expect(texts.get(IMAGE)!.split(LOGIN)).toHaveLength(2);
    expect(texts.get(MACOS)!.split(READ_TOKEN)).toHaveLength(2);
    expect(texts.get(MILESTONES)!.split(READ_TOKEN)).toHaveLength(2);
    for (const [file, original] of texts) {
      const text = file === IMAGE ? original.replace(LOGIN, "") : file === MACOS || file === MILESTONES ? original.replace(READ_TOKEN, "") : original;
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
        if (count(JSON.stringify(job)) > 0) expect(job.environment, `${file} job ${id}`).toBe("release");
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

  it("reads a secret only in the macOS package workflow, for the Apple signature, and in the server image workflow", () => {
    expect(files.filter((file) => texts.get(file)!.includes("secrets."))).toEqual(["package-macos.yml", IMAGE]);
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
        save: { description: expect.any(String), required: false, type: "boolean", default: false },
      },
    });
    expect(smoke.concurrency).toBeUndefined();
    expect(Object.keys(smoke.jobs)).toEqual(["image", "cloud-home"]);
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
    expect(checkouts[0]!.with?.ref).toBe("${{ inputs.tag && format('refs/tags/{0}', inputs.tag) || '' }}");
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
    expect(build.with).toEqual({ tag: "${{ inputs.tag }}", save: "${{ github.ref == 'refs/heads/main' }}" });
    expect(build.steps).toBeUndefined();
    expect(build.permissions).toBeUndefined();
    expect(build.environment).toBeUndefined();
  });

  it("asks a maintainer to approve a run that another person starts, after the build and only on main", () => {
    expect(approval.needs).toBe("image");
    expect(approval.if).toBe(`${ON_MAIN} && ${NOT_MAINTAINER}`);
    expect(approval.environment).toBe("release-approval");
    expect(approval.permissions).toEqual({});
    expect(approval["runs-on"]).toBe("ubuntu-24.04");
  });

  it("publishes only from a manual run on main, after a successful build and the approval, behind the release environment", () => {
    expect(publish.needs).toEqual(["image", "approval"]);
    expect(publish.if).toBe(
      `\${{ !cancelled() && ${ON_MAIN} && needs.image.result == 'success' && (${IS_MAINTAINER} || (${APPROVED_NOW})) }}`,
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
        expect(job.permissions, `${file} job ${id}`).toEqual(id === "approval" ? {} : undefined);
      }
    }
  });

  it("use an environment only to read the signing secrets, and only the release environment", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        if (job.environment === undefined || id === "approval") continue;
        expect(job.environment, `${file} job ${id}`).toBe("release");
        expect(JSON.stringify(job), `${file} job ${id}`).toContain("secrets.");
      }
    }
  });

  it("ask a maintainer to approve a run that another person starts, before the job that reads the secrets", () => {
    for (const [file, flow] of packageWorkflows) {
      const gated = Object.entries(flow.jobs).filter(([, job]) => job.environment === "release");
      if (gated.length === 0) continue;
      expect(flow.jobs.approval?.environment, file).toBe("release-approval");
      expect(flow.jobs.approval?.if, file).toBe(`\${{ ${NOT_MAINTAINER} }}`);
      expect(flow.jobs.approval?.needs, file).toBe("commit");
      for (const [id, job] of gated) {
        expect(job.needs, `${file} job ${id}`).toEqual(["commit", "approval"]);
        expect(job.if, `${file} job ${id}`).toBe(
          `\${{ !cancelled() && needs.commit.result == 'success' && (${IS_MAINTAINER} || (${APPROVED_NOW})) }}`,
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
    for (const command of ["pnpm i18n:check", "pnpm lint", "node scripts/check-local-leaks.mjs"]) {
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
    actor: string;
    attempt: number;
    approval: Result;
    approvalAttempt?: number;
    variable?: string;
    first?: Result;
    runs: boolean;
  }

  const MAINTAINERS = '["maint"]';
  const cases: Case[] = [
    { name: "runs when a maintainer starts it", actor: "maint", attempt: 1, approval: "skipped", runs: true },
    { name: "runs when another person starts it and a maintainer approves", actor: "other", attempt: 1, approval: "success", approvalAttempt: 1, runs: true },
    { name: "does not run when the approval is rejected", actor: "other", attempt: 1, approval: "failure", runs: false },
    { name: "does not run when another person re-runs a maintainer's run", actor: "other", attempt: 2, approval: "skipped", runs: false },
    { name: "does not run when another person re-runs an approved run", actor: "other", attempt: 2, approval: "success", approvalAttempt: 1, runs: false },
    { name: "runs when another person re-runs all jobs and a maintainer approves again", actor: "other", attempt: 2, approval: "success", approvalAttempt: 2, runs: true },
    { name: "runs when a maintainer re-runs another person's approved run", actor: "maint", attempt: 2, approval: "success", approvalAttempt: 1, runs: true },
    { name: "does not run when the maintainer list is missing and nobody approved", actor: "other", attempt: 1, approval: "skipped", variable: undefined, runs: false },
    { name: "does not run when the maintainer list is not a JSON array, even if it holds the login", actor: "maint", attempt: 1, approval: "skipped", variable: '"maint"', runs: false },
    { name: "does not run when the first job failed, even for a maintainer", actor: "maint", attempt: 1, approval: "skipped", first: "failure", runs: false },
  ];

  const evaluate = (condition: string, scope: Record<string, unknown>) => {
    const expression = condition.trim().replace(/^\$\{\{/, "").replace(/\}\}$/, "");
    const contains = (search: unknown, item: unknown) =>
      Array.isArray(search)
        ? search.some((each) => String(each).toLowerCase() === String(item).toLowerCase())
        : String(search).toLowerCase().includes(String(item).toLowerCase());
    const startsWith = (text: unknown, start: unknown) =>
      String(text ?? "").toLowerCase().startsWith(String(start).toLowerCase());
    const names = ["needs", "github", "vars", "cancelled", "fromJSON", "contains", "startsWith"];
    const values = [scope.needs, scope.github, scope.vars, () => false, JSON.parse, contains, startsWith];
    return Boolean(new Function(...names, `return (${expression});`)(...values));
  };

  const flows = [
    { file: MACOS, job: "package", first: "commit", extra: {} },
    { file: NPM, job: "publish", first: "commit", extra: {} },
    { file: IMAGE, job: "publish", first: "image", extra: { event_name: "workflow_dispatch", ref: "refs/heads/main" } },
  ];

  for (const flow of flows) {
    describe(`${flow.file} job ${flow.job}`, () => {
      it.each(cases)("$name", (each) => {
        const needs: Record<string, unknown> = {
          [flow.first]: { result: each.first ?? "success", outputs: {} },
          approval: {
            result: each.approval,
            outputs: each.approvalAttempt === undefined ? {} : { attempt: each.approvalAttempt },
          },
        };
        const vars = !("variable" in each)
          ? { RELEASE_MAINTAINERS: MAINTAINERS }
          : each.variable === undefined
            ? {}
            : { RELEASE_MAINTAINERS: each.variable };
        const github = { triggering_actor: each.actor, run_attempt: each.attempt, ...flow.extra };
        const condition = workflows.get(flow.file)!.jobs[flow.job]!.if!;
        expect(evaluate(condition, { needs, github, vars })).toBe(each.runs);
      });
    });
  }

  it.each([
    { name: "a maintainer", variable: '["maint"]', asks: false },
    { name: "another person", variable: '["maint", "boss"]', asks: true, actor: "other" },
    { name: "a maintainer when the list is missing", variable: undefined, asks: true },
    { name: "a maintainer when the list is a JSON string that holds the login", variable: '"maintainers"', asks: true },
  ])("asks for approval for $name: $asks", ({ variable, asks, actor }) => {
    for (const flow of flows) {
      const vars = variable === undefined ? {} : { RELEASE_MAINTAINERS: variable };
      const github = { triggering_actor: actor ?? "maint", run_attempt: 1, ...flow.extra };
      const condition = workflows.get(flow.file)!.jobs.approval!.if!;
      expect(evaluate(condition, { needs: {}, github, vars }), flow.file).toBe(asks);
    }
  });
});
