import { describe, expect, it, vi } from "vitest";

import {
  activeClaims,
  claimText,
  createGhApi,
  evaluate,
  expiredText,
  main,
  needsDetail,
  normalizeLogin,
  parseMarker,
  rank,
  releaseText,
  wipBlock,
} from "./agent-pick.mjs";

const NOW = new Date("2026-11-30T10:00:00Z");
const ago = (hours) => new Date(NOW.getTime() - hours * 3_600_000);
const REPO = "example/repo";

const issue = (number, labels = ["P1"], extra = {}) => ({
  number,
  title: `Issue ${number}`,
  labels,
  assignees: [],
  created_at: "2026-11-01T00:00:00Z",
  ...extra,
});

const baseCtx = (extra = {}) => ({
  now: NOW,
  agent: "seira-lagus",
  usesWindow: true,
  windowStart: null,
  linkedOpenPrs: [],
  claims: null,
  claimLabeledAt: null,
  ...extra,
});

const claimComment = (id, agent, at, kind = "claim") => ({
  id,
  created_at: at.toISOString(),
  body: kind === "claim" ? claimText(agent) : releaseText(agent),
  user: { type: "Bot" },
  author_association: "NONE",
});

const pr = (number, login, closes = [], extra = {}) => ({
  number,
  isDraft: false,
  author: { login, __typename: "Bot" },
  closes,
  ...extra,
});

function makeWorld({ issues = [], prs = [], windowLabel = true, events = {}, comments = {}, failComments = [] } = {}) {
  const world = {
    issues: issues.map((each) => ({ ...each, labels: [...each.labels], assignees: [...each.assignees] })),
    prs,
    events,
    comments: Object.fromEntries(Object.entries(comments).map(([key, value]) => [key, [...value]])),
    nextId: 1000,
    tick: 0,
    afterComment: null,
  };
  const raw = (each) => ({
    number: each.number,
    title: each.title,
    created_at: each.created_at,
    labels: each.labels.map((name) => ({ name })),
    assignees: each.assignees.map((login) => ({ login })),
  });
  const page = (items, query) => {
    const number = Number(/(?:^|&)page=(\d+)/.exec(query)?.[1] ?? 1);
    return items.slice((number - 1) * 100, number * 100);
  };
  const notFound = () => Object.assign(new Error("not found"), { status: 404 });

  const rest = vi.fn(async (method, fullPath, body) => {
    const [path, query = ""] = fullPath.split("?");
    const base = `/repos/${REPO}`;
    let m;
    if (method === "GET" && path === `${base}/issues`) return page(world.issues.map(raw), query);
    if (method === "GET" && path === `${base}/labels/human-window`) {
      if (!windowLabel) throw notFound();
      return { name: "human-window" };
    }
    if ((m = /^\/repos\/example\/repo\/issues\/(\d+)$/.exec(path)) && method === "GET") {
      return raw(world.issues.find((each) => each.number === Number(m[1])));
    }
    if ((m = /^\/repos\/example\/repo\/issues\/(\d+)\/events$/.exec(path))) return page(world.events[m[1]] ?? [], query);
    if ((m = /^\/repos\/example\/repo\/issues\/(\d+)\/comments$/.exec(path))) {
      if (method === "GET") {
        if (failComments.includes(Number(m[1]))) throw new Error("GitHub call failed: GET (exit 1)");
        return page(world.comments[m[1]] ?? [], query);
      }
      const created = {
        id: world.nextId++,
        created_at: new Date(NOW.getTime() + ++world.tick).toISOString(),
        body: body.body,
        user: { type: "Bot" },
        author_association: "NONE",
      };
      (world.comments[m[1]] ??= []).push(created);
      world.afterComment?.(Number(m[1]), world);
      return { id: created.id };
    }
    if ((m = /^\/repos\/example\/repo\/issues\/(\d+)\/labels$/.exec(path)) && method === "POST") {
      const target = world.issues.find((each) => each.number === Number(m[1]));
      for (const name of body.labels) if (!target.labels.includes(name)) target.labels.push(name);
      return [];
    }
    if ((m = /^\/repos\/example\/repo\/issues\/(\d+)\/labels\/(.+)$/.exec(path)) && method === "DELETE") {
      const target = world.issues.find((each) => each.number === Number(m[1]));
      const name = decodeURIComponent(m[2]);
      if (!target.labels.includes(name)) throw notFound();
      target.labels = target.labels.filter((each) => each !== name);
      return null;
    }
    if ((m = /^\/repos\/example\/repo\/issues\/comments\/(\d+)$/.exec(path)) && method === "DELETE") {
      for (const list of Object.values(world.comments)) {
        const index = list.findIndex((each) => each.id === Number(m[1]));
        if (index !== -1) list.splice(index, 1);
      }
      return null;
    }
    throw new Error(`unexpected ${method} ${fullPath}`);
  });

  const graphql = vi.fn(async () => ({
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: world.prs.map((each) => ({
          number: each.number,
          isDraft: each.isDraft,
          author: each.author,
          closingIssuesReferences: { nodes: each.closes.map((number) => ({ number })) },
        })),
      },
    },
  }));

  world.api = { repository: REPO, rest, graphql };
  world.writes = () => rest.mock.calls.filter((call) => call[0] !== "GET");
  world.issue = (number) => world.issues.find((each) => each.number === number);
  return world;
}

