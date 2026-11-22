import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compareVersions, createApi, nextPatch, onPush, onRelease, versionOfTitle } from "./milestones.mjs";

const REPO = "seira-bot/seira";
const ZERO = "0".repeat(40);

function httpError(status, message = "failed") {
  const error = new Error(message);
  error.status = status;
  return error;
}

function fakeApi({ versions = {}, milestones = [], pulls = {}, closing = {}, createFails = false, latest, pullDetails = {} } = {}) {
  const state = { milestones: milestones.map((each) => ({ state: "open", ...each })), calls: [], nextNumber: 100 };
  const writes = () => state.calls.filter((call) => call.method !== "GET" && call.path !== "/graphql");
  const api = {
    async rest(method, path, body) {
      state.calls.push({ method, path, body });
      let match;
      if ((match = /^\/repos\/[^/]+\/[^/]+\/contents\/package\.json\?ref=(\w+)$/.exec(path))) {
        const version = versions[match[1]];
        if (version === undefined) throw httpError(404);
        return { content: Buffer.from(JSON.stringify({ version })).toString("base64") };
      }
      if (path.endsWith("/releases/latest")) {
        if (latest === null) throw httpError(404);
        return { tag_name: latest };
      }
      if ((match = /\/pulls\/(\d+)$/.exec(path))) {
        if (pullDetails[match[1]] === undefined) throw httpError(404);
        return pullDetails[match[1]];
      }
      if ((match = /\/commits\/(\w+)\/pulls$/.exec(path))) return pulls[match[1]] ?? [];
      if ((match = /\/milestones\?state=all&per_page=100&page=(\d+)$/.exec(path))) {
        const page = Number(match[1]);
        return state.milestones.slice((page - 1) * 100, page * 100);
      }
      if (method === "POST" && path.endsWith("/milestones")) {
        if (createFails) {
          state.milestones.push({ number: 7, state: "open", title: body.title });
          throw httpError(422);
        }
        const created = { number: state.nextNumber++, state: "open", ...body };
        state.milestones.push(created);
        return created;
      }
      if (method === "PATCH" && (match = /\/milestones\/(\d+)$/.exec(path))) {
        const found = state.milestones.find((each) => each.number === Number(match[1]));
        Object.assign(found, body);
        return found;
      }
      if (method === "PATCH" && /\/issues\/\d+$/.test(path)) return {};
      throw new Error(`unexpected ${method} ${path}`);
    },
    async graphql(query, variables) {
      state.calls.push({ method: "POST", path: "/graphql", variables });
      return { repository: { pullRequest: { closingIssuesReferences: { nodes: closing[variables.number] ?? [] } } } };
    },
  };
  return { api, state, writes, setLatest: (tag) => { if (latest === undefined) latest = tag; } };
}

const pull = (number, extra = {}) => ({ number, merged_at: "2026-11-23T00:00:00Z", base: { ref: "main" }, milestone: null, ...extra });
const pushEvent = (extra = {}) => ({ before: "bbb", after: "aaa", commits: [{ id: "aaa" }], ...extra });
const runPush = (fake, event = pushEvent()) => {
  const lines = [];
  return onPush({ api: fake.api, repository: REPO, event, log: (line) => lines.push(line) }).then(() => lines);
};
const releaseEvent = (tag, extra = {}) => ({ release: { tag_name: tag, prerelease: false, draft: false, ...extra } });
const runRelease = (fake, event, latest = event.release.tag_name) => {
  fake.setLatest(latest);
  return onRelease({ api: fake.api, repository: REPO, event, log: () => {} });
};
const issuePatches = (fake) => fake.writes().filter((call) => /\/issues\/\d+$/.test(call.path));

describe("version helpers", () => {
  it("nextPatch adds one to the patch number", () => {
    expect(nextPatch("0.1.187")).toBe("0.1.188");
    expect(nextPatch("1.2.9")).toBe("1.2.10");
  });

  it("nextPatch throws on a text that is not major.minor.patch", () => {
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta", "", "a.b.c"]) expect(() => nextPatch(bad)).toThrow();
  });

  it("versionOfTitle reads a v-prefixed title only", () => {
    expect(versionOfTitle("v0.1.9")).toEqual([0, 1, 9]);
    expect(versionOfTitle("0.1.9")).toBeNull();
    expect(versionOfTitle("v0.1.9-rc1")).toBeNull();
    expect(versionOfTitle("Next")).toBeNull();
  });

  it("compareVersions compares numbers, not text", () => {
    expect(compareVersions([0, 1, 10], [0, 1, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 2, 0], [0, 10, 0])).toBeLessThan(0);
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
  });
});

