import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { VITEST_SHARDS, VITEST_WORKERS } from "./ci-scope.mjs";

interface Step {
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
  uses?: string;
  environment?: unknown;
  permissions?: Record<string, string> | string;
  strategy?: { matrix?: { shard?: number[] } };
  steps?: Step[];
}

interface Workflow {
  on: Record<string, unknown>;
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
const scripts = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
}).scripts;

const stepsOf = (job: Job) => job.steps ?? [];
const allSteps = () => [...workflows.values()].flatMap((flow) => Object.values(flow.jobs).flatMap(stepsOf));
const allRuns = () => allSteps().flatMap((step) => (step.run === undefined ? [] : [step.run]));
const runs = (job: Job) => stepsOf(job).flatMap((step) => (step.run === undefined ? [] : [step.run]));

describe("CI workflows", () => {
  it("keeps the CI workflow and package workflows only", () => {
    expect(files).toEqual(["ci.yml", ...packageFiles]);
  });

  it("runs on pull requests, pushes to main and manual starts only", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
    for (const [file, flow] of workflows) {
      for (const trigger of ["pull_request_target", "workflow_run", "issue_comment"]) {
        expect(flow.on, `${file} uses ${trigger}`).not.toHaveProperty(trigger);
      }
    }
  });

  it("gives every workflow a read-only token, and write access only to a job behind the release environment", () => {
    for (const [file, flow] of workflows) {
      expect(flow.permissions, file).toEqual({ contents: "read" });
      for (const [id, job] of Object.entries(flow.jobs)) {
        const grants = JSON.stringify(job.permissions ?? {});
        if (grants.includes("write")) expect(job.environment, `${file} job ${id}`).toBe("release");
      }
    }
  });

  it("reads no secret and no token", () => {
    for (const [file, text] of texts) {
      for (const forbidden of ["secrets.", "github.token", "GITHUB_TOKEN", "GH_TOKEN"]) {
        expect(text, `${file} reads ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("drops the credentials of every checkout", () => {
    const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) expect(step.with?.["persist-credentials"]).toBe(false);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...workflows.values()].flatMap((flow) => Object.values(flow.jobs).flatMap((job) => [
      ...(job.uses === undefined ? [] : [job.uses]),
      ...stepsOf(job).flatMap((step) => (step.uses === undefined ? [] : [step.uses])),
    ]));
    expect(uses.length).toBeGreaterThan(0);
    for (const value of uses) expect(value).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
  });

  it("passes event values and inputs through env, never into a command line", () => {
    for (const run of allRuns()) expect(run).not.toMatch(/\$\{\{[^}]*\b(github\.event|github\.head_ref|inputs\.)/);
  });

  it("never creates a tag or publishes a release or a package", () => {
    for (const run of allRuns()) {
      for (const forbidden of ["gh release", "git tag", "git push", "npm publish", "docker push"]) {
        expect(run).not.toContain(forbidden);
      }
      expect(run).not.toMatch(/--publish(?!\s+never\b)/);
    }
  });
});

describe("Package workflows", () => {
  it("include the Windows installer", () => {
    expect(packageFiles).toContain("package-windows.yml");
  });

  it("start only by hand, so a pull request never runs them", () => {
    for (const [file, flow] of packageWorkflows) expect(Object.keys(flow.on), file).toEqual(["workflow_dispatch"]);
  });

  it("ask for no job permission and no environment, so the token stays read-only", () => {
    for (const [file, flow] of packageWorkflows) {
      for (const [id, job] of Object.entries(flow.jobs)) {
        expect(job.permissions, `${file} job ${id}`).toBeUndefined();
        expect(job.environment, `${file} job ${id}`).toBeUndefined();
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
      expect(uploads.length, file).toBe(1);
      expect(uploads[0].with?.["if-no-files-found"], file).toBe("error");
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
    expect(Number(tests?.env?.OMB_VITEST_WORKERS)).toBe(VITEST_WORKERS["ubuntu-latest"]);
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

describe("CI gate", () => {
  const gate = workflow.jobs.gate;
  const others = Object.keys(workflow.jobs).filter((id) => id !== "gate");

  /** Run the real gate script, not a copy of its logic. */
  function runGate(needs: Record<string, { result: string }>) {
    const command = runs(gate).find((run) => run.includes("node --input-type=module")) as string;
    const script = /node --input-type=module -e '([^']+)'/.exec(command);
    expect(script).not.toBeNull();
    const check = spawnSync(process.execPath, ["--input-type=module", "-e", script![1]], {
      env: { ...process.env, NEEDS: JSON.stringify(needs) },
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
