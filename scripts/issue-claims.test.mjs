import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimDeadline,
  claimLimit,
  createApi,
  desiredWindow,
  formatUtc,
  formatWib,
  isMaintainer,
  isRestricted,
  main,
  onComment,
  onLabeled,
  parseCommand,
  priorityOf,
  reconcile,
  sweep,
  windowEnd,
} from "./issue-claims.mjs";

const REPO = "seira-bot/seira";
const HOUR = 3_600_000;
const NOW = new Date("2026-11-30T10:00:00Z");
const ago = (hours, from = NOW) => new Date(from.getTime() - hours * HOUR).toISOString();

function httpError(status) {
  const error = new Error(`failed with HTTP ${status}`);
  error.status = status;
  return error;
}

function fakeApi({ issues = [], events = {}, comments = {}, linked = {}, cannotAssign = [], dropAssign = [], ghostLabels = false, failOn } = {}) {
  const state = {
    issues: issues.map((each) => ({ state: "open", labels: [], assignees: [], created_at: ago(100), ...each })),
    comments: Object.fromEntries(Object.entries(comments).map(([key, list]) => [key, [...list]])),
    calls: [],
  };
  const shape = (each) => ({
    ...each,
    labels: each.labels.map((name) => ({ name })),
    assignees: each.assignees.map((login) => ({ login })),
  });
  const find = (number) => state.issues.find((each) => each.number === Number(number));
  const writes = () => state.calls.filter((call) => call.method !== "GET" && call.path !== "/graphql");
  const posted = (number) => (state.comments[number] ?? []).filter((each) => each.fake).map((each) => each.body);
  const api = {
    repository: REPO,
    async rest(method, path, body) {
      state.calls.push({ method, path, body });
      const failure = failOn?.(method, path);
      if (failure !== undefined) throw httpError(failure);
      const [route, query = ""] = path.split("?");
      const params = new URLSearchParams(query);
      const page = Number(params.get("page") ?? 1);
      const paged = (list) => list.slice((page - 1) * 100, page * 100);
      let match;
      if (method === "GET" && route === `/repos/${REPO}/issues`) {
        const labels = (params.get("labels") ?? "").split(",").filter(Boolean);
        const assignee = params.get("assignee");
        return paged(
          state.issues
            .filter((each) => each.state === params.get("state"))
            .filter((each) => labels.every((name) => each.labels.includes(name)))
            .filter((each) => assignee === null || each.assignees.includes(assignee))
            .map(shape),
        );
      }
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(route)) && method === "GET") return shape(find(match[1]));
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/events$/.exec(route))) return paged(events[match[1]] ?? []);
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(route))) {
        if (method === "GET") return paged(state.comments[match[1]] ?? []);
        (state.comments[match[1]] ??= []).push({ body: body.body, created_at: NOW.toISOString(), fake: true });
        return {};
      }
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/assignees\/([^/]+)$/.exec(route))) {
        if (cannotAssign.includes(decodeURIComponent(match[2]))) throw httpError(404);
        return null;
      }
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/assignees$/.exec(route))) {
        const found = find(match[1]);
        if (method === "POST") {
          for (const login of body.assignees) if (!dropAssign.includes(login) && !found.assignees.includes(login)) found.assignees.push(login);
          return shape(found);
        }
        found.assignees = found.assignees.filter((login) => !body.assignees.includes(login));
        return shape(found);
      }
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(route)) && method === "POST") {
        const found = find(match[1]);
        for (const name of body.labels) if (!found.labels.includes(name)) found.labels.push(name);
        return found.labels.map((name) => ({ name }));
      }
      if ((match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/(.+)$/.exec(route)) && method === "DELETE") {
        const found = find(match[1]);
        const name = decodeURIComponent(match[2]);
        if (ghostLabels || !found.labels.includes(name)) throw httpError(404);
        found.labels = found.labels.filter((each) => each !== name);
        return found.labels.map((each) => ({ name: each }));
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
    async graphql(query, variables) {
      state.calls.push({ method: "POST", path: "/graphql", variables });
      const nodes = linked[variables.number] ?? [];
      return { repository: { issue: { closedByPullRequestsReferences: { nodes } } } };
    },
  };
  return { api, state, writes, posted, issue: (number) => find(number) };
}

const labeledAt = (name, at) => ({ event: "labeled", label: { name }, created_at: at });
const commentEvent = (number, body, { login = "alice", association = "NONE", type = "User", pull = false } = {}) => ({
  issue: { number, ...(pull ? { pull_request: {} } : {}) },
  comment: { body, user: { login, type }, author_association: association },
});
const takeBy = (fake, number, options) => onComment({ api: fake.api, event: commentEvent(number, "/take", options), now: NOW });
const labelOps = (fake) => fake.writes().filter((call) => call.path.includes("/labels"));

