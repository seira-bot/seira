// Does a pull request need the heavy CI jobs (build and the vitest shards)?
// Only a change to files that no source file reads can skip them: documentation
// and pictures. `checks` always runs, and it holds the tests that read the docs
// (scripts/testing/verification-docs.test.ts). Any other file, any file a source
// file names, and any doubt give "heavy". docs/ci.md describes this rule.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f\d]{40}(?:[a-f\d]{24})?$/i;

/** The only paths that can skip the heavy jobs: Markdown at the root, docs pages and pictures, brand pictures. */
export const LIGHT_PATHS = [
  /^[^/]+\.md$/,
  /^docs\/.+\.(?:md|png|jpe?g|gif|webp)$/i,
  /^brand\/.+\.(?:png|jpe?g|gif|webp)$/i,
];

export const isLightPath = (file) =>
  typeof file === "string" && !/\p{Cc}/u.test(file) && !file.split("/").some((part) => !part || part === "." || part === "..")
  && LIGHT_PATHS.some((pattern) => pattern.test(file));

/**
 * The Cloudflare Workers that CI checks. `check` and `test` are root package scripts. `paths` are the files outside
 * `cloudflare/<name>/` that the Worker reads. `fast` tests run on the root dependencies in seconds, so the pre-push
 * check runs them too.
 */
export const WORKERS = [
  { name: "bug-reports", check: "bugs:check", test: "bugs:test", fast: true, paths: [] },
  { name: "composio-broker", check: "broker:check", test: "broker:test", fast: true, paths: ["shared/composio-storage.ts", "shared/connector-account-identity.ts", "shared/connector-account-link.ts"] },
  { name: "control-plane", check: "control-plane:check", test: "control-plane:test", fast: false, paths: ["companion/src/e2e/vectors/v1.json"] },
  { name: "push-relay", check: "push:check", test: "push:test", fast: true, paths: [] },
  { name: "updates", check: "updates:check", test: "updates:test", fast: true, paths: [] },
];

/** Files that every Worker reads: the dependencies, and the CI files that run the Workers. A path that ends in "/" is a folder. */
export const WORKER_INPUTS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches/", ".github/workflows/ci.yml", "scripts/ci-heavy.mjs"];

const matches = (path, file) => (path.endsWith("/") ? file.startsWith(path) : file === path);

/** The Workers that a change to `files` can break. */
export function workersFor(files) {
  if (files.some((file) => WORKER_INPUTS.some((path) => matches(path, file)))) return [...WORKERS];
  return WORKERS.filter((worker) => files.some((file) => file.startsWith(`cloudflare/${worker.name}/`) || worker.paths.some((path) => matches(path, file))));
}

/**
 * The reason a change needs the heavy jobs, or null when it does not.
 * `named(text)` tells whether a source file contains `text`. It is true when unsure.
 */
export function heavyReason(files, named) {
  if (!Array.isArray(files) || files.length === 0) return "the list of changed files is empty or unreadable";
  for (const file of files) {
    if (!isLightPath(file)) return `${JSON.stringify(file)} can affect the build or a test`;
    // A test can name a file or the folder it sits in.
    const terms = file.endsWith(".md") ? [basename(file)] : [basename(file), dirname(file)];
    const hit = terms.find((term) => named(term));
    if (hit) return `a source file names ${JSON.stringify(hit)} (changed: ${file})`;
  }
  return null;
}

/** True when a tracked source file (not Markdown, not a picture, not binary) contains `text`. True also when git fails. */
export function sourceNames(text, cwd = process.cwd()) {
  try {
    execFileSync("git", ["grep", "-lIF", "-e", text, "--", ".", ":(exclude)*.md", ":(exclude)*.mdx", ":(exclude)pnpm-lock.yaml", ":(exclude)internal"], {
      cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch (error) {
    return error?.status === 1 ? false : true;
  }
}

function changedFiles(base, head) {
  const diff = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"], {
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  return diff && diff.endsWith("\0") ? diff.slice(0, -1).split("\0") : [];
}

/** The events whose diff decides the scope: a pull request, and a merge queue entry that holds the same change. */
export const DIFF_EVENTS = ["pull_request", "merge_group"];

/** The Workers that a CI run checks: every Worker, except for a diff event whose changed files name fewer. */
export function workersToRun(eventName, files) {
  return DIFF_EVENTS.includes(eventName) && Array.isArray(files) ? workersFor(files) : [...WORKERS];
}

export const workersOutput = (workers) => JSON.stringify(workers.map(({ name, check, test }) => ({ name, check, test })));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { EVENT_NAME, BASE_SHA, HEAD_SHA, GITHUB_OUTPUT } = process.env;
  let reason = `the event is ${EVENT_NAME}, not a pull request or a merge queue entry`;
  let files = null;
  if (DIFF_EVENTS.includes(EVENT_NAME)) {
    try {
      if (![BASE_SHA, HEAD_SHA].every((sha) => typeof sha === "string" && SHA.test(sha))) throw new Error("missing or invalid commit SHAs");
      files = changedFiles(BASE_SHA, HEAD_SHA);
      reason = heavyReason(files, (text) => sourceNames(text));
    } catch (error) {
      files = null;
      reason = `the change could not be read (${error.message})`;
    }
  }
  const workers = workersToRun(EVENT_NAME, files);
  console.log(reason ? `CI scope: heavy jobs run, because ${reason}` : "CI scope: documentation and pictures only, so only checks run");
  console.log(workers.length ? `CI scope: Workers that run: ${workers.map((worker) => worker.name).join(", ")}` : "CI scope: no Worker runs");
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `heavy=${reason ? "true" : "false"}\nworkers=${workersOutput(workers)}\n`);
}
