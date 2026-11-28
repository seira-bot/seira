#!/usr/bin/env node
// Lets an AI agent pick an issue that no person holds, and mark it as taken.
//
//   node scripts/agent-pick.mjs list [--agent NAME] [--label NAME]... [--json]
//   node scripts/agent-pick.mjs check <number> [--agent NAME]
//   node scripts/agent-pick.mjs claim <number> --agent NAME
//   node scripts/agent-pick.mjs release <number> --agent NAME
//   node scripts/agent-pick.mjs sweep
//
// Every command takes --repo OWNER/NAME (default: GITHUB_REPOSITORY, else seira-bot/seira).
// Exit codes: 0 done, 1 not allowed, 2 usage or GitHub failure, 3 lost a claim race.
// The script reaches GitHub through `gh`, so the login of the caller applies.
// AGENT_PICK_AGENT_LOGINS holds extra accounts, comma-separated, whose pull requests count as agent pull requests.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HOUR = 3_600_000;
const WINDOW_HOURS = 24;
const CLAIM_HOURS = 24;
const AGENT_LIMIT = 2;
const QUEUE_LIMIT = 10;
const AREA_LIMIT = 3;
const DEFAULT_REPOSITORY = "seira-bot/seira";
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const SIZES = ["size: XS", "size: S", "size: M", "size: L", "size: XL"];
const RESTRICTED = new Set(["size: L", "size: XL", "needs-split", "needs-security-review", "area: ci"]);
const HUMAN_WINDOW = "human-window";
const AGENT_READY = "agent-ready";
const CLAIMED_HUMAN = "claimed: human";
const CLAIMED_AGENT = "claimed: agent";
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}(\[bot\])?$/;
const MARKER = /^<!-- agent-pick:(claim|release) agent=([A-Za-z0-9][A-Za-z0-9._-]{0,38}(?:\[bot\])?) -->$/;

class UsageError extends Error {}

export const marker = (kind, agent) => `<!-- agent-pick:${kind} agent=${agent} -->`;

export const claimText = (agent) =>
  `${marker("claim", agent)}\nAn AI agent (${agent}) works on this issue now. The agent releases it if it stops without a pull request.`;

export const releaseText = (agent) =>
  `${marker("release", agent)}\nThe AI agent (${agent}) stopped without a pull request. The issue is free again.`;

export const expiredText = (agent) =>
  `${marker("release", agent)}\nThe claim of the AI agent (${agent}) expired because no pull request came in. The issue is free again.`;

export function normalizeLogin(login) {
  return String(login ?? "")
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");
}

const sameAgent = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export function isAgentPr(pr, agentLogins = new Set()) {
  const author = pr.author;
  if (!author) return false;
  return author.__typename === "Bot" || agentLogins.has(normalizeLogin(author.login));
}

export function parseMarker(body) {
  const first = String(body ?? "").split(/\r?\n/, 1)[0];
  const match = MARKER.exec(first);
  return match ? { kind: match[1], agent: match[2] } : null;
}