describe("parseCommand", () => {
  it("AC-15: accepts only a body that is exactly one command", () => {
    expect(parseCommand("/take")).toBe("take");
    expect(parseCommand("/untake")).toBe("untake");
    expect(parseCommand(" /take ")).toBe("take");
    expect(parseCommand("/take\r\n")).toBe("take");
    expect(parseCommand("\r\n/untake\r\n")).toBe("untake");
  });

  it("AC-15: rejects extra text, a second line, other case and no body", () => {
    for (const body of ["/take please", "/take\n/untake", "/take\nthanks", "/TAKE", "/Untake", "take", "", null, undefined, "I will /take it"]) {
      expect(parseCommand(body)).toBeNull();
    }
  });
});

describe("claim rules", () => {
  it("AC-09: sets the claim limit by author association", () => {
    expect(claimLimit("OWNER")).toBe(Infinity);
    expect(claimLimit("MEMBER")).toBe(Infinity);
    expect(claimLimit("COLLABORATOR")).toBe(2);
    expect(claimLimit("CONTRIBUTOR")).toBe(2);
    for (const association of ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN", "SOMETHING_NEW", undefined]) {
      expect(claimLimit(association)).toBe(1);
    }
  });

  it("treats only OWNER and MEMBER as maintainers", () => {
    expect(isMaintainer("OWNER")).toBe(true);
    expect(isMaintainer("MEMBER")).toBe(true);
    expect(isMaintainer("COLLABORATOR")).toBe(false);
    expect(isMaintainer("NONE")).toBe(false);
  });

  it("picks the highest priority label", () => {
    expect(priorityOf(["bug", "P3", "P1"])).toBe("P1");
    expect(priorityOf(["P3", "P2"])).toBe("P2");
    expect(priorityOf(["bug", "size: S"])).toBeNull();
  });

  it("AC-03: marks the restricted labels, and leaves an issue with no size label open", () => {
    for (const name of ["size: L", "size: XL", "needs-split", "needs-security-review", "area: ci"]) expect(isRestricted([name, "P2"])).toBe(true);
    expect(isRestricted(["P2"])).toBe(false);
    expect(isRestricted(["P2", "size: S", "size: M", "area: server"])).toBe(false);
  });
});

describe("time helpers", () => {
  it("AC-14: adds 72 hours to a Monday claim and keeps the time", () => {
    expect(claimDeadline(new Date("2026-11-30T09:30:00Z")).toISOString()).toBe("2026-12-03T09:30:00.000Z");
  });

  it("AC-14: moves a Saturday deadline of a Wednesday claim to Monday 12:00 UTC", () => {
    expect(claimDeadline(new Date("2026-12-02T08:15:00Z")).toISOString()).toBe("2026-12-07T12:00:00.000Z");
  });

  it("AC-14: moves a Sunday deadline of a Thursday claim to Monday 12:00 UTC", () => {
    expect(claimDeadline(new Date("2026-12-03T23:50:00Z")).toISOString()).toBe("2026-12-07T12:00:00.000Z");
  });

  it("AC-14: keeps a Friday deadline and a Monday deadline as they are", () => {
    expect(claimDeadline(new Date("2026-12-01T10:00:00Z")).toISOString()).toBe("2026-12-04T10:00:00.000Z");
    expect(claimDeadline(new Date("2026-12-04T10:00:00Z")).toISOString()).toBe("2026-12-07T10:00:00.000Z");
  });

  it("ends the human window 24 hours after the start", () => {
    expect(windowEnd(new Date("2026-11-27T10:00:00Z")).toISOString()).toBe("2026-11-28T10:00:00.000Z");
  });

  it("formats UTC and WIB", () => {
    const date = new Date("2026-11-28T14:00:00Z");
    expect(formatUtc(date)).toBe("2026-11-28 14:00 UTC");
    expect(formatWib(date)).toBe("21:00 WIB");
    expect(formatWib(new Date("2026-11-28T20:30:00Z"))).toBe("2026-11-29 03:30 WIB");
  });
});