async function run(argv, world, env = {}) {
  const out = [];
  const err = [];
  const code = await main([...argv, "--repo", REPO], {
    api: world.api,
    now: () => NOW,
    env,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  return { code, out, err };
}

describe("evaluate", () => {
  it("AC-01 skips an issue in the human window", () => {
    expect(evaluate(issue(1, ["P1", "human-window"]), baseCtx())).toEqual({
      free: false,
      reason: "human window: open to people only",
    });
  });

  it("AC-02 skips a claimed: human label on its own", () => {
    expect(evaluate(issue(1, ["P1", "claimed: human"]), baseCtx())).toEqual({ free: false, reason: "held by a person" });
  });

  it("AC-02 skips an assignee on its own", () => {
    expect(evaluate(issue(1, ["P1"], { assignees: ["alice"] }), baseCtx())).toEqual({ free: false, reason: "held by a person" });
  });

  it("AC-05 skips an issue without a priority", () => {
    expect(evaluate(issue(1, ["bug"]), baseCtx())).toEqual({ free: false, reason: "not triaged" });
  });

  it("AC-03 skips P2 inside the 24 hour window and names the end in UTC", () => {
    const verdict = evaluate(issue(1, ["P2"]), baseCtx({ windowStart: ago(2) }));
    expect(verdict).toEqual({ free: false, reason: "human window: open to people until 2026-12-01 08:00 UTC" });
  });

  it("AC-03 frees P2 after 24 hours", () => {
    expect(evaluate(issue(1, ["P2"]), baseCtx({ windowStart: ago(25) })).free).toBe(true);
  });

  it("AC-03 uses the creation time when no label event is known", () => {
    const fresh = issue(1, ["P3"], { created_at: ago(1).toISOString() });
    expect(evaluate(fresh, baseCtx()).free).toBe(false);
  });

  it("AC-03 frees P2 with agent-ready inside the window", () => {
    expect(evaluate(issue(1, ["P2", "agent-ready"]), baseCtx({ windowStart: ago(2) })).free).toBe(true);
  });

  it("AC-03 frees P2 with a restricted label inside the window", () => {
    expect(evaluate(issue(1, ["P2", "area: ci"]), baseCtx({ windowStart: ago(2) })).free).toBe(true);
  });

  it("AC-03 turns the window rule off when the repository has no human-window label", () => {
    expect(evaluate(issue(1, ["P2"]), baseCtx({ usesWindow: false, windowStart: ago(2) })).free).toBe(true);
  });

  it("AC-03 never applies the window to P0 and P1", () => {
    expect(evaluate(issue(1, ["P1"]), baseCtx({ windowStart: ago(1) })).free).toBe(true);
  });

  it("AC-04 skips an issue that an open pull request closes", () => {
    expect(evaluate(issue(1, ["P1"]), baseCtx({ linkedOpenPrs: [42] }))).toEqual({
      free: false,
      reason: "open pull request #42",
    });
  });

  it("AC-04 skips an issue that another agent holds", () => {
    const claims = activeClaims([claimComment(1, "seira-urokai", ago(2))]);
    expect(evaluate(issue(1, ["P1", "claimed: agent"]), baseCtx({ claims }))).toEqual({
      free: false,
      reason: "held by another agent (seira-urokai)",
    });
  });

  it("AC-04 skips a claimed: agent label that has no claim comment and no age", () => {
    expect(evaluate(issue(1, ["P1", "claimed: agent"]), baseCtx({ claims: [] })).reason).toBe(
      "held by another agent (unknown)",
    );
  });

  it("AC-04 frees an agent claim of 24 hours or more", () => {
    const claims = activeClaims([claimComment(1, "seira-urokai", ago(24))]);
    expect(evaluate(issue(1, ["P1", "claimed: agent"]), baseCtx({ claims }))).toEqual({
      free: true,
      reason: "stale agent claim",
    });
  });

  it("AC-04 frees an old claimed: agent label that has no claim comment", () => {
    const verdict = evaluate(issue(1, ["P1", "claimed: agent"]), baseCtx({ claims: [], claimLabeledAt: ago(30) }));
    expect(verdict.reason).toBe("stale agent claim");
  });

  it("AC-04 reports an own claim as yours", () => {
    const claims = activeClaims([claimComment(1, "Seira-Lagus", ago(1))]);
    expect(evaluate(issue(1, ["P1", "claimed: agent"]), baseCtx({ claims }))).toEqual({ free: true, reason: "yours" });
  });

  it("AC-01 checks the human window before every other rule", () => {
    const both = issue(1, ["human-window", "claimed: human"]);
    expect(evaluate(both, baseCtx()).reason).toMatch(/^human window/);
  });
});

describe("needsDetail", () => {
  it("AC-03 asks for events only when the window rule can apply", () => {
    expect(needsDetail(issue(1, ["P2"]), { usesWindow: true })).toEqual({ comments: false, events: true });
    expect(needsDetail(issue(1, ["P1"]), { usesWindow: true })).toEqual({ comments: false, events: false });
    expect(needsDetail(issue(1, ["P2"]), { usesWindow: false })).toEqual({ comments: false, events: false });
    expect(needsDetail(issue(1, ["P2", "human-window"]), { usesWindow: true }).events).toBe(false);
  });

  it("AC-04 asks for comments of a claimed issue", () => {
    expect(needsDetail(issue(1, ["P1", "claimed: agent"]), {})).toEqual({ comments: true, events: true });
  });
});

describe("claim comments", () => {
  it("AC-07 reads only a marker on the first line", () => {
    expect(parseMarker(claimText("seira-lagus"))).toEqual({ kind: "claim", agent: "seira-lagus" });
    expect(parseMarker(`hello\n${claimText("seira-lagus")}`)).toBeNull();
    expect(parseMarker("<!-- agent-pick:claim agent=bad name -->")).toBeNull();
    expect(parseMarker(`${claimText("seira-lagus")} extra`.split("\n").join(" "))).toBeNull();
  });

  it("AC-09 drops a claim after its release and keeps the order", () => {
    const claims = activeClaims([
      claimComment(3, "b", ago(1)),
      claimComment(1, "a", ago(3)),
      claimComment(2, "a", ago(2), "release"),
    ]);
    expect(claims.map((claim) => claim.agent)).toEqual(["b"]);
  });

  it("AC-04 ignores a marker from an account outside the repository", () => {
    const outside = (id, agent, at, extra) => ({ ...claimComment(id, agent, at), user: { type: "User" }, ...extra });
    const claims = activeClaims([
      outside(1, "spoof", ago(3), { author_association: "NONE" }),
      outside(2, "spoof2", ago(3), { author_association: "FIRST_TIME_CONTRIBUTOR" }),
      outside(3, "spoof3", ago(3), { author_association: undefined }),
      outside(4, "rama-session", ago(2), { author_association: "MEMBER" }),
      claimComment(5, "seira-lagus", ago(1)),
    ]);
    expect(claims.map((claim) => claim.agent)).toEqual(["rama-session", "seira-lagus"]);
  });

  it("AC-08 puts the earliest claim first", () => {
    const claims = activeClaims([claimComment(5, "b", ago(1)), claimComment(4, "a", ago(2))]);
    expect(claims[0].agent).toBe("a");
  });

  it("AC-09 words the expired release for the issue thread", () => {
    expect(expiredText("a")).toContain("expired because no pull request came in");
  });
});

describe("rank", () => {
  it("AC-06 orders agent-ready, priority, size, then number", () => {
    const list = [
      issue(9, ["P1"]),
      issue(8, ["P0", "size: L"]),
      issue(7, ["P0", "size: S"]),
      issue(6, ["P0"]),
      issue(5, ["P3", "agent-ready"]),
      issue(4, ["P0", "size: S"]),
      issue(3, ["P2", "agent-ready", "size: XS"]),
    ];
    expect([...list].sort(rank).map((each) => each.number)).toEqual([3, 5, 4, 7, 8, 6, 9]);
  });
});

describe("wipBlock", () => {
  const owned = (number, agent, hours = 1) => [number, { claims: [{ agent, at: ago(hours), commentId: 1 }], claimLabeledAt: null }];
  const input = (extra = {}) => ({
    issue: issue(50, ["P2"]),
    agent: "seira-lagus",
    issues: [],
    prs: [],
    claimsByIssue: new Map(),
    agentLogins: new Set(),
    now: NOW,
    ...extra,
  });

  it("AC-10 blocks an agent with 2 claims for P2 but not for P0", () => {
    const claimsByIssue = new Map([owned(1, "seira-lagus"), owned(2, "Seira-Lagus")]);
    expect(wipBlock(input({ claimsByIssue }))).toBe("agent limit: seira-lagus already has 2 open items");
    expect(wipBlock(input({ claimsByIssue, issue: issue(50, ["P0"]) }))).toBeNull();
  });

  it("AC-10 counts open pull requests of the agent and counts a claim with its pull request once", () => {
    const claimsByIssue = new Map([owned(1, "seira-lagus")]);
    const linked = [pr(10, "seira-lagus[bot]", [1])];
    expect(wipBlock(input({ claimsByIssue, prs: linked }))).toBeNull();
    const extra = [...linked, pr(11, "app/seira-lagus", [])];
    expect(wipBlock(input({ claimsByIssue, prs: extra }))).toMatch(/^agent limit: seira-lagus already has 2/);
  });

  it("AC-10 ignores the agent limit when no agent is given", () => {
    const claimsByIssue = new Map([owned(1, "a"), owned(2, "a")]);
    expect(wipBlock(input({ claimsByIssue, agent: null }))).toBeNull();
  });

  it("AC-11 blocks at 10 ready agent pull requests and not at 9", () => {
    const ready = (count) => Array.from({ length: count }, (_, i) => pr(100 + i, `bot-${i}`));
    expect(wipBlock(input({ prs: ready(10) }))).toBe("queue limit: 10 agent pull requests wait for merge");
    expect(wipBlock(input({ prs: ready(9) }))).toBeNull();
    expect(wipBlock(input({ prs: ready(10), issue: issue(50, ["P0"]) }))).toBeNull();
  });

  it("AC-11 does not count drafts", () => {
    const prs = Array.from({ length: 10 }, (_, i) => pr(100 + i, `bot-${i}`, [], { isDraft: i < 2 }));
    expect(wipBlock(input({ prs }))).toBeNull();
  });

  it("AC-11 counts a user pull request only when the login is in the agent list", () => {
    const user = (i) => ({ number: 200 + i, isDraft: false, author: { login: "Alice", __typename: "User" }, closes: [] });
    const prs = Array.from({ length: 10 }, (_, i) => user(i));
    expect(wipBlock(input({ prs }))).toBeNull();
    expect(wipBlock(input({ prs, agentLogins: new Set([normalizeLogin("alice")]) }))).toMatch(/^queue limit: 10/);
  });

  it("AC-12 blocks at 3 issues in progress in the same area", () => {
    const area = (number, extra = []) => issue(number, ["P1", "area: server", ...extra]);
    const issues = [
      area(1, ["claimed: agent"]),
      area(2, ["claimed: agent"]),
      area(3),
      area(4, ["claimed: agent"]),
      issue(5, ["P1", "area: web", "claimed: agent"]),
    ];
    const claimsByIssue = new Map([owned(1, "a"), owned(2, "b"), owned(4, "stale", 30), owned(5, "c")]);
    const target = issue(50, ["P2", "area: server"]);
    expect(wipBlock(input({ issues, claimsByIssue, issue: target, agent: null, prs: [] }))).toBeNull();
    const withPr = [pr(9, "bot", [3])];
    expect(wipBlock(input({ issues, claimsByIssue, issue: target, agent: null, prs: withPr }))).toBe(
      "area limit: 3 issues in area: server are in progress",
    );
    expect(wipBlock(input({ issues, claimsByIssue, issue: issue(50, ["P0", "area: server"]), prs: withPr }))).toBeNull();
  });
});

describe("list and check", () => {
  const world = () =>
    makeWorld({
      issues: [
        issue(1, ["P1", "verified"]),
        issue(2, ["P1", "human-window"]),
        issue(3, ["P1", "claimed: human"]),
        issue(4, ["P1"], { assignees: ["alice"] }),
        issue(5, ["P0", "size: S", "verified"]),
        issue(6, ["bug"]),
        issue(7, ["P2"], { created_at: "2026-11-30T09:00:00Z" }),
        issue(8, ["P3", "agent-ready", "size: XS"]),
        issue(9, ["P1", "claimed: agent"]),
        issue(10, ["P1"]),
      ],
      prs: [pr(90, "seira-urokai[bot]", [10])],
      comments: { 9: [claimComment(1, "seira-urokai", ago(2))] },
    });

  it("AC-17 lists no issue that a person holds, ranked best first", async () => {
    const { code, out } = await run(["list", "--agent", "seira-lagus"], world());
    expect(code).toBe(0);
    const lines = out.filter((line) => line.startsWith("#"));
    expect(lines).toEqual(["#8 P3 XS Issue 8", "#5 P0 S Issue 5", "#1 P1 - Issue 1"]);
    for (const held of [2, 3, 4]) expect(lines.join("\n")).not.toContain(`#${held} `);
    expect(out).toContain("skipped: human window: open to people only: #2");
    expect(out).toContain("skipped: held by a person: #3, #4");
    expect(out).toContain("skipped: not triaged: #6");
    expect(out).toContain("skipped: open pull request #90: #10");
    expect(out).toContain("skipped: held by another agent (seira-urokai): #9");
  });

  it("AC-06 filters by every given label", async () => {
    const { out } = await run(["list", "--label", "verified", "--label", "P0"], world());
    expect(out.filter((line) => line.startsWith("#"))).toEqual(["#5 P0 S Issue 5"]);
  });

  it("AC-06 prints the JSON shape", async () => {
    const { out } = await run(["list", "--json", "--agent", "seira-lagus"], world());
    const data = JSON.parse(out[0]);
    expect(data.wip).toBeNull();
    expect(data.free[0]).toEqual({ number: 8, title: "Issue 8", priority: "P3", size: "XS", agentReady: true });
    expect(data.free.map((each) => each.number)).toEqual([8, 5, 1]);
    expect(data.skipped).toContainEqual({ number: 3, reason: "held by a person" });
    expect(data.skipped.find((each) => each.number === 7).reason).toMatch(/^human window: open to people until /);
  });

  it("AC-10 reports the limit in the JSON and skips non-P0 issues", async () => {
    const stuck = makeWorld({
      issues: [issue(1, ["P1"]), issue(2, ["P0"]), issue(3, ["P1", "claimed: agent"]), issue(4, ["P1", "claimed: agent"])],
      comments: { 3: [claimComment(1, "seira-lagus", ago(1))], 4: [claimComment(2, "seira-lagus", ago(1))] },
    });
    const { out } = await run(["list", "--json", "--agent", "seira-lagus"], stuck);
    const data = JSON.parse(out[0]);
    expect(data.wip).toBe("agent limit: seira-lagus already has 2 open items");
    expect(data.free.map((each) => each.number).sort()).toEqual([2, 3, 4]);
  });

  it("AC-04 check exits 1 with the reason and 0 for a free issue", async () => {
    const w = world();
    expect(await run(["check", "9", "--agent", "seira-lagus"], w)).toMatchObject({
      code: 1,
      out: ["skip: #9: held by another agent (seira-urokai)"],
    });
    expect(await run(["check", "1", "--agent", "seira-lagus"], w)).toMatchObject({ code: 0, out: ["free: #1"] });
    expect(await run(["check", "999"], w)).toMatchObject({ code: 1 });
  });

  it("AC-01 check exits 1 with the human window reason", async () => {
    const { code, out } = await run(["check", "2"], world());
    expect(code).toBe(1);
    expect(out[0]).toBe("skip: #2: human window: open to people only");
  });

  it("AC-03 check gives the window end in UTC", async () => {
    const { code, out } = await run(["check", "7"], world());
    expect(code).toBe(1);
    expect(out[0]).toBe("skip: #7: human window: open to people until 2026-12-01 09:00 UTC");
  });

  it("AC-03 reads the first P2 or P3 label event as the window start", async () => {
    const w = world();
    w.events[7] = [
      { event: "labeled", label: { name: "P3" }, created_at: ago(30).toISOString() },
      { event: "labeled", label: { name: "P2" }, created_at: ago(1).toISOString() },
    ];
    expect((await run(["check", "7"], w)).code).toBe(0);
  });

  it("AC-03 skips the events call for an issue outside the window rule", async () => {
    const w = world();
    await run(["check", "1"], w);
    const paths = w.api.rest.mock.calls.map((call) => call[1]);
    expect(paths.some((path) => path.includes("/issues/1/events"))).toBe(false);
    expect(paths.some((path) => path.includes("/issues/7/events"))).toBe(true);
  });

  it("AC-03 turns the window rule off for a repository without the label", async () => {
    const w = makeWorld({ issues: [issue(7, ["P2"], { created_at: "2026-11-30T09:00:00Z" })], windowLabel: false });
    expect((await run(["check", "7"], w)).code).toBe(0);
  });

  it("AC-10 refuses P1 for an agent at its limit while P0 stays free", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1"]), issue(2, ["P0"])],
      prs: [pr(10, "seira-lagus[bot]", [77]), pr(11, "seira-lagus[bot]", [78])],
    });
    expect((await run(["check", "1", "--agent", "seira-lagus"], w)).out[0]).toMatch(/^skip: #1: agent limit/);
    expect((await run(["check", "2", "--agent", "seira-lagus"], w)).code).toBe(0);
  });

  it("AC-11 counts a user pull request as an agent pull request through the env list", async () => {
    const users = Array.from({ length: 10 }, (_, i) => ({
      number: 300 + i,
      isDraft: false,
      author: { login: "alice", __typename: "User" },
      closes: [],
    }));
    const w = makeWorld({ issues: [issue(1, ["P1"])], prs: users });
    expect((await run(["check", "1"], w)).code).toBe(0);
    const blocked = await run(["check", "1"], w, { AGENT_PICK_AGENT_LOGINS: "Alice, other" });
    expect(blocked.out[0]).toMatch(/^skip: #1: queue limit: 10/);
  });
});

describe("claim", () => {
  it("AC-07 adds the label and one claim comment", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["claimed: #1"]);
    expect(w.writes()).toEqual([
      ["POST", `/repos/${REPO}/issues/1/labels`, { labels: ["claimed: agent"] }],
      ["POST", `/repos/${REPO}/issues/1/comments`, { body: claimText("seira-lagus") }],
    ]);
    expect(w.issue(1).labels).toContain("claimed: agent");
  });

  it("AC-07 requires an agent name and checks its shape", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    expect((await run(["claim", "1"], w)).code).toBe(2);
    expect((await run(["claim", "1", "--agent", "bad name"], w)).code).toBe(2);
    expect(w.writes()).toEqual([]);
  });

  it("AC-01 refuses a claim in the human window without writes", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1", "human-window"])] });
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^skip: #1: human window/);
    expect(w.writes()).toEqual([]);
  });

  it("AC-07 does not write again when the claim is already yours", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1", "claimed: agent"])],
      comments: { 1: [claimComment(1, "seira-lagus", ago(1))] },
    });
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["already yours: #1"]);
    expect(w.writes()).toEqual([]);
  });

  it("AC-08 removes its own comment and keeps the label when an earlier claim of another agent exists", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    w.afterComment = (number) => {
      w.comments[number].unshift(claimComment(900, "seira-urokai", new Date(NOW.getTime() - 5000)));
    };
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(3);
    expect(out).toEqual(["lost: #1: held by another agent (seira-urokai)"]);
    expect(w.comments[1].map((each) => each.id)).toEqual([900]);
    expect(w.issue(1).labels).toContain("claimed: agent");
    expect(w.writes().some((call) => call[0] === "DELETE" && call[1].includes("/labels/"))).toBe(false);
  });

  it("AC-08 removes its own comment and the label when a person takes the issue", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    w.afterComment = () => w.issue(1).labels.push("claimed: human");
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(3);
    expect(out).toEqual(["lost: #1: held by a person"]);
    expect(w.comments[1]).toEqual([]);
    expect(w.issue(1).labels).toEqual(["P1", "claimed: human"]);
    expect(w.writes()).toContainEqual(["DELETE", `/repos/${REPO}/issues/1/labels/claimed%3A%20agent`]);
  });

  it("AC-08 treats a new assignee as a person hold", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    w.afterComment = () => w.issue(1).assignees.push("alice");
    expect((await run(["claim", "1", "--agent", "seira-lagus"], w)).code).toBe(3);
    expect(w.issue(1).labels).toEqual(["P1"]);
  });

  it("AC-08 keeps the label of another agent when a person also took the issue", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    w.afterComment = (number) => {
      w.issue(1).labels.push("claimed: human");
      w.comments[number].unshift(claimComment(900, "seira-urokai", new Date(NOW.getTime() - 5000)));
    };
    expect((await run(["claim", "1", "--agent", "seira-lagus"], w)).code).toBe(3);
    expect(w.issue(1).labels).toContain("claimed: agent");
  });

  it("AC-04 posts the expired release first when it takes over a stale claim", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1", "claimed: agent"])],
      comments: { 1: [claimComment(1, "seira-urokai", ago(30))] },
    });
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["claimed: #1"]);
    expect(w.writes().map((call) => call[2].body ?? call[2].labels[0])).toEqual([
      expiredText("seira-urokai"),
      "claimed: agent",
      claimText("seira-lagus"),
    ]);
  });

  it("AC-10 refuses a claim over the agent limit", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1"]), issue(2, ["P1", "claimed: agent"]), issue(3, ["P1", "claimed: agent"])],
      comments: { 2: [claimComment(1, "seira-lagus", ago(1))], 3: [claimComment(2, "seira-lagus", ago(1))] },
    });
    const { code, out } = await run(["claim", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(1);
    expect(out[0]).toMatch(/^skip: #1: agent limit/);
    expect(w.writes()).toEqual([]);
  });
});