describe("push to main", () => {
  it("AC-01: sets the next patch milestone on a merged pull request when the version does not change", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10)] },
    });
    await runPush(fake);
    expect(issuePatches(fake)).toEqual([{ method: "PATCH", path: `/repos/${REPO}/issues/10`, body: { milestone: 5 } }]);
  });

  it("AC-02: sets the new version milestone on the pull request that changes the version", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.189", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }, { number: 6, title: "v0.1.190" }],
      pulls: { aaa: [pull(11)] },
    });
    await runPush(fake);
    expect(issuePatches(fake).map((call) => call.body)).toEqual([{ milestone: 5 }]);
  });

  it("AC-03: sets the same milestone on each issue of this repository that the pull request closes", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10)] },
      closing: { 10: [{ number: 20, milestone: null, repository: { nameWithOwner: REPO } }, { number: 21, milestone: null, repository: { nameWithOwner: REPO } }] },
    });
    await runPush(fake);
    expect(issuePatches(fake).map((call) => [call.path, call.body])).toEqual([
      [`/repos/${REPO}/issues/10`, { milestone: 5 }],
      [`/repos/${REPO}/issues/20`, { milestone: 5 }],
      [`/repos/${REPO}/issues/21`, { milestone: 5 }],
    ]);
  });

  it("AC-04: creates the target milestone when it does not exist", async () => {
    const fake = fakeApi({ versions: { aaa: "0.1.188", bbb: "0.1.188" }, pulls: { aaa: [pull(10)] } });
    await runPush(fake);
    const create = fake.writes().find((call) => call.method === "POST");
    expect(create.body).toEqual({ title: "v0.1.189", description: "Changes that ship in Seira v0.1.189." });
    expect(issuePatches(fake)[0].body).toEqual({ milestone: 100 });
  });

  it("AC-05: keeps a milestone that a pull request or an issue already has", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10, { milestone: { number: 9 } })] },
      closing: { 10: [{ number: 20, milestone: { number: 9 }, repository: { nameWithOwner: REPO } }] },
    });
    await runPush(fake);
    expect(issuePatches(fake)).toEqual([]);
  });

  it("skips an issue of another repository", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10, { milestone: { number: 5 } })] },
      closing: { 10: [{ number: 20, milestone: null, repository: { nameWithOwner: "other/repo" } }] },
    });
    await runPush(fake);
    expect(issuePatches(fake)).toEqual([]);
  });

  it("reads the closing issues of a pull request that already has a milestone", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10, { milestone: { number: 5 } })] },
      closing: { 10: [{ number: 20, milestone: null, repository: { nameWithOwner: REPO } }] },
    });
    await runPush(fake);
    expect(issuePatches(fake).map((call) => call.path)).toEqual([`/repos/${REPO}/issues/20`]);
  });

  it("writes nothing and creates no milestone when no merged pull request is in the push", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      pulls: { aaa: [pull(10, { merged_at: null }), pull(11, { base: { ref: "dev" } })] },
    });
    const lines = await runPush(fake);
    expect(fake.writes()).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("uses the version after the push for both sides when before is all zeros", async () => {
    const fake = fakeApi({ versions: { aaa: "0.1.188" }, milestones: [{ number: 5, title: "v0.1.189" }], pulls: { aaa: [pull(10)] } });
    await runPush(fake, pushEvent({ before: ZERO }));
    expect(fake.state.calls.some((call) => call.path.includes(`ref=${ZERO}`))).toBe(false);
    expect(issuePatches(fake)[0].body).toEqual({ milestone: 5 });
  });

  it("uses the version after the push for both sides when the read at before gives 404", async () => {
    const fake = fakeApi({ versions: { aaa: "0.1.188" }, milestones: [{ number: 5, title: "v0.1.189" }], pulls: { aaa: [pull(10)] } });
    await runPush(fake);
    expect(issuePatches(fake)[0].body).toEqual({ milestone: 5 });
  });

  it("reads the head commit when the push lists no commit, and counts a pull request once", async () => {
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10)], ccc: [pull(10)] },
    });
    await runPush(fake, pushEvent({ commits: [] }));
    expect(issuePatches(fake)).toHaveLength(1);

    const twice = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      pulls: { aaa: [pull(10)], ccc: [pull(10)] },
    });
    await runPush(twice, pushEvent({ commits: [{ id: "aaa" }, { id: "ccc" }] }));
    expect(issuePatches(twice)).toHaveLength(1);
  });

  describe("when the commit has no pull request in the list", () => {
    const setup = (extra = {}) => ({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [{ number: 5, title: "v0.1.189" }],
      ...extra,
    });
    const event = (message) => pushEvent({ commits: [{ id: "aaa", message }] });
    const gets = (fake) => fake.state.calls.filter((call) => /\/pulls\/\d+$/.test(call.path));

    it("finds the pull request by the number in the message and sets the milestone", async () => {
      const fake = fakeApi(setup({ pullDetails: { 42: pull(42, { merge_commit_sha: "aaa" }) } }));
      await runPush(fake, event("Fix a thing (#42)\n\nBody"));
      expect(issuePatches(fake).map((call) => [call.path, call.body])).toEqual([[`/repos/${REPO}/issues/42`, { milestone: 5 }]]);
    });

    it("uses the head commit message when the push lists no commit", async () => {
      const fake = fakeApi(setup({ pullDetails: { 42: pull(42, { merge_commit_sha: "aaa" }) } }));
      await runPush(fake, pushEvent({ commits: [], head_commit: { message: "Fix a thing (#42)" } }));
      expect(issuePatches(fake)).toHaveLength(1);
    });

    it("ignores a number whose merge commit is another commit", async () => {
      const fake = fakeApi(setup({ pullDetails: { 42: pull(42, { merge_commit_sha: "zzz" }) } }));
      await runPush(fake, event("Fix a thing (#42)"));
      expect(fake.writes()).toEqual([]);
    });

    it("reads no pull request when the message has no number at the end of the first line", async () => {
      const fake = fakeApi(setup());
      await runPush(fake, event("Fix a thing\n\nSee (#42)"));
      expect(gets(fake)).toEqual([]);
      expect(fake.writes()).toEqual([]);
    });

    it("writes nothing when the pull request is not found", async () => {
      const fake = fakeApi(setup());
      await runPush(fake, event("Fix a thing (#42)"));
      expect(gets(fake)).toHaveLength(1);
      expect(fake.writes()).toEqual([]);
    });
  });

  it("finds a milestone on the second page of the list", async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({ number: index + 1, title: `old ${index}` }));
    const fake = fakeApi({
      versions: { aaa: "0.1.188", bbb: "0.1.188" },
      milestones: [...many, { number: 500, title: "v0.1.189" }],
      pulls: { aaa: [pull(10)] },
    });
    await runPush(fake);
    expect(fake.state.calls.filter((call) => call.path.includes("/milestones?")).map((call) => call.path.slice(-6))).toEqual(["page=1", "page=2"]);
    expect(fake.writes().some((call) => call.method === "POST")).toBe(false);
    expect(issuePatches(fake)[0].body).toEqual({ milestone: 500 });
  });

  it("uses the milestone that another run created at the same time after a 422", async () => {
    const fake = fakeApi({ versions: { aaa: "0.1.188", bbb: "0.1.188" }, pulls: { aaa: [pull(10)] }, createFails: true });
    await runPush(fake);
    expect(issuePatches(fake)[0].body).toEqual({ milestone: 7 });
  });
});