describe("desiredWindow", () => {
  const start = new Date("2026-11-30T09:00:00Z");
  const ask = (labels, extra = {}) => desiredWindow({ labels, assigned: false, windowStart: start, now: NOW, ...extra });

  it("gives a P2 or P3 issue the human window while the window is open", () => {
    expect(ask(["P2"])).toBe("human-window");
    expect(ask(["P3", "size: S"])).toBe("human-window");
  });

  it("gives P0, P1, a restricted issue and an old window the agent label", () => {
    expect(ask(["P0"])).toBe("agent-ready");
    expect(ask(["P1"])).toBe("agent-ready");
    expect(ask(["P2", "size: L"])).toBe("agent-ready");
    expect(ask(["P2"], { windowStart: new Date(NOW.getTime() - 24 * HOUR) })).toBe("agent-ready");
  });

  it("gives nothing to an assigned issue, a claimed issue or an issue with no priority", () => {
    expect(ask(["P2"], { assigned: true })).toBeNull();
    expect(ask(["P2", "claimed: human"])).toBeNull();
    expect(ask(["P2", "claimed: agent"])).toBeNull();
    expect(ask(["bug"])).toBeNull();
  });
});

describe("labeled issue", () => {
  const labeled = (number, name) => ({ issue: { number }, label: { name } });
  const run = (fake, event) => onLabeled({ api: fake.api, event, now: NOW });

  it("AC-01: adds human-window and posts one comment with the end in UTC and WIB", async () => {
    const fake = fakeApi({
      issues: [{ number: 5, labels: ["P2", "size: S"] }],
      events: { 5: [labeledAt("P2", ago(1))] },
    });
    await run(fake, labeled(5, "P2"));
    expect(fake.issue(5).labels).toContain("human-window");
    expect(fake.posted(5)).toEqual([
      "Open for human contributors until 2026-12-01 09:00 UTC (16:00 WIB). Comment `/take` to claim it.\n\n<!-- issue-claims:window -->",
    ]);
  });

  it("AC-01: posts no second window comment when one with the marker exists", async () => {
    const fake = fakeApi({
      issues: [{ number: 5, labels: ["P3"] }],
      events: { 5: [labeledAt("P3", ago(1))] },
      comments: { 5: [{ body: "Open for human contributors.\n\n<!-- issue-claims:window -->", created_at: ago(2) }] },
    });
    await run(fake, labeled(5, "P3"));
    expect(fake.issue(5).labels).toContain("human-window");
    expect(fake.posted(5)).toEqual([]);
  });

  it("AC-01: starts the window at the first P2 or P3 label, not at the last one", async () => {
    const fake = fakeApi({
      issues: [{ number: 5, labels: ["P2"] }],
      events: { 5: [labeledAt("bug", ago(40)), labeledAt("P3", ago(30)), labeledAt("P2", ago(1))] },
    });
    await run(fake, labeled(5, "P2"));
    expect(fake.issue(5).labels).toContain("agent-ready");
    expect(fake.issue(5).labels).not.toContain("human-window");
    expect(fake.posted(5)).toEqual([]);
  });

  it("AC-01: uses the creation time of the issue when no P2 or P3 event exists", async () => {
    const fake = fakeApi({ issues: [{ number: 5, labels: ["P2"], created_at: ago(2) }] });
    await run(fake, labeled(5, "P2"));
    expect(fake.issue(5).labels).toContain("human-window");
  });

  it("AC-01: leaves an assigned issue without a window label", async () => {
    const fake = fakeApi({ issues: [{ number: 5, labels: ["P2", "human-window"], assignees: ["bob"] }] });
    await run(fake, labeled(5, "P2"));
    expect(fake.issue(5).labels).toEqual(["P2"]);
    expect(fake.posted(5)).toEqual([]);
  });

  it("AC-02: replaces human-window with agent-ready when P0 or P1 lands", async () => {
    for (const priority of ["P0", "P1"]) {
      const fake = fakeApi({ issues: [{ number: 6, labels: [priority, "human-window"] }] });
      await run(fake, labeled(6, priority));
      expect(fake.issue(6).labels).toEqual([priority, "agent-ready"]);
    }
  });

  it("AC-02: keeps a claim when the priority rises", async () => {
    const fake = fakeApi({ issues: [{ number: 6, labels: ["P0", "claimed: human"], assignees: ["alice"] }] });
    await run(fake, labeled(6, "P0"));
    expect(fake.writes()).toEqual([]);
    expect(fake.issue(6).assignees).toEqual(["alice"]);
  });

  it("AC-03: gives an unassigned restricted issue agent-ready and no human-window", async () => {
    for (const name of ["size: L", "size: XL", "needs-split", "needs-security-review", "area: ci"]) {
      const fake = fakeApi({ issues: [{ number: 7, labels: ["P2", name, "human-window"] }] });
      await run(fake, labeled(7, "P2"));
      expect(fake.issue(7).labels, name).toEqual(["P2", name, "agent-ready"]);
      expect(fake.posted(7), name).toEqual([]);
    }
  });

  it("ignores a label that is not a priority, a closed issue and a pull request", async () => {
    const fake = fakeApi({
      issues: [
        { number: 8, labels: ["P2", "bug"] },
        { number: 9, labels: ["P2"], state: "closed" },
        { number: 10, labels: ["P2"], pull_request: {} },
      ],
    });
    await run(fake, labeled(8, "bug"));
    await run(fake, labeled(9, "P2"));
    await run(fake, labeled(10, "P2"));
    expect(fake.writes()).toEqual([]);
  });

  it("treats a 404 on label removal as done", async () => {
    const fake = fakeApi({ issues: [{ number: 6, labels: ["P0", "human-window"] }], ghostLabels: true });
    await run(fake, labeled(6, "P0"));
    expect(fake.issue(6).labels).toContain("agent-ready");
  });
});

