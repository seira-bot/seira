import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const ZERO_SHA = "0".repeat(40);
const TITLE = /^v(\d+)\.(\d+)\.(\d+)$/;
const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

export function nextPatch(version) {
  const match = PLAIN_VERSION.exec(String(version));
  if (match === null) throw new Error(`Not a version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function versionOfTitle(title) {
  const match = TITLE.exec(String(title));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function createApi({ token, repository, fetch: fetchImpl = globalThis.fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "seira-milestones",
  };

  async function call(method, path, body) {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    repository,
    rest: (method, path, body) => call(method, path, body),
    async graphql(query, variables) {
      const answer = await call("POST", "/graphql", { query, variables });
      if (answer?.errors?.length) {
        const error = new Error("GitHub API POST /graphql failed with a GraphQL error");
        error.status = 200;
        throw error;
      }
      return answer.data;
    },
  };
}

async function listMilestones(api, repository) {
  const all = [];
  for (let page = 1; ; page += 1) {
    const items = await api.rest("GET", `/repos/${repository}/milestones?state=all&per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

async function readVersion(api, repository, sha) {
  const file = await api.rest("GET", `/repos/${repository}/contents/package.json?ref=${sha}`);
  return JSON.parse(Buffer.from(file.content, "base64").toString("utf8")).version;
}

async function isLatestRelease(api, repository, tag) {
  try {
    const latest = await api.rest("GET", `/repos/${repository}/releases/latest`);
    return latest.tag_name === tag;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

async function pullOfMergeCommit(api, repository, sha, message) {
  const number = /\(#(\d+)\)$/.exec(String(message).split("\n")[0].trim())?.[1];
  if (number === undefined) return [];
  try {
    const pull = await api.rest("GET", `/repos/${repository}/pulls/${number}`);
    return pull.merge_commit_sha === sha ? [pull] : [];
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
}

async function createMilestone(api, repository, title) {
  try {
    return await api.rest("POST", `/repos/${repository}/milestones`, {
      title,
      description: `Changes that ship in Seira ${title}.`,
    });
  } catch (error) {
    if (error.status !== 422) throw error;
    const found = (await listMilestones(api, repository)).find((each) => each.title === title);
    if (found === undefined) throw error;
    return found;
  }
}

const CLOSING_ISSUES = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 50) {
        nodes { number milestone { number } repository { nameWithOwner } }
      }
    }
  }
}`;

export async function onPush({ api, repository, event, log }) {
  const after = await readVersion(api, repository, event.after);
  let before = after;
  if (event.before !== ZERO_SHA) {
    try {
      before = await readVersion(api, repository, event.before);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  const title = `v${before === after ? nextPatch(after) : after}`;

  const commits = event.commits?.length
    ? event.commits.map((commit) => ({ id: commit.id, message: commit.message ?? "" }))
    : [{ id: event.after, message: event.head_commit?.message ?? "" }];
  const pulls = new Map();
  for (const { id: sha, message } of commits) {
    let found = await api.rest("GET", `/repos/${repository}/commits/${sha}/pulls`);
    if (found.length === 0) found = await pullOfMergeCommit(api, repository, sha, message);
    for (const pull of found) {
      if (pull.merged_at !== null && pull.merged_at !== undefined && pull.base?.ref === "main") pulls.set(pull.number, pull);
    }
  }
  if (pulls.size === 0) {
    log("No merged pull request in this push.");
    return;
  }

  let milestone = (await listMilestones(api, repository)).find((each) => each.title === title);
  if (milestone === undefined) {
    milestone = await createMilestone(api, repository, title);
    log(`Created milestone ${title}.`);
  }

  const [owner, name] = repository.split("/");
  for (const pull of pulls.values()) {
    if (pull.milestone === null || pull.milestone === undefined) {
      await api.rest("PATCH", `/repos/${repository}/issues/${pull.number}`, { milestone: milestone.number });
      log(`Set milestone ${title} on #${pull.number}.`);
    }
    const data = await api.graphql(CLOSING_ISSUES, { owner, name, number: pull.number });
    const nodes = data?.repository?.pullRequest?.closingIssuesReferences?.nodes ?? [];
    for (const issue of nodes) {
      if (issue.repository?.nameWithOwner !== repository || issue.milestone !== null) continue;
      await api.rest("PATCH", `/repos/${repository}/issues/${issue.number}`, { milestone: milestone.number });
      log(`Set milestone ${title} on #${issue.number}.`);
    }
  }
}

export async function onRelease({ api, repository, event, log }) {
  const { prerelease, draft, tag_name: tag } = event.release;
  const tagVersion = versionOfTitle(tag);
  if (prerelease || draft || tagVersion === null) {
    log(`Release ${tag} is not a final version. Nothing to do.`);
    return;
  }

  const milestones = await listMilestones(api, repository);
  const isLatest = await isLatestRelease(api, repository, tag);
  if (!isLatest) log(`Release ${tag} is not the latest release. Only its milestone closes.`);
  let milestone = milestones.find((each) => each.title === tag);
  if (milestone === undefined && isLatest) {
    const lower = milestones
      .filter((each) => each.state === "open")
      .map((each) => ({ each, version: versionOfTitle(each.title) }))
      .filter((item) => item.version !== null && compareVersions(item.version, tagVersion) < 0)
      .sort((a, b) => compareVersions(b.version, a.version));
    if (lower.length > 0) {
      milestone = await api.rest("PATCH", `/repos/${repository}/milestones/${lower[0].each.number}`, {
        title: tag,
        description: `Changes that ship in Seira ${tag}.`,
      });
      log(`Renamed milestone ${lower[0].each.title} to ${tag}.`);
    }
  }
  if (milestone !== undefined && milestone.state === "open") {
    await api.rest("PATCH", `/repos/${repository}/milestones/${milestone.number}`, { state: "closed" });
    log(`Closed milestone ${tag}.`);
  }

  const next = `v${nextPatch(tag.slice(1))}`;
  if (isLatest && !milestones.some((each) => each.title === next)) {
    await createMilestone(api, repository, next);
    log(`Created milestone ${next}.`);
  }
}

export async function main(env = process.env) {
  try {
    for (const key of ["GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GH_TOKEN"]) {
      if (!env[key]) throw new Error(`Missing environment variable ${key}.`);
    }
    const repository = env.GITHUB_REPOSITORY;
    const api = createApi({ token: env.GH_TOKEN, repository, fetch: globalThis.fetch });
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const run = { api, repository, event, log: (line) => console.log(line) };
    if (env.GITHUB_EVENT_NAME === "push") await onPush(run);
    else if (env.GITHUB_EVENT_NAME === "release") await onRelease(run);
    else throw new Error(`Unsupported event: ${env.GITHUB_EVENT_NAME}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
