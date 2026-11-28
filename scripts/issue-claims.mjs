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
const ASSIGN_MARKER = "<!-- issue-claims:assign-reminder -->";
const REVIEW_MARKERS = ["<!-- issue-claims:review-1 -->", "<!-- issue-claims:review-2 -->"];
const STALE_MARKER = "<!-- issue-claims:stale-reminder -->";
const NEEDS_REVIEW = "needs-review";
const STALLED = "stalled";
const MAINTAINERS_TEAM = "maintainers";
const DAY = 24 * HOUR;
const BOT_LOGIN = "github-actions[bot]";
const REVIEW_BOTS = new Set(["seira-raskreia[bot]", "seira-roctis[bot]"]);
const WINDOW_HOURS = 24;
const CLAIM_HOURS = 72;
const WEEKEND_RELEASE_HOUR_UTC = 12;

export const SWEEP_LIMITS = { maxRequests: 600, hardRequests: 900, maxMs: 4 * 60_000 };

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
      const header = (name) => response.headers?.get?.(name);
      if (response.status === 429 || (response.status === 403 && (header("x-ratelimit-remaining") === "0" || header("retry-after") != null))) {
        error.rateLimited = true;
      }
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
        if (answer.errors.some((each) => each.type === "RATE_LIMITED")) error.rateLimited = true;
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
      closedByPullRequestsReferences(first: 25, includeClosedPrs: false) {
        pageInfo { hasNextPage }
        nodes { number state labels(first: 20) { nodes { name } } }
      }
    }
  }
}`;

async function activePulls(api, number) {
  const [owner, name] = api.repository.split("/");
  const data = await api.graphql(LINKED_PULLS, { owner, name, number });
  const references = data?.repository?.issue?.closedByPullRequestsReferences;
  const nodes = references?.nodes ?? [];
  return {
    numbers: nodes.filter((node) => node.state === "OPEN" && !(node.labels?.nodes ?? []).some((label) => label.name === STALLED)).map((node) => node.number),
    complete: references?.pageInfo?.hasNextPage === false,
  };
}

async function hasOpenPull(api, number) {
  const { numbers, complete } = await activePulls(api, number);
  return !complete || numbers.length > 0;
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
    if (comments.some((each) => hasMarker(each, WINDOW_MARKER))) return;
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
    const latest = await readIssue(api, number);
    if (latest.state !== "open" || loginsOf(latest).length > 0 || !namesOf(latest).includes(CLAIMED_HUMAN)) {
      log(`#${number}: held, issue changed`);
      return;
    }
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
    const latest = await readIssue(api, number);
    const latestLogins = loginsOf(latest);
    const unchanged =
      latest.state === "open" &&
      namesOf(latest).includes(CLAIMED_HUMAN) &&
      latestLogins.length === logins.length &&
      latestLogins.every((login) => logins.some((each) => sameLogin(each, login)));
    const renewed = unchanged && (await claimTimeOf(api, number))?.getTime() !== claimedAt.getTime();
    if (!unchanged || renewed) {
      log(`#${number}: held, issue changed`);
      return;
    }
    if (await hasOpenPull(api, number)) return;
    await api.rest("DELETE", `${issuePath(api, number)}/assignees`, { assignees: logins });
    await removeLabel(api, number, CLAIMED_HUMAN);
    await addLabel(api, number, AGENT_READY);
    await comment(api, number, `${mention} We released this issue because no draft PR came in. Comment \`/take\` again if it is still free.`);
    log(`#${number}: released`);
    return;
  }
  if (now.getTime() >= deadline.getTime() - WINDOW_HOURS * HOUR) {
    const comments = await listAll(api, `${issuePath(api, number)}/comments`);
    const reminded = comments.some((each) => new Date(each.created_at).getTime() > claimedAt.getTime() && hasMarker(each, REMINDER_MARKER));
    if (reminded) return;
    await comment(api, number, `${mention} Still on it? Open a draft PR by ${formatUtc(deadline)}, or comment \`/untake\`.\n\n${REMINDER_MARKER}`);
    log(`#${number}: reminded`);
  }
}

const ms = (value) => new Date(value).getTime();
const once = (load) => {
  let pending;
  return () => (pending ??= load());
};

const hasMarker = (each, marker) => each.user?.login === BOT_LOGIN && String(each.body ?? "").includes(marker);

function markerAfter(comments, marker, since) {
  const found = comments.filter((each) => ms(each.created_at) > since && hasMarker(each, marker));
  return found.length === 0 ? undefined : found.reduce((a, b) => (ms(b.created_at) >= ms(a.created_at) ? b : a));
}