describe("comment /take", () => {
  const issueP2 = (extra = {}) => ({ number: 20, labels: ["P2", "size: S", "human-window"], ...extra });

  it("AC-06: assigns the person, adds claimed: human, removes both window labels and replies with the deadline", async () => {
    const fake = fakeApi({ issues: [issueP2({ labels: ["P2", "human-window", "agent-ready"] })] });
    await takeBy(fake, 20);
    expect(fake.issue(20).assignees).toEqual(["alice"]);
    expect(fake.issue(20).labels).toEqual(["P2", "claimed: human"]);
    expect(fake.posted(20)).toEqual([
      "@alice This issue is yours. Open a draft PR that says `Closes #20` by 2026-12-03 10:00 UTC. Comment `/untake` if you stop.",
    ]);
  });

  it("AC-06: checks the assignee before it assigns", async () => {
    const fake = fakeApi({ issues: [issueP2()] });
    await takeBy(fake, 20);
    const paths = fake.writes().map((call) => `${call.method} ${call.path}`);
    expect(fake.state.calls.some((call) => call.method === "GET" && call.path.endsWith("/issues/20/assignees/alice"))).toBe(true);
    expect(paths.indexOf(`POST /repos/${REPO}/issues/20/assignees`)).toBeGreaterThanOrEqual(0);
  });

  it("AC-06: takes an issue with no size label", async () => {
    const fake = fakeApi({ issues: [{ number: 20, labels: ["P3"] }] });
    await takeBy(fake, 20);
    expect(fake.issue(20).labels).toContain("claimed: human");
  });

  it("AC-06: moves a weekend deadline to Monday 12:00 UTC in the reply", async () => {
    const fake = fakeApi({ issues: [issueP2()] });
    await onComment({ api: fake.api, event: commentEvent(20, "/take"), now: new Date("2026-12-02T08:00:00Z") });
    expect(fake.posted(20)[0]).toContain("by 2026-12-07 12:00 UTC.");
  });

  it("AC-07: replies and changes nothing when the issue has an assignee, a claim label or an open pull request", async () => {
    const cases = [
      { issue: issueP2({ assignees: ["bob"] }) },
      { issue: issueP2({ labels: ["P2", "claimed: human"] }) },
      { issue: issueP2({ labels: ["P2", "claimed: agent"] }) },
      { issue: issueP2(), linked: { 20: [{ number: 99, state: "OPEN" }] } },
    ];
    for (const { issue, linked } of cases) {
      const fake = fakeApi({ issues: [issue], linked });
      await takeBy(fake, 20);
      expect(fake.posted(20)).toEqual(["@alice Someone already works on this issue. Please pick another one."]);
      expect(fake.writes().filter((call) => !call.path.endsWith("/comments"))).toEqual([]);
    }
  });

  it("AC-07: ignores a closed or merged linked pull request", async () => {
    const fake = fakeApi({ issues: [issueP2()], linked: { 20: [{ number: 99, state: "MERGED" }, { number: 98, state: "CLOSED" }] } });
    await takeBy(fake, 20);
    expect(fake.issue(20).assignees).toEqual(["alice"]);
  });

  it("replies when the issue is closed", async () => {
    const fake = fakeApi({ issues: [issueP2({ state: "closed" })] });
    await takeBy(fake, 20);
    expect(fake.posted(20)).toEqual(["@alice This issue is closed. Please pick another one."]);
    expect(fake.issue(20).assignees).toEqual([]);
  });

  it("replies when the person already holds this issue", async () => {
    const fake = fakeApi({ issues: [issueP2({ assignees: ["alice"], labels: ["P2", "claimed: human"] })] });
    await takeBy(fake, 20);
    expect(fake.posted(20)).toEqual(["@alice This issue is already yours."]);
    expect(fake.writes().filter((call) => !call.path.endsWith("/comments"))).toEqual([]);
  });

  it("AC-08: sends a non-maintainer away from P0, P1, no priority and restricted issues", async () => {
    const cases = [["P0"], ["P1", "size: S"], ["bug"], ["P2", "size: L"], ["P3", "needs-security-review"], ["P2", "area: ci"], ["P2", "needs-split"]];
    for (const labels of cases) {
      for (const association of ["NONE", "CONTRIBUTOR", "COLLABORATOR"]) {
        const fake = fakeApi({ issues: [{ number: 20, labels }] });
        await takeBy(fake, 20, { association });
        expect(fake.posted(20), `${labels} ${association}`).toEqual(["@alice This issue needs a maintainer. Please pick another one."]);
        expect(fake.issue(20).assignees).toEqual([]);
      }
    }
  });

  it("AC-08: lets a maintainer take P0 and restricted issues", async () => {
    for (const association of ["OWNER", "MEMBER"]) {
      const fake = fakeApi({ issues: [{ number: 20, labels: ["P0", "size: L", "agent-ready"] }] });
      await takeBy(fake, 20, { association });
      expect(fake.issue(20).assignees).toEqual(["alice"]);
      expect(fake.issue(20).labels).toEqual(["P0", "size: L", "claimed: human"]);
    }
  });

  it("AC-09: refuses a person without a past merge who holds one claim", async () => {
    const fake = fakeApi({
      issues: [issueP2(), { number: 21, labels: ["P2", "claimed: human"], assignees: ["alice"] }, { number: 22, labels: ["P2", "claimed: human"], assignees: ["bob"] }],
    });
    await takeBy(fake, 20);
    expect(fake.posted(20)).toEqual(["@alice You already hold `1` issues. Finish one or comment `/untake` first."]);
    expect(fake.issue(20).assignees).toEqual([]);
    expect(fake.writes().filter((call) => !call.path.endsWith("/comments"))).toEqual([]);
  });

  it("AC-09: counts the claim label in the search and encodes it", async () => {
    const fake = fakeApi({ issues: [issueP2()] });
    await takeBy(fake, 20);
    const search = fake.state.calls.find((call) => call.path.startsWith(`/repos/${REPO}/issues?`));
    expect(search.path).toContain("state=open");
    expect(search.path).toContain("assignee=alice");
    expect(search.path).toContain("labels=claimed%3A%20human");
  });

  it("AC-09: lets a CONTRIBUTOR hold two claims and refuses a third", async () => {
    const held = (number) => ({ number, labels: ["P2", "claimed: human"], assignees: ["alice"] });
    const one = fakeApi({ issues: [issueP2(), held(21)] });
    await takeBy(one, 20, { association: "CONTRIBUTOR" });
    expect(one.issue(20).assignees).toEqual(["alice"]);

    const two = fakeApi({ issues: [issueP2(), held(21), held(22)] });
    await takeBy(two, 20, { association: "CONTRIBUTOR" });
    expect(two.posted(20)).toEqual(["@alice You already hold `2` issues. Finish one or comment `/untake` first."]);
    expect(two.issue(20).assignees).toEqual([]);
  });

  it("AC-09: sets no limit for a MEMBER", async () => {
    const held = (number) => ({ number, labels: ["P2", "claimed: human"], assignees: ["alice"] });
    const fake = fakeApi({ issues: [issueP2(), held(21), held(22), held(23), held(24)] });
    await takeBy(fake, 20, { association: "MEMBER" });
    expect(fake.issue(20).assignees).toEqual(["alice"]);
  });

  it("AC-10: replies and adds no label when GitHub says the person cannot be assigned", async () => {
    const fake = fakeApi({ issues: [issueP2()], cannotAssign: ["alice"] });
    await takeBy(fake, 20);
    expect(fake.posted(20)).toEqual(["@alice We could not assign this issue to you. A maintainer will check it."]);
    expect(labelOps(fake)).toEqual([]);
    expect(fake.issue(20).labels).toContain("human-window");
  });

  it("AC-10: replies and adds no label when GitHub drops the assignee without an error", async () => {
    const fake = fakeApi({ issues: [issueP2()], dropAssign: ["alice"] });
    await takeBy(fake, 20);
    expect(fake.posted(20)).toEqual(["@alice We could not assign this issue to you. A maintainer will check it."]);
    expect(labelOps(fake)).toEqual([]);
  });
});