// Anyone can comment on a public issue. Only bots and accounts with a link to the repository can claim or release.
const OUTSIDE = new Set(["NONE", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN"]);

export const trustedComment = (comment) =>
  comment.user?.type === "Bot" || !OUTSIDE.has(comment.author_association ?? "NONE");

export function activeClaims(comments) {
  const ordered = [...comments].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
  const active = [];
  for (const comment of ordered) {
    if (!trustedComment(comment)) continue;
    const parsed = parseMarker(comment.body);
    if (!parsed) continue;
    const index = active.findIndex((claim) => sameAgent(claim.agent, parsed.agent));
    if (parsed.kind === "claim" && index === -1) {
      active.push({ agent: parsed.agent, at: new Date(comment.created_at), commentId: comment.id });
    } else if (parsed.kind === "release" && index !== -1) {
      active.splice(index, 1);
    }
  }
  return active;
}

export const priorityOf = (labels) => PRIORITIES.find((priority) => labels.includes(priority)) ?? null;
export const sizeOf = (labels) => SIZES.find((size) => labels.includes(size)) ?? null;
const isRestricted = (labels) => labels.some((name) => RESTRICTED.has(name));
const areasOf = (labels) => labels.filter((name) => name.startsWith("area: "));

const pad = (value) => String(value).padStart(2, "0");

export function formatUtc(date) {
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

const isStale = (time, now) => time !== null && now.getTime() - time.getTime() >= CLAIM_HOURS * HOUR;

function windowCanApply(issue) {
  const priority = priorityOf(issue.labels);
  return (
    (priority === "P2" || priority === "P3") && !issue.labels.includes(AGENT_READY) && !isRestricted(issue.labels)
  );
}

function holdReason(issue, linkedOpenPrs) {
  if (issue.labels.includes(HUMAN_WINDOW)) return "human window: open to people only";
  if (issue.labels.includes(CLAIMED_HUMAN) || issue.assignees.length > 0) return "held by a person";
  if (priorityOf(issue.labels) === null) return "not triaged";
  if (linkedOpenPrs.length > 0) return `open pull request #${linkedOpenPrs[0]}`;
  return null;
}

export function needsDetail(issue, { usesWindow = false, linkedOpenPrs = [] } = {}) {
  const claimed = issue.labels.includes(CLAIMED_AGENT);
  const windowPossible = usesWindow && holdReason(issue, linkedOpenPrs) === null && windowCanApply(issue);
  return { comments: claimed, events: claimed || windowPossible };
}

export function evaluate(issue, ctx) {
  const held = holdReason(issue, ctx.linkedOpenPrs ?? []);
  if (held) return { free: false, reason: held };
  if (issue.labels.includes(CLAIMED_AGENT)) {
    const owner = ctx.claims?.[0] ?? null;
    if (owner && ctx.agent && sameAgent(owner.agent, ctx.agent)) return { free: true, reason: "yours" };
    if (isStale(owner?.at ?? ctx.claimLabeledAt ?? null, ctx.now)) return { free: true, reason: "stale agent claim" };
    return { free: false, reason: `held by another agent (${owner?.agent ?? "unknown"})` };
  }
  if (ctx.usesWindow && windowCanApply(issue)) {
    const start = ctx.windowStart ?? new Date(issue.created_at);
    const end = new Date(start.getTime() + WINDOW_HOURS * HOUR);
    if (ctx.now.getTime() < end.getTime()) {
      return { free: false, reason: `human window: open to people until ${formatUtc(end)}` };
    }
  }
  return { free: true };
}

export function rank(a, b) {
  const ready = Number(b.labels.includes(AGENT_READY)) - Number(a.labels.includes(AGENT_READY));
  if (ready !== 0) return ready;
  const slot = (labels, list) => {
    const index = list.findIndex((name) => labels.includes(name));
    return index === -1 ? list.length : index;
  };
  return (
    slot(a.labels, PRIORITIES) - slot(b.labels, PRIORITIES) ||
    slot(a.labels, SIZES) - slot(b.labels, SIZES) ||
    a.number - b.number
  );
}

export function wipBlock({ issue, agent, issues, prs, claimsByIssue, agentLogins = new Set(), now }) {
  if (priorityOf(issue.labels) === "P0") return null;
  const agentPrs = prs.filter((pr) => isAgentPr(pr, agentLogins));

  if (agent) {
    const mine = new Set();
    for (const [number, entry] of claimsByIssue) {
      const owner = entry.claims?.[0];
      if (owner && sameAgent(owner.agent, agent)) mine.add(number);
    }
    let count = mine.size;
    for (const pr of agentPrs) {
      if (normalizeLogin(pr.author.login) !== normalizeLogin(agent)) continue;
      if (!pr.closes.some((number) => mine.has(number))) count += 1;
    }
    if (count >= AGENT_LIMIT) return `agent limit: ${agent} already has ${count} open items`;
  }

  const waiting = agentPrs.filter((pr) => !pr.isDraft).length;
  if (waiting >= QUEUE_LIMIT) return `queue limit: ${waiting} agent pull requests wait for merge`;

  const inProgress = (other) => {
    if (agentPrs.some((pr) => pr.closes.includes(other.number))) return true;
    if (!other.labels.includes(CLAIMED_AGENT)) return false;
    const entry = claimsByIssue.get(other.number);
    const time = entry?.claims?.[0]?.at ?? entry?.claimLabeledAt ?? null;
    return !isStale(time, now);
  };
  for (const area of areasOf(issue.labels)) {
    const count = issues.filter((other) => other.number !== issue.number && other.labels.includes(area) && inProgress(other)).length;
    if (count >= AREA_LIMIT) return `area limit: ${count} issues in ${area} are in progress`;
  }
  return null;
}

export function createGhApi({ repository, run }) {
  const exec =
    run ??
    ((args, input) =>
      execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }));

  function call(method, path, args, input) {
    let stdout;
    try {
      stdout = exec(args, input);
    } catch (cause) {
      const http = /HTTP (\d{3})/.exec(String(cause?.stderr ?? ""));
      const error = new Error(`GitHub call failed: ${method} ${path} (exit ${cause?.status ?? "unknown"})`);
      if (http) error.status = Number(http[1]);
      throw error;
    }
    const text = String(stdout ?? "").trim();
    return text === "" ? null : JSON.parse(text);
  }

  return {
    repository,
    rest(method, path, body) {
      const args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"];
      if (body !== undefined) args.push("--input", "-");
      return call(method, path, args, body === undefined ? undefined : JSON.stringify(body));
    },
    graphql(query, variables) {
      const answer = call("POST", "graphql", ["api", "graphql", "--input", "-"], JSON.stringify({ query, variables }));
      if (answer?.errors?.length) throw new Error("GitHub call failed: POST graphql (GraphQL error)");
      return answer?.data ?? null;
    },
  };
}

async function listAll(api, path) {
  const separator = path.includes("?") ? "&" : "?";
  const all = [];
  for (let page = 1; ; page += 1) {
    const items = await api.rest("GET", `${path}${separator}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

export function normalizeIssue(raw) {
  return {
    number: raw.number,
    title: raw.title,
    labels: (raw.labels ?? []).map((label) => (typeof label === "string" ? label : label.name)),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    created_at: raw.created_at,
  };
}

const PRS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { number isDraft author { login __typename } labels(first: 20) { nodes { name } } closingIssuesReferences(first: 25) { nodes { number } } }
    }
  }
}`;

async function loadPrs(api) {
  const [owner, name] = api.repository.split("/");
  const prs = [];
  let cursor = null;
  for (;;) {
    const data = await api.graphql(PRS_QUERY, { owner, name, cursor });
    const page = data.repository.pullRequests;
    for (const node of page.nodes) {
      prs.push({
        number: node.number,
        isDraft: node.isDraft,
        author: node.author,
        stalled: (node.labels?.nodes ?? []).some((label) => label.name === "stalled"),
        closes: (node.closingIssuesReferences?.nodes ?? []).map((issue) => issue.number),
      });
    }
    if (!page.pageInfo.hasNextPage) return prs;
    cursor = page.pageInfo.endCursor;
  }
}

async function usesHumanWindow(api) {
  try {
    await api.rest("GET", `/repos/${api.repository}/labels/${HUMAN_WINDOW}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

const eventTime = (event) => new Date(event.created_at);

async function loadDetail(api, issue, need) {
  const base = `/repos/${api.repository}/issues/${issue.number}`;
  const detail = { claims: null, windowStart: null, claimLabeledAt: null };
  if (need.comments) detail.claims = activeClaims(await listAll(api, `${base}/comments`));
  if (need.events) {
    const labeled = (await listAll(api, `${base}/events`)).filter((event) => event.event === "labeled" && event.label);
    const starts = labeled.filter((event) => event.label.name === "P2" || event.label.name === "P3").map(eventTime);
    if (starts.length > 0) detail.windowStart = new Date(Math.min(...starts));
    const claimed = labeled.filter((event) => event.label.name === CLAIMED_AGENT).map(eventTime);
    if (claimed.length > 0) detail.claimLabeledAt = new Date(Math.max(...claimed));
  }
  return detail;
}

async function loadData(api) {
  const issues = (await listAll(api, `/repos/${api.repository}/issues?state=open`))
    .filter((raw) => !raw.pull_request)
    .map(normalizeIssue);
  const prs = await loadPrs(api);
  const usesWindow = await usesHumanWindow(api);
  const details = new Map();
  for (const issue of issues) {
    const linkedOpenPrs = linkedPrs(prs, issue.number);
    const need = needsDetail(issue, { usesWindow, linkedOpenPrs });
    if (need.comments || need.events) details.set(issue.number, await loadDetail(api, issue, need));
  }
  return { issues, prs, usesWindow, details };
}

const linkedPrs = (prs, number) => prs.filter((pr) => !pr.stalled && pr.closes.includes(number)).map((pr) => pr.number);

function claimsByIssueOf(data) {
  const map = new Map();
  for (const issue of data.issues) {
    if (!issue.labels.includes(CLAIMED_AGENT)) continue;
    const detail = data.details.get(issue.number);
    map.set(issue.number, { claims: detail?.claims ?? [], claimLabeledAt: detail?.claimLabeledAt ?? null });
  }
  return map;
}

function judge(issue, data, { agent, now, agentLogins }) {
  const detail = data.details.get(issue.number);
  const ctx = {
    now,
    agent,
    usesWindow: data.usesWindow,
    windowStart: detail?.windowStart ?? null,
    linkedOpenPrs: linkedPrs(data.prs, issue.number),
    claims: detail?.claims ?? null,
    claimLabeledAt: detail?.claimLabeledAt ?? null,
  };
  const verdict = evaluate(issue, ctx);
  if (!verdict.free || verdict.reason === "yours") return { ...verdict, ctx };
  const blocked = wipBlock({
    issue,
    agent,
    issues: data.issues,
    prs: data.prs,
    claimsByIssue: claimsByIssueOf(data),
    agentLogins,
    now,
  });
  return blocked ? { free: false, reason: blocked, ctx } : { ...verdict, ctx };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, positional: [], labels: [], json: false, agent: null, repo: null };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--agent" || arg === "--repo" || arg === "--label") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
      i += 1;
      if (arg === "--label") options.labels.push(value);
      else options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}.`);
    else options.positional.push(arg);
  }
  if (options.agent !== null && !AGENT_NAME.test(options.agent)) throw new UsageError("Invalid --agent name.");
  return options;
}

function issueNumber(options) {
  const [value] = options.positional;
  if (options.positional.length !== 1 || !/^[1-9]\d{0,9}$/.test(value)) throw new UsageError("Give one issue number.");
  return Number(value);
}

function requireAgent(options) {
  if (!options.agent) throw new UsageError("This command needs --agent NAME.");
  return options.agent;
}

const issuePath = (api, number) => `/repos/${api.repository}/issues/${number}`;
const postComment = (api, number, body) => api.rest("POST", `${issuePath(api, number)}/comments`, { body });

async function removeClaimLabel(api, number) {
  try {
    await api.rest("DELETE", `${issuePath(api, number)}/labels/${encodeURIComponent(CLAIMED_AGENT)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function runList(api, options, run) {
  const data = await loadData(api);
  const pool = data.issues.filter((issue) => options.labels.every((label) => issue.labels.includes(label)));
  const free = [];
  const skipped = [];
  for (const issue of pool) {
    const verdict = judge(issue, data, run);
    if (verdict.free) free.push(issue);
    else skipped.push({ number: issue.number, reason: verdict.reason });
  }
  free.sort(rank);
  const wip = wipBlock({
    issue: { number: 0, labels: [] },
    agent: run.agent,
    issues: data.issues,
    prs: data.prs,
    claimsByIssue: claimsByIssueOf(data),
    agentLogins: run.agentLogins,
    now: run.now,
  });
  const view = (issue) => ({
    number: issue.number,
    title: issue.title,
    priority: priorityOf(issue.labels),
    size: sizeOf(issue.labels)?.slice("size: ".length) ?? null,
    agentReady: issue.labels.includes(AGENT_READY),
  });
  if (options.json) {
    run.log(JSON.stringify({ free: free.map(view), skipped, wip }));
    return 0;
  }
  for (const issue of free) {
    const item = view(issue);
    run.log(`#${item.number} ${item.priority} ${item.size ?? "-"} ${item.title}`);
  }
  if (wip) run.log(`limit: ${wip}`);
  const groups = new Map();
  for (const item of skipped) groups.set(item.reason, [...(groups.get(item.reason) ?? []), item.number]);
  for (const [reason, numbers] of groups) run.log(`skipped: ${reason}: ${numbers.map((n) => `#${n}`).join(", ")}`);
  return 0;
}

async function runCheck(api, options, run) {
  const number = issueNumber(options);
  const data = await loadData(api);
  const issue = data.issues.find((each) => each.number === number);
  if (!issue) {
    run.log(`skip: #${number}: not an open issue`);
    return 1;
  }
  const verdict = judge(issue, data, run);
  if (verdict.free) {
    run.log(`free: #${number}`);
    return 0;
  }
  run.log(`skip: #${number}: ${verdict.reason}`);
  return 1;
}

async function runClaim(api, options, run) {
  const number = issueNumber(options);
  const agent = requireAgent(options);
  const data = await loadData(api);
  const issue = data.issues.find((each) => each.number === number);
  if (!issue) {
    run.log(`skip: #${number}: not an open issue`);
    return 1;
  }
  const verdict = judge(issue, data, run);
  if (!verdict.free) {
    run.log(`skip: #${number}: ${verdict.reason}`);
    return 1;
  }
  if (verdict.reason === "yours") {
    run.log(`already yours: #${number}`);
    return 0;
  }
  if (verdict.reason === "stale agent claim") {
    const stale = verdict.ctx.claims?.[0];
    if (stale) await postComment(api, number, expiredText(stale.agent));
  }
  await api.rest("POST", `${issuePath(api, number)}/labels`, { labels: [CLAIMED_AGENT] });
  const posted = await postComment(api, number, claimText(agent));

  const now = normalizeIssue(await api.rest("GET", issuePath(api, number)));
  const claims = activeClaims(await listAll(api, `${issuePath(api, number)}/comments`));
  const heldByPerson = now.labels.includes(CLAIMED_HUMAN) || now.assignees.length > 0;
  const owner = claims[0] ?? null;
  if (!heldByPerson && owner && sameAgent(owner.agent, agent)) {
    run.log(`claimed: #${number}`);
    return 0;
  }
  await api.rest("DELETE", `/repos/${api.repository}/issues/comments/${posted.id}`);
  const others = claims.filter((claim) => !sameAgent(claim.agent, agent));
  if (heldByPerson && others.length === 0) await removeClaimLabel(api, number);
  const reason = heldByPerson ? "held by a person" : `held by another agent (${owner?.agent ?? "unknown"})`;
  run.log(`lost: #${number}: ${reason}`);
  return 3;
}

async function runRelease(api, options, run) {
  const number = issueNumber(options);
  const agent = requireAgent(options);
  const issue = normalizeIssue(await api.rest("GET", issuePath(api, number)));
  const claims = activeClaims(await listAll(api, `${issuePath(api, number)}/comments`));
  const owner = claims[0] ?? null;
  if (owner && !sameAgent(owner.agent, agent)) {
    run.log(`skip: #${number}: held by another agent (${owner.agent})`);
    return 1;
  }
  const mine = claims.some((claim) => sameAgent(claim.agent, agent));
  if (mine) {
    await postComment(api, number, releaseText(agent));
    if (claims.length === 1) await removeClaimLabel(api, number);
  } else if (claims.length === 0 && issue.labels.includes(CLAIMED_AGENT)) {
    await removeClaimLabel(api, number);
  } else {
    run.log(`nothing to release: #${number}`);
    return 0;
  }
  run.log(`released: #${number}`);
  return 0;
}

async function runSweep(api, run) {
  const issues = (await listAll(api, `/repos/${api.repository}/issues?state=open`))
    .filter((raw) => !raw.pull_request)
    .map(normalizeIssue)
    .filter((issue) => issue.labels.includes(CLAIMED_AGENT));
  const prs = await loadPrs(api);
  let failures = 0;
  for (const issue of issues) {
    if (linkedPrs(prs, issue.number).length > 0) continue;
    try {
      const detail = await loadDetail(api, issue, { comments: true, events: true });
      const expired = detail.claims.filter((claim) => isStale(claim.at, run.now));
      const noOwner = detail.claims.length === 0 && isStale(detail.claimLabeledAt, run.now);
      if (expired.length === 0 && !noOwner) continue;
      for (const claim of expired) await postComment(api, issue.number, expiredText(claim.agent));
      if (expired.length === detail.claims.length) await removeClaimLabel(api, issue.number);
      run.log(`released: #${issue.number} (${expired.map((claim) => claim.agent).join(", ") || "unknown"})`);
    } catch (error) {
      failures += 1;
      run.error(`failed: #${issue.number}: ${error.message}`);
    }
  }
  return failures > 0 ? 2 : 0;
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const run = {
    now: (deps.now ?? (() => new Date()))(),
    log: deps.log ?? ((line) => console.log(line)),
    error: deps.error ?? ((line) => console.error(line)),
    agent: null,
    agentLogins: new Set(
      String(env.AGENT_PICK_AGENT_LOGINS ?? "")
        .split(",")
        .map(normalizeLogin)
        .filter(Boolean),
    ),
  };
  try {
    const options = parseArgs(argv);
    const commands = { list: runList, check: runCheck, claim: runClaim, release: runRelease, sweep: runSweep };
    if (!Object.hasOwn(commands, options.command ?? "")) throw new UsageError("Commands: list, check, claim, release, sweep.");
    const repository = options.repo ?? env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new UsageError("Invalid --repo.");
    run.agent = options.agent;
    const api = deps.api ?? createGhApi({ repository });
    if (options.command === "sweep") return await runSweep(api, run);
    return await commands[options.command](api, options, run);
  } catch (error) {
    run.error(error instanceof UsageError ? `usage: ${error.message}` : `error: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