describe("release", () => {
  it("AC-09 writes one release comment and removes the label", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1", "claimed: agent"])],
      comments: { 1: [claimComment(1, "seira-lagus", ago(1))] },
    });
    const { code, out } = await run(["release", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["released: #1"]);
    expect(w.writes()).toEqual([
      ["POST", `/repos/${REPO}/issues/1/comments`, { body: releaseText("seira-lagus") }],
      ["DELETE", `/repos/${REPO}/issues/1/labels/claimed%3A%20agent`],
    ]);
  });

  it("AC-09 refuses to touch the claim of another agent", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1", "claimed: agent"])],
      comments: { 1: [claimComment(1, "seira-urokai", ago(1))] },
    });
    const { code, out } = await run(["release", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(1);
    expect(out).toEqual(["skip: #1: held by another agent (seira-urokai)"]);
    expect(w.writes()).toEqual([]);
  });

  it("AC-09 keeps the label when another agent still holds a claim after the release", async () => {
    const w = makeWorld({
      issues: [issue(1, ["P1", "claimed: agent"])],
      comments: { 1: [claimComment(1, "seira-lagus", ago(2)), claimComment(2, "seira-urokai", ago(1))] },
    });
    expect((await run(["release", "1", "--agent", "seira-lagus"], w)).code).toBe(0);
    expect(w.issue(1).labels).toContain("claimed: agent");
  });

  it("AC-09 removes a label that has no claim comment", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1", "claimed: agent"])] });
    expect((await run(["release", "1", "--agent", "seira-lagus"], w)).code).toBe(0);
    expect(w.issue(1).labels).toEqual(["P1"]);
  });

  it("AC-09 succeeds when there is nothing to release", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    const { code, out } = await run(["release", "1", "--agent", "seira-lagus"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["nothing to release: #1"]);
    expect(w.writes()).toEqual([]);
  });
});

