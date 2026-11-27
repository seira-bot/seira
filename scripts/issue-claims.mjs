import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const HOUR = 3_600_000;
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const AGENT_PRIORITIES = new Set(["P0", "P1"]);
const RESTRICTED = new Set(["size: L", "size: XL", "needs-split", "needs-security-review", "area: ci"]);
const HUMAN_WINDOW = "human-window";
const AGENT_READY = "agent-ready";
const CLAIMED_HUMAN = "claimed: human";
const CLAIMED_AGENT = "claimed: agent";
const WINDOW_MARKER = "<!-- issue-claims:window -->";
const REMINDER_MARKER = "<!-- issue-claims:reminder -->";
const WINDOW_HOURS = 24;
const CLAIM_HOURS = 72;
const WEEKEND_RELEASE_HOUR_UTC = 12;

export function parseCommand(body) {
  const text = String(body ?? "").trim();
  if (text === "/take") return "take";
  if (text === "/untake") return "untake";
  return null;
}

export function isMaintainer(association) {
  return association === "OWNER" || association === "MEMBER";
}

export function claimLimit(association) {
  if (isMaintainer(association)) return Infinity;
  if (association === "COLLABORATOR" || association === "CONTRIBUTOR") return 2;
  return 1;
}

export function priorityOf(labelNames) {
  return PRIORITIES.find((priority) => labelNames.includes(priority)) ?? null;
}

export function isRestricted(labelNames) {
  return labelNames.some((name) => RESTRICTED.has(name));
}

export function windowEnd(start) {
  return new Date(start.getTime() + WINDOW_HOURS * HOUR);
}

export function claimDeadline(claimedAt) {
  const deadline = new Date(claimedAt.getTime() + CLAIM_HOURS * HOUR);
  const day = deadline.getUTCDay();
  if (day !== 6 && day !== 0) return deadline;
  const monday = new Date(deadline);
  monday.setUTCDate(monday.getUTCDate() + (day === 6 ? 2 : 1));
  monday.setUTCHours(WEEKEND_RELEASE_HOUR_UTC, 0, 0, 0);
  return monday;
}

const pad = (value) => String(value).padStart(2, "0");
const dateOf = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const timeOf = (date) => `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;

export function formatUtc(date) {
  return `${dateOf(date)} ${timeOf(date)} UTC`;
}

export function formatWib(date) {
  const wib = new Date(date.getTime() + 7 * HOUR);
  const prefix = dateOf(wib) === dateOf(date) ? "" : `${dateOf(wib)} `;
  return `${prefix}${timeOf(wib)} WIB`;
}

export function desiredWindow({ labels, assigned, windowStart, now }) {
  if (assigned || labels.includes(CLAIMED_HUMAN) || labels.includes(CLAIMED_AGENT)) return null;
  const priority = priorityOf(labels);
  if (priority === null) return null;
  if (AGENT_PRIORITIES.has(priority) || isRestricted(labels) || now.getTime() >= windowEnd(windowStart).getTime()) return AGENT_READY;
  return HUMAN_WINDOW;
}

export function createApi({ token, repository, fetch: fetchImpl = globalThis.fetch }) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "seira-issue-claims",
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

async function listAll(api, path) {
  const separator = path.includes("?") ? "&" : "?";
  const all = [];
  for (let page = 1; ; page += 1) {
    const items = await api.rest("GET", `${path}${separator}per_page=100&page=${page}`);
    all.push(...items);
    if (items.length < 100) return all;
  }
}

const namesOf = (issue) => (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
const loginsOf = (issue) => (issue.assignees ?? []).map((assignee) => assignee.login);
const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const holds = (issue, login) => loginsOf(issue).some((each) => sameLogin(each, login));

const issuePath = (api, number) => `/repos/${api.repository}/issues/${number}`;

async function addLabel(api, number, name) {
  await api.rest("POST", `${issuePath(api, number)}/labels`, { labels: [name] });
}

async function removeLabel(api, number, name) {
  try {
    await api.rest("DELETE", `${issuePath(api, number)}/labels/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function comment(api, number, body) {
  await api.rest("POST", `${issuePath(api, number)}/comments`, { body });
}

async function readIssue(api, number) {
  return api.rest("GET", issuePath(api, number));
}

async function readEvents(api, number) {
  return listAll(api, `${issuePath(api, number)}/events`);
}