describe("published release", () => {
  it("AC-06: closes the milestone that has the tag as title", async () => {
    const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189" }, { number: 6, title: "v0.1.190" }] });
    await runRelease(fake, releaseEvent("v0.1.189"));
    expect(fake.state.milestones.find((each) => each.number === 5).state).toBe("closed");
    expect(fake.state.milestones.find((each) => each.number === 6).state).toBe("open");
  });

  it("AC-07: creates the next patch milestone when it does not exist", async () => {
    const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189" }] });
    await runRelease(fake, releaseEvent("v0.1.189"));
    const create = fake.writes().find((call) => call.method === "POST");
    expect(create.body).toEqual({ title: "v0.1.190", description: "Changes that ship in Seira v0.1.190." });
  });

  it("does not create the next milestone when it exists in any state", async () => {
    const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189" }, { number: 6, title: "v0.1.190", state: "closed" }] });
    await runRelease(fake, releaseEvent("v0.1.189"));
    expect(fake.writes().some((call) => call.method === "POST")).toBe(false);
  });

  it("AC-08: renames the highest open lower milestone to the tag, then closes it", async () => {
    const fake = fakeApi({
      milestones: [
        { number: 1, title: "v0.1.9" },
        { number: 2, title: "v0.1.10" },
        { number: 3, title: "v0.1.8", state: "closed" },
        { number: 4, title: "v0.2.5" },
        { number: 5, title: "Backlog" },
      ],
    });
    await runRelease(fake, releaseEvent("v0.1.11"));
    const renamed = fake.state.milestones.find((each) => each.number === 2);
    expect(renamed).toMatchObject({ title: "v0.1.11", state: "closed" });
    expect(fake.state.milestones.find((each) => each.number === 1).title).toBe("v0.1.9");
    expect(fake.state.milestones.find((each) => each.title === "v0.1.12")).toBeDefined();
  });

  it("AC-09: changes nothing for a prerelease, a draft or a tag that is not major.minor.patch", async () => {
    for (const event of [
      releaseEvent("v0.1.189", { prerelease: true }),
      releaseEvent("v0.1.189", { draft: true }),
      releaseEvent("v0.1.189-rc1"),
      releaseEvent("release-1"),
    ]) {
      const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189" }] });
      await runRelease(fake, event);
      expect(fake.state.calls).toEqual([]);
    }
  });

  it("closes the milestone of the tag but renames nothing and creates no next milestone when the release is not the latest", async () => {
    const fake = fakeApi({ milestones: [{ number: 1, title: "v0.1.150" }, { number: 5, title: "v0.1.151" }], latest: "v0.1.189" });
    await runRelease(fake, releaseEvent("v0.1.151"));
    expect(fake.state.milestones.find((each) => each.number === 5).state).toBe("closed");
    expect(fake.writes().map((call) => call.method)).toEqual(["PATCH"]);

    const old = fakeApi({ milestones: [{ number: 1, title: "v0.1.150" }], latest: "v0.1.189" });
    await runRelease(old, releaseEvent("v0.1.151"));
    expect(old.writes()).toEqual([]);
    expect(old.state.milestones[0].title).toBe("v0.1.150");
  });

  it("treats a 404 for the latest release as not the latest", async () => {
    const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189" }], latest: null });
    await runRelease(fake, releaseEvent("v0.1.189"));
    expect(fake.state.milestones[0].state).toBe("closed");
    expect(fake.writes().map((call) => call.method)).toEqual(["PATCH"]);
  });

  it("leaves a closed milestone of the tag as it is", async () => {
    const fake = fakeApi({ milestones: [{ number: 5, title: "v0.1.189", state: "closed" }, { number: 6, title: "v0.1.190" }] });
    await runRelease(fake, releaseEvent("v0.1.189"));
    expect(fake.writes()).toEqual([]);
  });

  it("creates the next milestone and renames nothing when no lower open milestone exists", async () => {
    const fake = fakeApi({ milestones: [{ number: 9, title: "v0.1.300" }] });
    await runRelease(fake, releaseEvent("v0.1.189"));
    expect(fake.writes().map((call) => call.method)).toEqual(["POST"]);
  });
});