describe("sweep", () => {
  const claimed = (number) => issue(number, ["P1", "claimed: agent"]);

  it("AC-13 releases a 25 hour claim without a pull request and keeps the rest", async () => {
    const w = makeWorld({
      issues: [claimed(1), claimed(2), claimed(3)],
      prs: [pr(50, "seira-lagus[bot]", [3])],
      comments: {
        1: [claimComment(1, "seira-lagus", ago(25))],
        2: [claimComment(2, "seira-urokai", ago(23))],
        3: [claimComment(3, "seira-m21", ago(30))],
      },
    });
    const { code, out } = await run(["sweep"], w);
    expect(code).toBe(0);
    expect(out).toEqual(["released: #1 (seira-lagus)"]);
    expect(w.issue(1).labels).toEqual(["P1"]);
    expect(w.issue(2).labels).toContain("claimed: agent");
    expect(w.issue(3).labels).toContain("claimed: agent");
    expect(w.writes()).toEqual([
      ["POST", `/repos/${REPO}/issues/1/comments`, { body: expiredText("seira-lagus") }],
      ["DELETE", `/repos/${REPO}/issues/1/labels/claimed%3A%20agent`],
    ]);
  });

  it("AC-13 uses the label event time when no claim comment exists", async () => {
    const w = makeWorld({
      issues: [claimed(1)],
      events: { 1: [{ event: "labeled", label: { name: "claimed: agent" }, created_at: ago(26).toISOString() }] },
    });
    const { out } = await run(["sweep"], w);
    expect(out).toEqual(["released: #1 (unknown)"]);
    expect(w.writes()).toEqual([["DELETE", `/repos/${REPO}/issues/1/labels/claimed%3A%20agent`]]);
  });

  it("AC-13 keeps going after one failing issue and exits 2", async () => {
    const w = makeWorld({
      issues: [claimed(1), claimed(2)],
      comments: { 1: [claimComment(1, "a", ago(30))], 2: [claimComment(2, "b", ago(30))] },
      failComments: [1],
    });
    const { code, out, err } = await run(["sweep"], w);
    expect(code).toBe(2);
    expect(out).toEqual(["released: #2 (b)"]);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^failed: #1:/);
  });
});