describe("comment /untake", () => {
  const held = (extra = {}) => ({ number: 30, labels: ["P2", "claimed: human"], assignees: ["alice"], ...extra });
  const untakeBy = (fake, options) => onComment({ api: fake.api, event: commentEvent(30, "/untake", options), now: NOW });

  it("AC-11: removes the assignee and the claim label, applies the window state and replies", async () => {
    const fake = fakeApi({ issues: [held()], events: { 30: [labeledAt("P2", ago(2))] } });
    await untakeBy(fake);
    expect(fake.issue(30).assignees).toEqual([]);
    expect(fake.issue(30).labels).toEqual(["P2", "human-window"]);
    expect(fake.posted(30).at(-1)).toBe("@alice Done. This issue is free again.");
  });

  it("AC-11: gives agent-ready when the window is over", async () => {
    const fake = fakeApi({ issues: [held()], events: { 30: [labeledAt("P2", ago(48))] } });
    await untakeBy(fake);
    expect(fake.issue(30).labels).toEqual(["P2", "agent-ready"]);
    expect(fake.posted(30)).toEqual(["@alice Done. This issue is free again."]);
  });

  it("AC-11: removes only the person who comments", async () => {
    const fake = fakeApi({ issues: [held({ assignees: ["alice", "bob"] })], events: { 30: [] } });
    await untakeBy(fake);
    expect(fake.issue(30).assignees).toEqual(["bob"]);
  });

  it("AC-11: replies to a person who does not hold the issue and changes nothing", async () => {
    const fake = fakeApi({ issues: [held()] });
    await untakeBy(fake, { login: "mallory" });
    expect(fake.posted(30)).toEqual(["@mallory You do not hold this issue."]);
    expect(fake.writes().filter((call) => !call.path.endsWith("/comments"))).toEqual([]);
  });

  it("AC-11: leaves an assignee without a claim label alone", async () => {
    const fake = fakeApi({ issues: [held({ labels: ["P2"] })] });
    await untakeBy(fake);
    expect(fake.posted(30)).toEqual(["@alice You do not hold this issue."]);
    expect(fake.issue(30).assignees).toEqual(["alice"]);
  });
});

