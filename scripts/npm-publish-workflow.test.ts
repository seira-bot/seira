import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  environment?: unknown;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: { release?: { types?: string[] }; workflow_dispatch?: { inputs?: Record<string, { required?: boolean }> } };
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const url = new URL("../.github/workflows/npm-publish.yml", import.meta.url);
const text = readFileSync(url, "utf8");
const flow = parse(text) as Workflow;
const publish = flow.jobs.publish!;
const steps = publish.steps ?? [];
const stepNamed = (name: string) => steps.find((step) => step.name === name)!;
const APPROVED_NOW = "needs.approval.result == 'success' && needs.approval.outputs.attempt == github.run_attempt";

describe("npm publish workflow", () => {
  it("starts when a release is published, or by hand with a tag", () => {
    expect(Object.keys(flow.on).sort()).toEqual(["release", "workflow_dispatch"]);
    expect(flow.on.release?.types).toEqual(["published"]);
    expect(flow.on.workflow_dispatch?.inputs?.tag?.required).toBe(true);
  });

  it("keeps a read-only token, and asks for the OIDC token in the publish job only", () => {
    expect(flow.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    for (const id of ["redispatch", "commit", "gate", "approval"]) {
      expect(JSON.stringify(flow.jobs[id]!.permissions ?? {}), id).not.toContain("id-token");
    }
  });

  it("stores and reads no npm token and no secret", () => {
    for (const forbidden of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "_authToken", "secrets.", "GITHUB_TOKEN"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(JSON.stringify(publish), "publish").not.toMatch(/github\.token|GH_TOKEN/);
    expect(steps.some((step) => step.with?.["registry-url"] !== undefined)).toBe(false);
  });

  it("publishes behind the release environment, on main only, after the gate passed or after an approval in this attempt", () => {
    expect(publish.environment).toBe("release");
    expect(publish.needs).toEqual(["commit", "gate", "approval"]);
    expect(publish.if).toBe(
      `\${{ !cancelled() && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && needs.commit.result == 'success' && needs.gate.result == 'success' && (needs.gate.outputs.pass == 'true' || (${APPROVED_NOW})) }}`,
    );
    expect(text).not.toContain("RELEASE_MAINTAINERS");
  });

  it("runs the release gate on the tag that the commit job found", () => {
    const gate = flow.jobs.gate!;
    expect(gate.needs).toBe("commit");
    expect(gate.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const run = gate.steps!.find((step) => step.id === "gate")!;
    expect(run.env?.TAG).toBe("${{ needs.commit.outputs.tag }}");
    expect(run.env?.SHA).toBe("${{ needs.commit.outputs.sha }}");
    expect(run.run).toContain('node scripts/release-gate.mjs --tag "$TAG" --sha "$SHA"');
    expect(run.run).not.toContain("${{");
  });

  it("starts the workflow again on main when a release is published, and runs no other job for that event", () => {
    const redispatch = flow.jobs.redispatch!;
    expect(redispatch.if).toBe("github.event_name == 'release'");
    expect(redispatch.permissions).toEqual({ actions: "write", contents: "read" });
    expect(redispatch.environment).toBeUndefined();
    const step = redispatch.steps![0]!;
    expect(step.env).toEqual({ GH_TOKEN: "${{ github.token }}", TAG: "${{ github.event.release.tag_name }}" });
    expect(step.run).toBe('gh workflow run npm-publish.yml --repo "$GITHUB_REPOSITORY" --ref main -f tag="$TAG"');
    for (const [id, job] of Object.entries(flow.jobs)) {
      if (id === "redispatch") continue;
      const guarded = id === "commit" ? job.if === "github.event_name == 'workflow_dispatch'" : id === "gate" || id === "approval" || id === "publish";
      expect(guarded, id).toBe(true);
    }
  });

  it("asks a person to approve a run that the gate flagged, with no permission and no secret", () => {
    const approval = flow.jobs.approval!;
    expect(approval.environment).toBe("release-approval");
    expect(approval.needs).toBe("gate");
    expect(approval.if).toBe("${{ needs.gate.outputs.pass == 'false' }}");
    expect(approval.permissions).toEqual({});
    expect(approval.outputs).toEqual({ attempt: "${{ github.run_attempt }}" });
  });

  it("builds the commit of the tag that the commit job found, never the tag name", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toBe("${{ needs.commit.outputs.sha }}");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const find = flow.jobs.commit!.steps![0]!;
    expect(find.env?.TAG).toBe("${{ inputs.tag }}");
    expect(find.run).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(find.run).toContain("^[0-9a-f]{40}$");
  });

  it("stops when the tag and the version in package.json differ", () => {
    expect(stepNamed("Check the version").run).toContain('[ "$TAG" = "v$version" ]');
  });

  it("skips every later step when the version is already on npm", () => {
    const look = stepNamed("Look for the version on npm");
    expect(look.run).toContain('npm view "@seira-bot/seira@$VERSION" version');
    const after = steps.slice(steps.indexOf(look) + 1);
    expect(after.length).toBeGreaterThan(0);
    for (const step of after) expect(step.if, step.name).toBe("steps.exists.outputs.exists != 'true'");
  });

  it("makes sure npm is 11.5.1 or newer", () => {
    const run = stepNamed("Make sure npm can publish with OIDC").run!;
    expect(run).toContain("npm install --global npm@11.5.1");
    expect(run).toContain("b===5&&c>=1");
  });

  it("publishes the packed tarball once, with provenance and public access", () => {
    const publishes = steps.filter((step) => step.run?.includes("npm publish"));
    expect(publishes).toHaveLength(1);
    expect(publishes[0]!.run).toContain('npm publish "release/npm/seira-bot-seira-$VERSION.tgz" --provenance --access public');
    expect(Object.keys(publishes[0]!.env ?? {})).toEqual(["VERSION"]);
  });

  it("builds the package with the same scripts as the manual steps", () => {
    expect(stepNamed("Build the package").run).toBe("pnpm build:server && pnpm exec vite build && node scripts/build-npm-package.mjs");
    expect(stepNamed("Install").run).toBe("pnpm install --frozen-lockfile");
  });

  it("uses no dependency cache", () => {
    const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"))!;
    expect(node.with?.["package-manager-cache"]).toBe(false);
    expect(node.with?.cache).toBeUndefined();
  });
});