function assignedAtOf(events, logins) {
  const times = events
    .filter((event) => event.event === "assigned" && logins.some((login) => sameLogin(login, event.assignee?.login)))
    .map((event) => ms(event.created_at));
  return times.length === 0 ? null : Math.max(...times);
}

async function sweepAssignment({ api, issue, now, log }) {
  const number = issue.number;
  const logins = loginsOf(issue);
  const assignedAt = assignedAtOf(await readEvents(api, number), logins);
  if (assignedAt === null) return false;
  const current = now.getTime();
  if (current < assignedAt + 5 * DAY) return false;
  if (await hasOpenPull(api, number)) return false;

  const comments = await listAll(api, `${issuePath(api, number)}/comments`);
  const reminder = markerAfter(comments, ASSIGN_MARKER, assignedAt);
  const mentions = logins.map((each) => `@${each}`).join(" ");
  if (reminder === undefined) {
    const deadline = new Date(Math.max(assignedAt + 7 * DAY, current + 48 * HOUR));
    await comment(
      api,
      number,
      `${mentions} This issue has no draft PR yet. Open a draft PR that says \`Closes #${number}\` by ${formatUtc(deadline)}, or unassign yourself if you stop.\n\n${ASSIGN_MARKER}`,
    );
    log(`#${number}: reminded`);
    return false;
  }
  if (current < assignedAt + 7 * DAY || current < ms(reminder.created_at) + 48 * HOUR) return false;
  const latest = await readIssue(api, number);
  const latestLogins = loginsOf(latest);
  const latestLabels = namesOf(latest);
  const unchanged =
    latest.state === "open" &&
    latestLogins.length === logins.length &&
    latestLogins.every((login) => logins.some((each) => sameLogin(each, login))) &&
    !latestLabels.includes(CLAIMED_HUMAN) &&
    !latestLabels.includes(CLAIMED_AGENT);
  if (!unchanged || assignedAtOf(await readEvents(api, number), logins) !== assignedAt) {
    log(`#${number}: held, issue changed`);
    return false;
  }
  if (await hasOpenPull(api, number)) return false;
  await api.rest("DELETE", `${issuePath(api, number)}/assignees`, { assignees: logins });
  await reconcile({ api, number, now, log });
  await comment(api, number, `${mentions} We unassigned this issue because no draft PR came in for 7 days. The issue is free again.`);
  log(`#${number}: unassigned`);
  return true;
}