async function windowStartOf(api, issue) {
  const events = await readEvents(api, issue.number);
  const first = events.find((event) => event.event === "labeled" && (event.label?.name === "P2" || event.label?.name === "P3"));
  return new Date(first?.created_at ?? issue.created_at);
}

async function claimTimeOf(api, number) {
  const events = await readEvents(api, number);
  const claims = events.filter((event) => event.event === "labeled" && event.label?.name === CLAIMED_HUMAN);
  const last = claims.at(-1);
  return last === undefined ? null : new Date(last.created_at);
}

const LINKED_PULLS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: false) {
        nodes { number state }
      }
    }
  }
}`;

async function hasOpenPull(api, number) {
  const [owner, name] = api.repository.split("/");
  const data = await api.graphql(LINKED_PULLS, { owner, name, number });
  const nodes = data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes.some((node) => node.state === "OPEN");
}

export async function reconcile({ api, number, now, log = () => {} }) {
  const issue = await readIssue(api, number);
  if (issue.state !== "open" || issue.pull_request) return;
  const labels = namesOf(issue);
  const assigned = loginsOf(issue).length > 0;
  const hasWindowLabel = (name) => labels.includes(name);

  if (assigned || labels.includes(CLAIMED_HUMAN) || labels.includes(CLAIMED_AGENT)) {
    for (const name of [HUMAN_WINDOW, AGENT_READY]) {
      if (hasWindowLabel(name)) await removeLabel(api, number, name);
    }
    return;
  }
  if (priorityOf(labels) === null) return;

  let windowStart = now;
  let desired = desiredWindow({ labels, assigned, windowStart, now });
  if (desired === HUMAN_WINDOW) {
    windowStart = await windowStartOf(api, issue);
    desired = desiredWindow({ labels, assigned, windowStart, now });
  }
  if (desired === null) return;

  const other = desired === HUMAN_WINDOW ? AGENT_READY : HUMAN_WINDOW;
  const entering = !hasWindowLabel(desired);
  if (entering) await addLabel(api, number, desired);
  if (hasWindowLabel(other)) await removeLabel(api, number, other);
  log(`#${number}: ${desired}`);

  if (desired === HUMAN_WINDOW && entering) {
    const comments = await listAll(api, `${issuePath(api, number)}/comments`);
    if (comments.some((each) => String(each.body ?? "").includes(WINDOW_MARKER))) return;
    const end = windowEnd(windowStart);
    await comment(
      api,
      number,
      `Open for human contributors until ${formatUtc(end)} (${formatWib(end)}). Comment \`/take\` to claim it.\n\n${WINDOW_MARKER}`,
    );
  }
}

async function take({ api, issue, login, association, now }) {
  const number = issue.number;
  const reply = (text) => comment(api, number, `@${login} ${text}`);
  const fresh = await readIssue(api, number);
  if (fresh.state !== "open") return reply("This issue is closed. Please pick another one.");
  if (holds(fresh, login)) return reply("This issue is already yours.");

  const labels = namesOf(fresh);
  const taken = loginsOf(fresh).length > 0 || labels.includes(CLAIMED_HUMAN) || labels.includes(CLAIMED_AGENT) || (await hasOpenPull(api, number));
  if (taken) return reply("Someone already works on this issue. Please pick another one.");

  const priority = priorityOf(labels);
  if (!isMaintainer(association) && ((priority !== "P2" && priority !== "P3") || isRestricted(labels))) {
    return reply("This issue needs a maintainer. Please pick another one.");
  }

  const limit = claimLimit(association);
  if (limit !== Infinity) {
    const open = await listAll(api, `/repos/${api.repository}/issues?state=open&assignee=${encodeURIComponent(login)}&labels=${encodeURIComponent(CLAIMED_HUMAN)}`);
    const count = open.filter((each) => !each.pull_request).length;
    if (count >= limit) return reply(`You already hold \`${count}\` issues. Finish one or comment \`/untake\` first.`);
  }

  const failure = "We could not assign this issue to you. A maintainer will check it.";
  try {
    await api.rest("GET", `${issuePath(api, number)}/assignees/${encodeURIComponent(login)}`);
  } catch (error) {
    if (error.status === 404) return reply(failure);
    throw error;
  }
  const assigned = await api.rest("POST", `${issuePath(api, number)}/assignees`, { assignees: [login] });
  if (!holds(assigned ?? {}, login)) return reply(failure);

  await addLabel(api, number, CLAIMED_HUMAN);
  for (const name of [HUMAN_WINDOW, AGENT_READY]) {
    if (labels.includes(name)) await removeLabel(api, number, name);
  }
  const deadline = claimDeadline(now);
  return reply(`This issue is yours. Open a draft PR that says \`Closes #${number}\` by ${formatUtc(deadline)}. Comment \`/untake\` if you stop.`);
}

