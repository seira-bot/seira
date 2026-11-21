// Refuses a release whose update feed or checksum file names a file that is not an uploaded asset of the same size,
// uploads every feed (latest*.yml) after all other files, and publishes a draft release only when every platform has its files.
// It uses `gh` only.
// Exit status: 0 every check passed, 1 a check or an upload failed, 2 wrong use or an API error.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = /^v\d+\.\d+\.\d+(-[\w.]+)?$/;
const FEED = /^latest(-[\w-]+)?\.yml$/;
const SUMS = /^SHA256SUMS-[\w.-]+\.txt$/;

export const USAGE = `Usage: node scripts/release-assets.mjs check <tag> [--repo <owner>/<name>]
       node scripts/release-assets.mjs upload <tag> <file>... [--repo <owner>/<name>]
       node scripts/release-assets.mjs publish <tag> [--repo <owner>/<name>]`;

export class UsageError extends Error {
  exitCode = 2;
}

export function parseArgs(argv) {
  const out = { command: null, tag: null, files: [], repo: null, help: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--repo") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError("--repo needs a value");
      out.repo = value;
    } else if (arg.startsWith("--")) throw new UsageError(`unknown argument ${arg}`);
    else rest.push(arg);
  }
  if (out.help) return out;
  [out.command, out.tag, ...out.files] = rest;
  if (!["check", "upload", "publish"].includes(out.command)) throw new UsageError("the command must be check, upload or publish");
  if (!out.tag || !TAG.test(out.tag)) throw new UsageError("the tag must look like v1.2.3");
  if (out.command !== "upload" && out.files.length) throw new UsageError(`${out.command} takes no files`);
  if (out.command === "upload" && !out.files.length) throw new UsageError("upload needs at least one file");
  if (out.repo && !/^[\w.-]+\/[\w.-]+$/.test(out.repo)) throw new UsageError("--repo must look like owner/name");
  return out;
}