const PULL_CLOSES = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 25) {
        pageInfo { hasNextPage }
        nodes { number state repository { nameWithOwner } }
      }
    }
  }
}`;

const isBot = (user) => user?.type === "Bot";
const trustedReviewer = (review) =>
  REVIEW_BOTS.has(String(review.user?.login).toLowerCase()) || (!isBot(review.user) && isMaintainer(review.author_association));

function pullData(api, pull) {
  const number = pull.number;
  const [owner, name] = api.repository.split("/");
  return {
    events: once(() => readEvents(api, number)),
    reviews: once(async () => (await listAll(api, `/repos/${api.repository}/pulls/${number}/reviews`)).filter((each) => each.state !== "PENDING")),
    comments: once(() => listAll(api, `${issuePath(api, number)}/comments`)),
    commits: once(() => listAll(api, `/repos/${api.repository}/pulls/${number}/commits`)),
    linked: once(async () => {
      const data = await api.graphql(PULL_CLOSES, { owner, name, number });
      const references = data?.repository?.pullRequest?.closingIssuesReferences;
      const nodes = references?.nodes ?? [];
      return {
        issues: nodes.filter((node) => node.state === "OPEN" && sameLogin(node.repository?.nameWithOwner, api.repository)),
        complete: references?.pageInfo?.hasNextPage === false,
      };
    }),
  };
}

async function lastAuthorActivity(data, author, now) {
  const times = [];
  for (const each of await data.comments()) if (sameLogin(each.user?.login, author)) times.push(ms(each.created_at));
  for (const each of await data.reviews()) if (sameLogin(each.user?.login, author)) times.push(ms(each.submitted_at));
  for (const each of await data.commits()) {
    const date = ms(each.commit?.committer?.date);
    if (date <= now.getTime() && (!each.author?.login || sameLogin(each.author.login, author))) times.push(date);
  }
  for (const each of await data.events()) if (each.event === "head_ref_force_pushed" && sameLogin(each.actor?.login, author)) times.push(ms(each.created_at));
  const valid = times.filter(Number.isFinite);
  return valid.length === 0 ? null : Math.max(...valid);
}

async function idleSinceOf(pull, data, author, now) {
  if (pull.draft) {
    const converted = (await data.events()).filter((event) => event.event === "convert_to_draft").map((event) => ms(event.created_at));
    const start = converted.length === 0 ? ms(pull.created_at) : Math.max(...converted);
    const activity = await lastAuthorActivity(data, author, now);
    return activity === null ? start : Math.max(start, activity);
  }
  const decisive = (await data.reviews()).filter(
    (review) =>
      (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") &&
      !sameLogin(review.user?.login, author) &&
      trustedReviewer(review),
  );
  if (decisive.length === 0) return null;
  const latest = decisive.reduce((a, b) => (ms(b.submitted_at) >= ms(a.submitted_at) ? b : a));
  if (latest.state !== "CHANGES_REQUESTED") return null;
  const submitted = ms(latest.submitted_at);
  const activity = await lastAuthorActivity(data, author, now);
  return activity !== null && activity > submitted ? null : submitted;
}

async function sweepReview({ api, pull, data, now, log, waiting }) {
  const number = pull.number;
  const labels = namesOf(pull);
  const flagged = labels.includes(NEEDS_REVIEW);
  const outsider = !isMaintainer(pull.author_association);
  const current = now.getTime();
  if (pull.draft || waiting || !outsider) {
    if (flagged) await removeLabel(api, number, NEEDS_REVIEW);
    return;
  }
  if (!flagged && current < ms(pull.created_at) + DAY) return;

  const ready = (await data.events()).filter((event) => event.event === "ready_for_review").map((event) => ms(event.created_at));
  const readyAt = ready.length === 0 ? ms(pull.created_at) : Math.max(...ready);
  const comments = await data.comments();
  const answered =
    comments.some((each) => ms(each.created_at) >= readyAt && !isBot(each.user) && isMaintainer(each.author_association)) ||
    (await data.reviews()).some((each) => ms(each.submitted_at) >= readyAt && !isBot(each.user) && isMaintainer(each.author_association));
  if (answered) {
    if (flagged) await removeLabel(api, number, NEEDS_REVIEW);
    return;
  }
  if (current < readyAt + DAY) return;
  if (!flagged) await addLabel(api, number, NEEDS_REVIEW);

  const team = `@${api.repository.split("/")[0]}/${MAINTAINERS_TEAM}`;
  const since = formatUtc(new Date(readyAt));
  const first = markerAfter(comments, REVIEW_MARKERS[0], readyAt);
  if (first === undefined) {
    await comment(api, number, `${team} This pull request has waited for a first review since ${since}.\n\n${REVIEW_MARKERS[0]}`);
    log(`#${number}: review requested`);
    return;
  }
  if (current >= readyAt + 2 * DAY && current >= ms(first.created_at) + DAY && markerAfter(comments, REVIEW_MARKERS[1], readyAt) === undefined) {
    await comment(api, number, `${team} This pull request still waits for a first review. It has waited since ${since}.\n\n${REVIEW_MARKERS[1]}`);
    log(`#${number}: review requested again`);
  }
}

async function freeIssue({ api, issue, author, prNumber, idleSince, now, log }) {
  const number = issue.number;
  const fresh = await readIssue(api, number);
  if (fresh.state !== "open") {
    log(`#${number}: held, issue changed`);
    return;
  }
  const renewed = (await readEvents(api, number)).some(
    (event) =>
      ms(event.created_at) > idleSince &&
      ((event.event === "assigned" && sameLogin(event.assignee?.login, author)) || (event.event === "labeled" && event.label?.name === CLAIMED_HUMAN)),
  );
  if (renewed) {
    log(`#${number}: held, claim renewed`);
    return;
  }
  const active = await activePulls(api, number);
  if (!active.complete || active.numbers.some((each) => each !== prNumber)) {
    log(`#${number}: held, other active pull request`);
    return;
  }
  let assignees = loginsOf(fresh);
  const labels = namesOf(fresh);
  let changed = false;
  if (assignees.some((login) => sameLogin(login, author))) {
    await api.rest("DELETE", `${issuePath(api, number)}/assignees`, { assignees: [author] });
    assignees = assignees.filter((login) => !sameLogin(login, author));
    changed = true;
  }
  if (assignees.length === 0 && labels.includes(CLAIMED_HUMAN)) {
    await removeLabel(api, number, CLAIMED_HUMAN);
    labels.splice(labels.indexOf(CLAIMED_HUMAN), 1);
    changed = true;
  }
  await reconcile({ api, number, now, log });
  if (changed && assignees.length === 0 && !labels.includes(CLAIMED_HUMAN) && !labels.includes(CLAIMED_AGENT)) {
    await comment(api, number, `This issue is free again because pull request #${prNumber} had no update for 14 days.`);
  }
}