describe("comments that do nothing", () => {
  const quiet = async (event) => {
    const fake = fakeApi({ issues: [{ number: 40, labels: ["P2"] }] });
    await onComment({ api: fake.api, event, now: NOW });
    expect(fake.state.calls).toEqual([]);
  };

  it("AC-15: skips a comment on a pull request", () => quiet(commentEvent(40, "/take", { pull: true })));
  it("AC-15: skips a comment from a Bot account", () => quiet(commentEvent(40, "/take", { type: "Bot", login: "helper[bot]" })));
  it("AC-15: skips text that is not exactly one command", async () => {
    for (const body of ["/take please", "/take\n/untake", "/TAKE", "hello", "/untake now"]) await quiet(commentEvent(40, body));
  });
});

describe("sweep", () => {
  const sweepAt = (fake, now = NOW) => sweep({ api: fake.api, now, error: () => {} });

  it("AC-04: replaces human-window with agent-ready when the first P2 or P3 label is 24 hours old", async () => {
    const fake = fakeApi({
      issues: [{ number: 50, labels: ["P2", "human-window"] }],
      events: { 50: [labeledAt("P2", ago(24))] },
    });
    await sweepAt(fake);
    expect(fake.issue(50).labels).toEqual(["P2", "agent-ready"]);
    expect(fake.posted(50)).toEqual([]);
  });

  it("AC-04: keeps human-window inside the window", async () => {
    const fake = fakeApi({
      issues: [{ number: 50, labels: ["P2", "human-window"] }],
      events: { 50: [labeledAt("P2", ago(23))] },
    });
    await sweepAt(fake);
    expect(fake.writes()).toEqual([]);
  });

  it("AC-05: gives an old P3 issue agent-ready without a comment", async () => {
    const fake = fakeApi({ issues: [{ number: 51, labels: ["P3"], created_at: ago(300) }], events: { 51: [labeledAt("P3", ago(200))] } });
    await sweepAt(fake);
    expect(fake.issue(51).labels).toEqual(["P3", "agent-ready"]);
    expect(fake.posted(51)).toEqual([]);
  });

  it("AC-05: gives a new P3 issue human-window and the window comment", async () => {
    const fake = fakeApi({ issues: [{ number: 52, labels: ["P3"] }], events: { 52: [labeledAt("P3", ago(3))] } });
    await sweepAt(fake);
    expect(fake.issue(52).labels).toEqual(["P3", "human-window"]);
    expect(fake.posted(52)).toHaveLength(1);
    expect(fake.posted(52)[0]).toContain("until 2026-12-01 07:00 UTC (14:00 WIB)");
  });

  it("AC-05: gives P0 agent-ready, and skips pull requests, issues with no priority and assigned issues", async () => {
    const fake = fakeApi({
      issues: [
        { number: 53, labels: ["P0"] },
        { number: 54, labels: ["bug"] },
        { number: 55, labels: ["P2"], pull_request: {} },
        { number: 56, labels: ["P2", "human-window"], assignees: ["bob"] },
      ],
    });
    await sweepAt(fake);
    expect(fake.issue(53).labels).toEqual(["P0", "agent-ready"]);
    expect(fake.issue(54).labels).toEqual(["bug"]);
    expect(fake.issue(55).labels).toEqual(["P2"]);
    expect(fake.issue(56).labels).toEqual(["P2"]);
  });

  it("AC-05: pages through more than 100 open issues", async () => {
    const issues = Array.from({ length: 130 }, (_, index) => ({ number: 1000 + index, labels: ["P0"] }));
    const fake = fakeApi({ issues });
    await sweepAt(fake);
    expect(fake.issue(1129).labels).toContain("agent-ready");
    expect(fake.state.calls.filter((call) => call.path.startsWith(`/repos/${REPO}/issues?state=open`))).toHaveLength(2);
  });

  describe("claims", () => {
    const claimed = (extra = {}) => ({ number: 60, labels: ["P2", "claimed: human"], assignees: ["alice"], ...extra });
    const claimEvents = (hours) => ({ 60: [labeledAt("claimed: human", ago(hours))] });

    it("AC-12: posts one reminder with a mention 24 hours before the deadline", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(48) });
      await sweepAt(fake);
      expect(fake.posted(60)).toEqual([
        "@alice Still on it? Open a draft PR by 2026-12-01 10:00 UTC, or comment `/untake`.\n\n<!-- issue-claims:reminder -->",
      ]);
    });

    it("AC-12: posts no second reminder", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(48) });
      await sweepAt(fake);
      await sweepAt(fake);
      expect(fake.posted(60)).toHaveLength(1);
    });

    it("AC-12: posts a new reminder after a new claim, and ignores a reminder from an older claim", async () => {
      const fake = fakeApi({
        issues: [claimed()],
        events: claimEvents(48),
        comments: { 60: [{ body: "old\n\n<!-- issue-claims:reminder -->", created_at: ago(60) }] },
      });
      await sweepAt(fake);
      expect(fake.posted(60)).toHaveLength(1);
    });

    it("AC-12: posts nothing before the reminder time", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(47) });
      await sweepAt(fake);
      expect(fake.writes()).toEqual([]);
    });

    it("AC-12: posts no reminder when an open linked pull request exists", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(60), linked: { 60: [{ number: 9, state: "OPEN" }] } });
      await sweepAt(fake);
      expect(fake.writes()).toEqual([]);
    });

    it("AC-12: uses the last claim event when the issue was claimed twice", async () => {
      const fake = fakeApi({
        issues: [claimed()],
        events: { 60: [labeledAt("claimed: human", ago(200)), labeledAt("claimed: human", ago(2))] },
      });
      await sweepAt(fake);
      expect(fake.writes()).toEqual([]);
    });

    it("AC-12: skips an issue with no claim event", async () => {
      const fake = fakeApi({ issues: [claimed()], events: { 60: [] } });
      await sweepAt(fake);
      expect(fake.writes()).toEqual([]);
    });

    it("AC-13: releases a claim past its deadline", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(72) });
      await sweepAt(fake);
      expect(fake.issue(60).assignees).toEqual([]);
      expect(fake.issue(60).labels).toEqual(["P2", "agent-ready"]);
      expect(fake.posted(60)).toEqual([
        "@alice We released this issue because no draft PR came in. Comment `/take` again if it is still free.",
      ]);
    });

    it("AC-13: keeps a claim past its deadline when an open linked pull request exists", async () => {
      const fake = fakeApi({ issues: [claimed()], events: claimEvents(100), linked: { 60: [{ number: 9, state: "OPEN" }] } });
      await sweepAt(fake);
      expect(fake.issue(60).assignees).toEqual(["alice"]);
      expect(fake.writes()).toEqual([]);
    });

    it("AC-13: uses the weekend rule for the release time", async () => {
      const claimedAt = new Date("2026-12-02T08:00:00Z");
      const fake = fakeApi({ issues: [claimed()], events: { 60: [labeledAt("claimed: human", claimedAt.toISOString())] } });
      await sweepAt(fake, new Date("2026-12-06T08:00:00Z"));
      expect(fake.writes()).toEqual([]);
      await sweepAt(fake, new Date("2026-12-07T12:00:00Z"));
      expect(fake.issue(60).assignees).toEqual([]);
    });

    it("drops a claim label with no assignee left and applies the window state", async () => {
      const fake = fakeApi({ issues: [claimed({ assignees: [] })], events: { 60: [labeledAt("P2", ago(2))] } });
      await sweepAt(fake);
      expect(fake.issue(60).labels).toEqual(["P2", "human-window"]);
    });

    it("AC-02: keeps a claim when the priority rises to P0", async () => {
      const fake = fakeApi({ issues: [claimed({ labels: ["P0", "claimed: human"] })], events: claimEvents(2) });
      await sweepAt(fake);
      expect(fake.writes()).toEqual([]);
    });
  });

  it("AC-17: continues with the next issue when one issue fails, and exits with code 1 at the end", async () => {
    const fake = fakeApi({
      issues: [{ number: 70, labels: ["P0"] }, { number: 71, labels: ["P0"] }],
      failOn: (method, path) => (method === "POST" && path.includes("/issues/70/labels") ? 500 : undefined),
    });
    const errors = [];
    const failed = await sweep({ api: fake.api, now: NOW, error: (line) => errors.push(line) });
    expect(failed).toBe(1);
    expect(errors).toEqual([`#70: failed with HTTP 500`]);
    expect(fake.issue(71).labels).toContain("agent-ready");
  });
});