export function repoFromRemote(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export const isFeed = (name) => FEED.test(basename(String(name)));
export const isSums = (name) => SUMS.test(basename(String(name)));

const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
const fileName = (value) => {
  const last = unquote(value).split("/").pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** The files that an update feed names: its `files[].url` with `size`, and its top-level `path`. */
export function feedFiles(text) {
  const found = new Map();
  let path = null;
  let current = null;
  let inFiles = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const top = /^([\w-]+):\s*(.*)$/.exec(line);
    if (top) {
      inFiles = top[1] === "files";
      current = null;
      if (top[1] === "path") path = fileName(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+url:\s*(.+)$/.exec(line);
    const size = /^\s+size:\s*(\d+)\s*$/.exec(line);
    if (item) {
      current = { name: fileName(item[1]), size: undefined };
      found.set(current.name, current);
    } else if (size && current) current.size = Number(size[1]);
  }
  if (path && !found.has(path)) found.set(path, { name: path, size: undefined });
  return [...found.values()];
}

/** The file names of a checksum file. A `*` before a name marks a binary line. */
export function sumsFiles(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^[0-9a-fA-F]{32,}\s+\*?(.+?)\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

export function judgeAssets({ assets, texts }) {
  const problems = [];
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  for (const asset of assets) if (asset.state !== "uploaded") problems.push(`${asset.name} is not complete (state ${asset.state})`);
  const present = (name) => {
    const asset = byName.get(name);
    return asset && asset.state === "uploaded" ? asset : null;
  };
  for (const [source, text] of Object.entries(texts)) {
    const named = isFeed(source) ? feedFiles(text) : sumsFiles(text).map((name) => ({ name, size: undefined }));
    if (!named.length) problems.push(`${source} names no file`);
    for (const { name, size } of named) {
      const asset = present(name);
      if (!asset) problems.push(`${source} names ${name}, which is not an uploaded asset of the release`);
      else if (size !== undefined && asset.size !== size) problems.push(`${source} names ${name} with size ${size}, but the asset has size ${asset.size}`);
    }
  }
  return problems;
}

const required = (version) => ({
  Linux: ["latest-linux.yml", "SHA256SUMS-linux-x64.txt", "Seira.AppImage", "Seira-amd64.deb", `Seira-${version}-x86_64.flatpak`],
  Windows: ["latest.yml", "SHA256SUMS-windows-x64.txt", "Seira-setup.exe"],
  macOS: ["latest-mac.yml", "SHA256SUMS-mac.txt", "Seira.dmg", "Seira-intel.dmg"],
});
const MAC_ASSET = /(\.dmg|-(arm64|x64)\.zip)(\.blockmap)?$|^latest-mac\.yml$|^SHA256SUMS-mac\.txt$/;

/** The required assets that the release lacks, as `{ platform, name }`. macOS is required only when the release has a macOS file. */
export function missingForPublish(assets, tag) {
  const uploaded = new Set(assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  const platforms = assets.some((asset) => MAC_ASSET.test(asset.name)) ? ["Linux", "Windows", "macOS"] : ["Linux", "Windows"];
  const names = required(String(tag).replace(/^v/, ""));
  return platforms.flatMap((platform) => names[platform].filter((name) => !uploaded.has(name)).map((name) => ({ platform, name })));
}

export function uploadOrder(files) {
  return { first: files.filter((file) => !isFeed(file)), last: files.filter(isFeed) };
}

async function pages(api, path) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const items = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    found.push(...items);
    if (items.length < 100) break;
  }
  return found;
}

/** A draft release is not in the tag endpoint, so the release is found in the list. */
export async function findRelease(api, repo, tag) {
  for (let page = 1; page <= 10; page++) {
    const releases = await api(`repos/${repo}/releases?per_page=50&page=${page}`);
    const found = releases.find((release) => release.tag_name === tag);
    if (found) return found;
    if (releases.length < 50) break;
  }
  return null;
}

export async function check({ api, repo = "owner/name", tag, log = console.log }) {
  const release = await findRelease(api, repo, tag);
  if (!release) {
    log(`FAIL no release for tag ${tag} in ${repo}`);
    return 1;
  }
  const assets = await pages(api, `repos/${repo}/releases/${release.id}/assets`);
  const texts = {};
  for (const asset of assets) {
    if ((isFeed(asset.name) || isSums(asset.name)) && asset.state === "uploaded") {
      texts[asset.name] = await api(`repos/${repo}/releases/assets/${asset.id}`, { raw: true });
    }
  }
  const problems = judgeAssets({ assets, texts });
  for (const problem of problems) log(`FAIL ${problem}`);
  if (problems.length) return 1;
  const names = Object.keys(texts);
  log(`ok   ${assets.length} assets${release.draft ? " (draft release)" : ""}, all complete`);
  for (const name of names) log(`ok   every file that ${name} names is an uploaded asset`);
  if (!names.length) log("note no update feed or checksum file on the release yet");
  return 0;
}

export async function upload({ api, run, repo = "owner/name", tag, files, log = console.log, exists = existsSync }) {
  const missing = files.filter((file) => !exists(file));
  for (const file of missing) log(`FAIL ${file} does not exist`);
  if (missing.length) return 2;
  const { first, last } = uploadOrder(files);
  const send = async (file) => {
    log(`up   ${basename(file)}`);
    try {
      await run(["release", "upload", tag, file, "--repo", repo]);
      return true;
    } catch (error) {
      log(`FAIL upload of ${basename(file)} failed: ${error.message}`);
      return false;
    }
  };
  for (const file of first) if (!(await send(file))) return 1;
  if ((await check({ api, repo, tag, log })) !== 0) {
    log(last.length ? "Update feeds not uploaded." : "Check failed.");
    return 1;
  }
  for (const file of last) if (!(await send(file))) return 1;
  return check({ api, repo, tag, log });
}

export async function publish({ api, run, repo = "owner/name", tag, log = console.log }) {
  const release = await findRelease(api, repo, tag);
  if (!release) {
    log(`FAIL no release for tag ${tag} in ${repo}`);
    return 1;
  }
  const read = () => pages(api, `repos/${repo}/releases/${release.id}/assets`);
  const reportMissing = (assets) => {
    const missing = missingForPublish(assets, tag);
    for (const { platform, name } of missing) log(`FAIL ${platform}: ${name} is missing`);
    return missing.length;
  };
  if (!release.draft) {
    log(`note ${tag} is already published, so nothing changes`);
    return reportMissing(await read()) ? 1 : 0;
  }
  if ((await check({ api, repo, tag, log })) !== 0) {
    log(`${tag} stays a draft.`);
    return 1;
  }
  if (reportMissing(await read())) {
    log(`${tag} stays a draft.`);
    return 1;
  }
  try {
    await run(["release", "edit", tag, "--draft=false", "--latest", "--repo", repo]);
  } catch (error) {
    log(`FAIL publish of ${tag} failed: ${error.message}`);
    return 1;
  }
  log(`ok   ${tag} is published and latest`);
  return check({ api, repo, tag, log });
}

function gh(args, options = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const text = String(error.stderr ?? error.message);
    const wrapped = new Error(text.trim().split("\n")[0] || "gh failed");
    wrapped.status = /HTTP 404/.test(text) ? 404 : undefined;
    throw wrapped;
  }
}

function ghApi(path, options = {}) {
  if (options.raw) return gh(["api", "-H", "Accept: application/octet-stream", path]);
  return JSON.parse(gh(["api", path]));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(USAGE);
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" });
  const repo = args.repo ?? repoFromRemote(origin);
  if (!repo) throw new UsageError("could not read the GitHub repository from the origin remote; pass --repo");
  const api = async (path, options) => ghApi(path, options);
  const run = async (list) => gh(list, { stdio: "inherit" });
  if (args.command === "check") process.exitCode = await check({ api, repo, tag: args.tag });
  else if (args.command === "publish") process.exitCode = await publish({ api, run, repo, tag: args.tag });
  else process.exitCode = await upload({ api, run, repo, tag: args.tag, files: args.files });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`release-assets: ${error.message}`);
    if (error instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  });
}