async function sweepStalled({ api, pull, data, now, log, idleSince }) {
  const number = pull.number;
  const author = pull.user.login;
  const current = now.getTime();
  if (namesOf(pull).includes(STALLED)) {
    const labeled = (await data.events()).filter((event) => event.event === "labeled" && event.label?.name === STALLED).map((event) => ms(event.created_at));
    if (idleSince === null || (labeled.length > 0 && idleSince > Math.max(...labeled))) {
      await removeLabel(api, number, STALLED);
      log(`#${number}: stalled label removed`);
    }
    return;
  }
  if (idleSince === null) return;
  if (current < idleSince + 7 * DAY) return;
  const linked = await data.linked();
  if (!linked.complete) {
    log(`#${number}: held, linked issues incomplete`);
    return;
  }
  if (linked.issues.length === 0) return;

  const comments = await data.comments();
  const reminder = markerAfter(comments, STALE_MARKER, idleSince);
  if (reminder === undefined) {
    const deadline = new Date(Math.max(idleSince + 14 * DAY, current + 48 * HOUR));
    await comment(
      api,
      number,
      `@${author} This pull request waits for your update. Push a change or reply here by ${formatUtc(deadline)}. After that, its linked issues become free for other people. The pull request stays open.\n\n${STALE_MARKER}`,
    );
    log(`#${number}: reminded`);
    return;
  }
  if (current < idleSince + 14 * DAY || current < ms(reminder.created_at) + 48 * HOUR) return;

  const freshPull = await readIssue(api, number);
  const freshData = pullData(api, freshPull);
  const held =
    freshPull.state !== "open" ||
    namesOf(freshPull).includes(STALLED) ||
    (await idleSinceOf(freshPull, freshData, author, now)) !== idleSince;
  if (held) {
    log(`#${number}: held, pull request changed`);
    return;
  }
  const freshLinked = await freshData.linked();
  if (!freshLinked.complete) {
    log(`#${number}: held, linked issues incomplete`);
    return;
  }
  for (const issue of freshLinked.issues) await freeIssue({ api, issue, author, prNumber: number, idleSince, now, log });
  await addLabel(api, number, STALLED);
  await comment(api, number, `@${author} This pull request had no update for 14 days, so it no longer holds its linked issues. The pull request stays open. Push a change to continue.`);
  log(`#${number}: stalled`);
}

async function sweepPull({ api, pull, now, log }) {
  if (isBot(pull.user)) return;
  const data = pullData(api, pull);
  const idleSince = await idleSinceOf(pull, data, pull.user.login, now);
  await sweepReview({ api, pull, data, now, log, waiting: idleSince !== null });
  await sweepStalled({ api, pull, data, now, log, idleSince });
}

export async function sweep({
  api: source,
  now,
  log = () => {},
  error = (line) => console.error(line),
  limits = SWEEP_LIMITS,
  clock = () => Date.now(),
  offset = Math.floor(now.getTime() / HOUR),
}) {
  const started = clock();
  let requests = 0;
  const counted = (run) => async (...args) => {
    if (requests >= limits.hardRequests) {
      const stop = new Error("The sweep request limit was reached.");
      stop.stopped = true;
      throw stop;
    }
    requests += 1;
    return run(...args);
  };
  const api = { repository: source.repository, rest: counted(source.rest), graphql: counted(source.graphql) };
  const open = await listAll(api, `/repos/${api.repository}/issues?state=open`);
  let failed = 0;
  for (let done = 0; done < open.length; done += 1) {
    if (requests >= limits.maxRequests || clock() - started >= limits.maxMs) {
      error(`Stopped after ${done} of ${open.length} items: the sweep limit was reached.`);
      return failed + 1;
    }
    const issue = open[(offset + done) % open.length];
    try {
      if (issue.pull_request) {
        await sweepPull({ api, pull: issue, now, log });
        continue;
      }
      const labels = namesOf(issue);
      if (labels.includes(CLAIMED_HUMAN)) await sweepClaim({ api, issue, now, log });
      else if (priorityOf(labels) !== null) {
        const released = loginsOf(issue).length > 0 && !issue.sub_issues_summary?.total && (await sweepAssignment({ api, issue, now, log }));
        if (!released) await reconcile({ api, number: issue.number, now, log });
      }
    } catch (cause) {
      failed += 1;
      error(`#${issue.number}: ${cause.message}`);
      if (cause.rateLimited) {
        error("Stopped: GitHub rate limit.");
        return failed + 1;
      }
      if (cause.stopped) {
        error(`Stopped after ${done} of ${open.length} items: the sweep limit was reached.`);
        return failed + 1;
      }
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