describe("createGhApi", () => {
  it("AC-14 sends a REST call with the body on stdin", () => {
    const run = vi.fn(() => '{"ok":true}');
    const api = createGhApi({ repository: REPO, run });
    expect(api.rest("POST", "/repos/example/repo/issues/1/labels", { labels: ["x"] })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      ["api", "-X", "POST", "/repos/example/repo/issues/1/labels", "-H", "Accept: application/vnd.github+json", "--input", "-"],
      '{"labels":["x"]}',
    );
  });

  it("AC-14 sends a read call without stdin and maps empty output to null", () => {
    const run = vi.fn(() => "");
    const api = createGhApi({ repository: REPO, run });
    expect(api.rest("DELETE", "/repos/example/repo/issues/comments/1")).toBeNull();
    expect(run.mock.calls[0]).toEqual([
      ["api", "-X", "DELETE", "/repos/example/repo/issues/comments/1", "-H", "Accept: application/vnd.github+json"],
      undefined,
    ]);
  });

  it("AC-14 sends GraphQL on stdin and rejects an errors field", () => {
    const run = vi.fn(() => '{"data":{"a":1}}');
    const api = createGhApi({ repository: REPO, run });
    expect(api.graphql("query {}", { x: 1 })).toEqual({ a: 1 });
    expect(run).toHaveBeenCalledWith(["api", "graphql", "--input", "-"], '{"query":"query {}","variables":{"x":1}}');
    const bad = createGhApi({ repository: REPO, run: () => '{"errors":[{"message":"ghs_SECRET"}]}' });
    expect(() => bad.graphql("query {}", {})).toThrow(/GraphQL error/);
    expect(() => bad.graphql("query {}", {})).not.toThrow(/ghs_SECRET/);
  });

  it("AC-14 keeps a token out of the failure message and keeps the HTTP status", () => {
    const failing = () => {
      throw Object.assign(new Error("Command failed: gh api ghs_SECRET"), { status: 1, stderr: "gh: Not Found (HTTP 404) ghs_SECRET" });
    };
    const api = createGhApi({ repository: REPO, run: failing });
    let caught;
    try {
      api.rest("GET", "/repos/example/repo/issues/9");
    } catch (error) {
      caught = error;
    }
    expect(caught.message).toBe("GitHub call failed: GET /repos/example/repo/issues/9 (exit 1)");
    expect(caught.message).not.toContain("ghs_SECRET");
    expect(caught.status).toBe(404);
  });
});