async function untake({ api, issue, login, now, log }) {
  const number = issue.number;
  const reply = (text) => comment(api, number, `@${login} ${text}`);
  const fresh = await readIssue(api, number);
  if (!holds(fresh, login) || !namesOf(fresh).includes(CLAIMED_HUMAN)) return reply("You do not hold this issue.");
  await api.rest("DELETE", `${issuePath(api, number)}/assignees`, { assignees: [login] });
  await removeLabel(api, number, CLAIMED_HUMAN);
  await reconcile({ api, number, now, log });
  return reply("Done. This issue is free again.");
}

export async function onComment({ api, event, now, log = () => {} }) {
  const { issue, comment: posted } = event;
  if (issue.pull_request || posted.user?.type === "Bot") return;
  const command = parseCommand(posted.body);
  if (command === null) return;
  const run = { api, issue, login: posted.user.login, association: posted.author_association, now, log };
  if (command === "take") await take(run);
  else await untake(run);
}

export async function onLabeled({ api, event, now, log = () => {} }) {
  if (!PRIORITIES.includes(event.label?.name)) return;
  await reconcile({ api, number: event.issue.number, now, log });
}

async function sweepClaim({ api, issue, now, log }) {
  const number = issue.number;
  const logins = loginsOf(issue);
  if (logins.length === 0) {
    await removeLabel(api, number, CLAIMED_HUMAN);
    await reconcile({ api, number, now, log });
    return;
  }
  if (await hasOpenPull(api, number)) return;
  const claimedAt = await claimTimeOf(api, number);
  if (claimedAt === null) return;
  const deadline = claimDeadline(claimedAt);
  const mention = logins.map((each) => `@${each}`).join(" ");

  if (now.getTime() >= deadline.getTime()) {
    await api.rest("DELETE", `${issuePath(api, number)}/assignees`, { assignees: logins });
    await removeLabel(api, number, CLAIMED_HUMAN);
    await addLabel(api, number, AGENT_READY);
    await comment(api, number, `${mention} We released this issue because no draft PR came in. Comment \`/take\` again if it is still free.`);
    log(`#${number}: released`);
    return;
  }
  if (now.getTime() >= deadline.getTime() - WINDOW_HOURS * HOUR) {
    const comments = await listAll(api, `${issuePath(api, number)}/comments`);
    const reminded = comments.some((each) => new Date(each.created_at).getTime() > claimedAt.getTime() && String(each.body ?? "").includes(REMINDER_MARKER));
    if (reminded) return;
    await comment(api, number, `${mention} Still on it? Open a draft PR by ${formatUtc(deadline)}, or comment \`/untake\`.\n\n${REMINDER_MARKER}`);
    log(`#${number}: reminded`);
  }
}

export async function sweep({ api, now, log = () => {}, error = (line) => console.error(line) }) {
  const open = await listAll(api, `/repos/${api.repository}/issues?state=open`);
  let failed = 0;
  for (const issue of open) {
    if (issue.pull_request) continue;
    try {
      const labels = namesOf(issue);
      if (labels.includes(CLAIMED_HUMAN)) await sweepClaim({ api, issue, now, log });
      else if (priorityOf(labels) !== null) await reconcile({ api, number: issue.number, now, log });
    } catch (cause) {
      failed += 1;
      error(`#${issue.number}: ${cause.message}`);
    }
  }
  return failed;
}

export async function main(env = process.env, { now = () => new Date(), fetch: fetchImpl = globalThis.fetch } = {}) {
  try {
    for (const key of ["GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_REPOSITORY", "GH_TOKEN"]) {
      if (!env[key]) throw new Error(`Missing environment variable ${key}.`);
    }
    const repository = env.GITHUB_REPOSITORY;
    const api = createApi({ token: env.GH_TOKEN, repository, fetch: fetchImpl });
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    const run = { api, event, now: now(), log: (line) => console.log(line) };
    const name = env.GITHUB_EVENT_NAME;
    if (name === "issue_comment") await onComment(run);
    else if (name === "issues") await onLabeled(run);
    else if (name === "schedule" || name === "workflow_dispatch") {
      if ((await sweep(run)) > 0) process.exitCode = 1;
    } else throw new Error(`Unsupported event: ${name}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