describe("reconcile", () => {
  it("sends no call for a state that is already right", async () => {
    const fake = fakeApi({ issues: [{ number: 80, labels: ["P0", "agent-ready"] }] });
    await reconcile({ api: fake.api, number: 80, now: NOW });
    expect(fake.writes()).toEqual([]);
  });
});

describe("main", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  function setup(name, event) {
    const dir = mkdtempSync(join(tmpdir(), "issue-claims-"));
    dirs.push(dir);
    const file = join(dir, "event.json");
    writeFileSync(file, JSON.stringify(event));
    return { GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: file, GITHUB_REPOSITORY: REPO, GH_TOKEN: "ghs_secret_token_value" };
  }

  it("AC-17: exits with code 1 and logs the method, path and status, and never the token", async () => {
    const env = setup("issues", { issue: { number: 90 }, label: { name: "P0" } });
    const fetch = async () => ({ ok: false, status: 500 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await main(env, { now: () => NOW, fetch });
    expect(process.exitCode).toBe(1);
    expect(errors).toHaveBeenCalledWith(`GitHub API GET /repos/${REPO}/issues/90 failed with HTTP 500`);
    const output = JSON.stringify([...errors.mock.calls, ...logs.mock.calls]);
    expect(output).not.toContain("ghs_secret_token_value");
  });

  it("AC-17: exits with code 1 when a sweep issue fails", async () => {
    const env = setup("schedule", {});
    const fetch = async (url, init) => {
      if (init.method === "GET" && url.includes("/issues?state=open")) {
        return { ok: true, status: 200, json: async () => [{ number: 91, labels: [{ name: "P0" }], assignees: [] }] };
      }
      return { ok: false, status: 500 };
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await main(env, { now: () => NOW, fetch });
    expect(process.exitCode).toBe(1);
    expect(errors).toHaveBeenCalledWith(`#91: GitHub API GET /repos/${REPO}/issues/91 failed with HTTP 500`);
  });

  it("AC-17: exits with code 1 for a missing variable and an unsupported event", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await main({ GITHUB_EVENT_NAME: "push" });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await main(setup("push", {}), { now: () => NOW, fetch: async () => ({ ok: true, status: 200, json: async () => [] }) });
    expect(process.exitCode).toBe(1);
    expect(errors).toHaveBeenLastCalledWith("Unsupported event: push");
  });

  it("runs the comment handler for an issue_comment event", async () => {
    const env = setup("issue_comment", commentEvent(92, "/take please"));
    const fetch = vi.fn();
    await main(env, { now: () => NOW, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("createApi", () => {
  it("sends the token and the user agent, and answers null on 204", async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return { ok: true, status: 204 };
    };
    const api = createApi({ token: "t0ken", repository: REPO, fetch });
    expect(await api.rest("DELETE", "/x", { a: 1 })).toBeNull();
    expect(seen[0].url).toBe("https://api.github.com/x");
    expect(seen[0].init.headers["User-Agent"]).toBe("seira-issue-claims");
    expect(seen[0].init.headers.Authorization).toBe("Bearer t0ken");
    expect(seen[0].init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("AC-17: names the method, path and status in an error, without the token", async () => {
    const api = createApi({ token: "t0ken", repository: REPO, fetch: async () => ({ ok: false, status: 502 }) });
    await expect(api.rest("POST", "/y", {})).rejects.toThrow("GitHub API POST /y failed with HTTP 502");
    await api.rest("POST", "/y", {}).catch((error) => {
      expect(error.status).toBe(502);
      expect(error.message).not.toContain("t0ken");
    });
  });
});
