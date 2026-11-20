import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKERS, WORKER_INPUTS, heavyReason, isLightPath, sourceNames, workersFor, workersOutput, workersToRun } from "./ci-heavy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = (files: string[]) => workersFor(files).map((worker) => worker.name);

const never = () => false;
const always = () => true;

describe("isLightPath", () => {
  it.each(["README.md", "docs/ci.md", "docs/screenshots/a/b.png", "brand/logo/x.webp"])("accepts %s", (file) => {
    expect(isLightPath(file)).toBe(true);
  });
  it.each([
    "package.json", "src/App.tsx", "brand/mascot/cast/cast.json", "brand/mascot/runtime/bot.js", "brand/logo/x.svg",
    "apps/docs/content/docs/a.mdx", "docs/a.json", "server/notes.md", "docs/../src/a.md", "", "docs//a.md", "docs/a\u0000.md",
  ])("refuses %s", (file) => {
    expect(isLightPath(file)).toBe(false);
  });
});

describe("heavyReason", () => {
  it("lets a change of unnamed docs and pictures skip the heavy jobs", () => {
    expect(heavyReason(["README.md", "docs/new-page.md", "docs/screenshots/x/shot.png", "brand/logo/a.png"], never)).toBeNull();
  });
  it("runs the heavy jobs for any other file", () => {
    expect(heavyReason(["README.md", "src/a.ts"], never)).toContain("src/a.ts");
    expect(heavyReason(["docs/ci.md", "package.json"], never)).toContain("package.json");
  });
  it("runs the heavy jobs when a source file names the file", () => {
    const named = (text: string) => text === "team-cloud.md";
    expect(heavyReason(["docs/team-cloud.md"], named)).toContain("team-cloud.md");
  });
  it("runs the heavy jobs when a source file names the folder of a picture", () => {
    const named = (text: string) => text === "brand/logo";
    expect(heavyReason(["brand/logo/a.png"], named)).toContain("brand/logo");
    expect(heavyReason(["docs/pages/a.md"], named)).toBeNull();
  });
  it.each([[[]], [undefined], [null], ["README.md"]])("runs the heavy jobs when the change list is %j", (files) => {
    expect(heavyReason(files as never, never)).not.toBeNull();
  });
  it("runs the heavy jobs when the search cannot tell", () => {
    expect(heavyReason(["README.md"], always)).not.toBeNull();
  });
});

describe("sourceNames in this repository", () => {
  it("finds docs that tests read", () => {
    expect(sourceNames("team-cloud.md")).toBe(true);
    expect(sourceNames("releasing.md")).toBe(true);
  });
  it("finds nothing for a name no source file holds", () => {
    // Built from parts, so that this file does not hold the name.
    expect(sourceNames(["no-such", "page", "8c1f2d7a.md"].join("-"))).toBe(false);
  });
  it("answers true when git cannot run", () => {
    expect(sourceNames("a", "/nonexistent-folder-for-ci-heavy")).toBe(true);
  });
});

describe("workersFor", () => {
  it("runs no Worker for a change of documentation", () => {
    expect(names(["README.md", "docs/ci.md", "src/App.tsx"])).toEqual([]);
  });
  it("runs the Worker whose folder changed", () => {
    expect(names(["cloudflare/push-relay/src/index.ts"])).toEqual(["push-relay"]);
    expect(names(["cloudflare/push-relay/a.ts", "cloudflare/updates/b.ts"])).toEqual(["push-relay", "updates"]);
  });
  it("does not match a folder that only starts with the name", () => {
    expect(names(["cloudflare/push-relay-extra/a.ts"])).toEqual([]);
  });
  it("runs the Worker that reads a file outside its folder", () => {
    expect(names(["shared/composio-storage.ts"])).toEqual(["composio-broker"]);
    expect(names(["companion/src/e2e/vectors/v1.json"])).toEqual(["control-plane"]);
  });
  it.each(WORKER_INPUTS)("runs every Worker for %s", (input) => {
    const file = input.endsWith("/") ? `${input}a.patch` : input;
    expect(names([file, "README.md"])).toEqual(WORKERS.map((worker) => worker.name));
  });
});

describe("workersToRun and workersOutput", () => {
  it("uses the diff for a pull request and a merge queue entry", () => {
    expect(workersToRun("pull_request", ["README.md"])).toEqual([]);
    expect(workersToRun("merge_group", ["cloudflare/updates/a.ts"]).map((worker) => worker.name)).toEqual(["updates"]);
  });
  it("runs every Worker for a push, a manual start and an unreadable diff", () => {
    for (const event of ["push", "workflow_dispatch"]) expect(workersToRun(event, ["README.md"])).toEqual(WORKERS);
    expect(workersToRun("pull_request", null)).toEqual(WORKERS);
    expect(workersToRun("merge_group", null)).toEqual(WORKERS);
  });
  it("writes a compact array of name, check and test", () => {
    expect(JSON.parse(workersOutput(WORKERS))).toEqual(WORKERS.map(({ name, check, test }) => ({ name, check, test })));
    expect(workersOutput([])).toBe("[]");
  });
});

describe("the main block", () => {
  it("writes heavy and workers for a push", () => {
    const folder = mkdtempSync(join(tmpdir(), "ci-heavy-"));
    try {
      const output = join(folder, "output");
      const run = spawnSync(process.execPath, [join(root, "scripts/ci-heavy.mjs")], {
        cwd: root, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, EVENT_NAME: "push", BASE_SHA: "", HEAD_SHA: "", GITHUB_OUTPUT: output },
      });
      expect(run.status, run.stderr).toBe(0);
      const lines = readFileSync(output, "utf8").trim().split("\n");
      expect(lines[0]).toBe("heavy=true");
      expect(lines[1]).toBe(`workers=${workersOutput(WORKERS)}`);
      expect(run.stdout).toContain("Workers that run:");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the Worker list matches the tree", () => {
  const cloudflare = join(root, "cloudflare");
  const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

  const sources = (folder: string): string[] =>
    readdirSync(folder).flatMap((entry) => {
      if (entry === "node_modules") return [];
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) return sources(path);
      return path.endsWith(".ts") ? [path] : [];
    });

  const specifiers = (text: string) =>
    [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.[^"']*)["']/g)].map((match) => match[1]!);

  const target = (from: string, specifier: string) => {
    const base = resolve(dirname(from), specifier);
    const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
    return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? base;
  };

  const listed = (worker: (typeof WORKERS)[number], file: string) =>
    worker.paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));

  it.each(WORKERS.map((worker) => [worker.name, worker] as const))("lists every file outside cloudflare/%s that the Worker imports", (name, worker) => {
    const folder = join(cloudflare, name);
    const missing: string[] = [];
    for (const file of sources(folder)) {
      for (const specifier of specifiers(readFileSync(file, "utf8"))) {
        const path = target(file, specifier);
        if (path.startsWith(`${folder}/`)) continue;
        const outside = relative(root, path);
        if (!listed(worker, outside)) missing.push(`${relative(root, file)} imports ${outside}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has a list entry for every Worker folder, and no entry for a missing folder", () => {
    const folders = readdirSync(cloudflare).filter((entry) => existsSync(join(cloudflare, entry, "wrangler.jsonc"))).sort();
    expect(WORKERS.map((worker) => worker.name).sort()).toEqual(folders);
  });

  it.each(WORKERS.map((worker) => [worker.name, worker] as const))("runs package scripts that exist for %s", (_name, worker) => {
    expect(scripts[worker.check], worker.check).toBeTypeOf("string");
    expect(scripts[worker.test], worker.test).toBeTypeOf("string");
  });
});