describe("main", () => {
  it("AC-14 returns 2 on an unknown command", async () => {
    const err = [];
    expect(await main(["nope"], { api: {}, error: (line) => err.push(line), log: () => {} })).toBe(2);
    expect(await main([], { api: {}, error: () => {}, log: () => {} })).toBe(2);
    expect(err[0]).toMatch(/^usage:/);
  });

  it("AC-14 returns 2 on a bad agent name, a bad number and an unknown option", async () => {
    const quiet = { api: {}, error: () => {}, log: () => {} };
    expect(await main(["claim", "1", "--agent", "-bad"], quiet)).toBe(2);
    expect(await main(["claim", "1", "--agent", "x".repeat(60)], quiet)).toBe(2);
    expect(await main(["check", "abc"], quiet)).toBe(2);
    expect(await main(["list", "--wat"], quiet)).toBe(2);
    expect(await main(["list", "--repo", "no-slash"], quiet)).toBe(2);
  });

  it("AC-14 accepts an agent name that ends in [bot]", async () => {
    const w = makeWorld({ issues: [issue(1, ["P1"])] });
    expect((await run(["check", "1", "--agent", "seira-lagus[bot]"], w)).code).toBe(0);
  });

  it("AC-14 returns 2 with a short message when GitHub fails", async () => {
    const err = [];
    const api = {
      repository: REPO,
      rest: async () => {
        throw new Error("GitHub call failed: GET /repos/example/repo/issues (exit 1)");
      },
      graphql: async () => ({}),
    };
    const code = await main(["list", "--repo", REPO], { api, error: (line) => err.push(line), log: () => {}, now: () => NOW });
    expect(code).toBe(2);
    expect(err).toEqual(["error: GitHub call failed: GET /repos/example/repo/issues (exit 1)"]);
  });
});
