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
const IS_MAINTAINER = "(startsWith(vars.RELEASE_MAINTAINERS || '[]', '[') && contains(fromJSON(vars.RELEASE_MAINTAINERS || '[]'), github.triggering_actor))";
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
    for (const id of ["commit", "approval"]) {
      expect(JSON.stringify(flow.jobs[id]!.permissions ?? {}), id).not.toContain("id-token");
    }
  });

  it("stores and reads no npm token and no secret", () => {
    for (const forbidden of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "_authToken", "secrets.", "github.token", "GITHUB_TOKEN", "GH_TOKEN"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(steps.some((step) => step.with?.["registry-url"] !== undefined)).toBe(false);
  });

  it("publishes behind the release environment, after the commit lookup and the approval", () => {
    expect(publish.environment).toBe("release");
    expect(publish.needs).toEqual(["commit", "approval"]);
    expect(publish.if).toBe(`\${{ !cancelled() && needs.commit.result == 'success' && (${IS_MAINTAINER} || (${APPROVED_NOW})) }}`);
  });

  it("asks a maintainer to approve a run that another person starts, with no permission and no secret", () => {
    const approval = flow.jobs.approval!;
    expect(approval.environment).toBe("release-approval");
    expect(approval.needs).toBe("commit");
    expect(approval.if).toBe(`\${{ !${IS_MAINTAINER} }}`);
    expect(approval.permissions).toEqual({});
    expect(approval.outputs).toEqual({ attempt: "${{ github.run_attempt }}" });
  });

  it("builds the commit of the tag that the commit job found, never the tag name", () => {
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toBe("${{ needs.commit.outputs.sha }}");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const find = flow.jobs.commit!.steps![0]!;
    expect(find.env?.TAG).toBe("${{ github.event_name == 'release' && github.event.release.tag_name || inputs.tag }}");
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