describe("createApi", () => {
  const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  it("AC-10: an error message holds the method, the path and the status and never the token", async () => {
    const token = "ghs_SECRET_TOKEN_VALUE";
    const api = createApi({ token, repository: REPO, fetch: async () => response(403, { message: `bad ${token}` }) });
    const error = await api.rest("PATCH", `/repos/${REPO}/issues/10`, { milestone: 1 }).catch((caught) => caught);
    expect(error.message).toBe(`GitHub API PATCH /repos/${REPO}/issues/10 failed with HTTP 403`);
    expect(error.message).not.toContain(token);
    expect(error.status).toBe(403);
  });

  it("AC-10: a GraphQL answer with errors throws without the token", async () => {
    const token = "ghs_SECRET_TOKEN_VALUE";
    const api = createApi({ token, repository: REPO, fetch: async () => response(200, { errors: [{ message: token }] }) });
    const error = await api.graphql("query { viewer { login } }", {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(token);
  });

  it("sends the headers and the JSON body to the GitHub API", async () => {
    const seen = [];
    const api = createApi({ token: "tok", repository: REPO, fetch: async (url, init) => (seen.push({ url, init }), response(200, { ok: true })) });
    expect(await api.rest("POST", "/repos/a/b/milestones", { title: "v1.0.0" })).toEqual({ ok: true });
    expect(seen[0].url).toBe("https://api.github.com/repos/a/b/milestones");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.body).toBe(JSON.stringify({ title: "v1.0.0" }));
    expect(seen[0].init.headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "seira-milestones",
    });
  });

  it("returns the data of a GraphQL answer", async () => {
    const api = createApi({ token: "tok", repository: REPO, fetch: async () => response(200, { data: { value: 1 } }) });
    expect(await api.graphql("query { value }", {})).toEqual({ value: 1 });
  });
});

describe("scripts/milestones.mjs", () => {
  it("imports only node: modules", () => {
    const text = readFileSync(new URL("./milestones.mjs", import.meta.url), "utf8");
    const specifiers = [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
    expect(text).not.toMatch(/\bimport\(|\brequire\(/);
  });
});
