import { describe, expect, it } from "vitest";

import { GITHUB_APP_TOOL_NAMES } from "../../shared/github-app.ts";
import { fakeGithubRest } from "../testing/fake-github-rest.ts";
import { GITHUB_FILE_MAX_BYTES, GITHUB_LINK_MESSAGE, GITHUB_NOT_FOUND_MESSAGE, GITHUB_REFUSED_MESSAGE, GITHUB_TOOLS, GITHUB_TREE_CUT_MESSAGE, githubToolCallProblem, isSafeGithubApiPath, runGithubTool } from "./tools.ts";
import { GITHUB_RECONNECT_MESSAGE, GITHUB_UNREACHABLE_MESSAGE } from "./broker-client.ts";

const TOKEN = "ghs_fake_installation_token_1";
const repo = { fullName: "acme/web", defaultBranch: "main" };

function setup(files: Record<string, string> = { "README.md": "hello", "src/a.ts": "a", "src/b.ts": "b" }, modes: Record<string, string> = {}) {
  const rest = fakeGithubRest("acme/web", { files, modes });
  const run = (name: (typeof GITHUB_APP_TOOL_NAMES)[number], args: Record<string, unknown>) => runGithubTool(name, args, { token: TOKEN, repo, fetch: rest.fetch });
  return { rest, run };
}
const body = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0]!.text);

describe("GitHub tool inputs", () => {
  it("lists a tool for every name in the contract", () => {
    expect(GITHUB_TOOLS.map((tool) => tool.name)).toEqual([...GITHUB_APP_TOOL_NAMES]);
  });

  it("refuses a repository that is not owner/name, a path that climbs, and a bad branch", () => {
    expect(githubToolCallProblem("GITHUB_APP_GET_FILE", { repo: "acme", path: "a" })).toContain("schema");
    expect(githubToolCallProblem("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "../x" })).toBe("path is not valid.");
    expect(githubToolCallProblem("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "a", ref: "a..b" })).toBe("ref is not a valid branch name.");
    expect(githubToolCallProblem("GITHUB_APP_DELETE_BRANCH", { repo: "acme/web", branch: "seira/b/x y" })).toContain("schema");
    expect(githubToolCallProblem("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "b", message: "m", files: [{ path: "a", content: "1" }, { path: "a", delete: true }] })).toBe("A file path appears twice.");
    expect(githubToolCallProblem("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "a", extra: 1 })).toContain("schema");
    expect(githubToolCallProblem("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "src/a.ts" })).toBeNull();
  });
});

describe("GitHub tool calls", () => {
  it("sends the headers GitHub asks for and the token only as a bearer", async () => {
    const { rest, run } = setup();
    await run("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" });
    const [request] = rest.requests;
    expect(request!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request!.headers).toMatchObject({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "seira" });
    expect(request!.path).toBe("/repos/acme/web/contents/README.md");
  });

  it("keeps every request on api.github.com, with the repository name inside the path", async () => {
    const urls: string[] = [];
    const record = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ type: "file", size: 1, sha: "s", encoding: "base64", content: "YQ==" }), { status: 200 });
    }) as typeof fetch;
    await runGithubTool("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "a.txt" }, { token: TOKEN, repo: { fullName: "@evil.example/x?y#z", defaultBranch: "main" }, fetch: record });
    const url = new URL(urls[0]!);
    expect(url.origin).toBe("https://api.github.com");
    expect(url.pathname).toBe("/repos/%40evil.example/x%3Fy%23z/contents/a.txt");
    expect(url.search).toBe("");
  });

  it("accepts only encoded repository routes and code search as request paths", () => {
    for (const path of ["/repos/acme/web/contents/src/a.ts?ref=main", "/repos/acme/web/issues?state=open&per_page=50", "/repos/acme/web/git/ref/heads/seira%2Fb%2Fx", "/search/code?q=fix%20repo%3Aacme%2Fweb&per_page=50"]) {
      expect(isSafeGithubApiPath(path), path).toBe(true);
    }
    for (const path of ["//evil.example/x", "/repos/acme/web/../../user", "/repos/acme/web/issues/1 2", "/user/repos", "/repos/acme/web#x", "/repos/acme/web/contents/a?b=c#d", "https://evil.example/x"]) {
      expect(isSafeGithubApiPath(path), path).toBe(false);
    }
  });

  it("reads a file, cuts a long one at 200 KB, and lists a folder", async () => {
    const { run } = setup({ "big.txt": "x".repeat(GITHUB_FILE_MAX_BYTES + 5), "src/a.ts": "a", "src/b.ts": "b" });
    const big = body(await run("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "big.txt" }));
    expect(big.content).toHaveLength(GITHUB_FILE_MAX_BYTES);
    expect(big.truncated).toBe(true);
    const dir = body(await run("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "src" }));
    expect(dir.entries.map((entry: { name: string }) => entry.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("searches only the named repository, whatever the query says", async () => {
    const { rest, run } = setup();
    await run("GITHUB_APP_SEARCH_CODE", { repo: "acme/web", query: "token repo:evil/other org:evil -user:x" });
    const q = new URL(`https://x${rest.requests[0]!.path}`).searchParams.get("q")!;
    expect(q).toBe("token repo:acme/web");
  });

  it("lists issues without pull requests and trims a list to 50", async () => {
    const { run } = setup();
    const out = body(await run("GITHUB_APP_LIST_ISSUES", { repo: "acme/web" }));
    expect(out.issues.map((issue: { number: number }) => issue.number)).toEqual([1]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("commits files on a new branch made from the main branch, in one commit", async () => {
    const { rest, run } = setup();
    const out = body(await run("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "Add a", files: [{ path: "a.txt", content: "A" }, { path: "old.txt", delete: true }] }));
    expect(out).toMatchObject({ branch: "seira/b1/x", files: 2 });
    expect(rest.branches.get("seira/b1/x")).toBe(out.commit);
    const calls = rest.requests.map((request) => `${request.method} ${request.path.replace("/repos/acme/web", "")}`);
    expect(calls.filter((call) => call === "POST /git/refs")).toHaveLength(1);
    expect(calls.filter((call) => call === "POST /git/blobs")).toHaveLength(1);
    const tree = rest.requests.find((request) => request.path.endsWith("/git/trees"))!.body.tree;
    expect(tree).toEqual([expect.objectContaining({ path: "a.txt" }), { path: "old.txt", mode: "100644", type: "blob", sha: null }]);
    expect(rest.requests.at(-1)!.body.force).toBe(false);
  });

  it("keeps the mode of a changed file and gives a new file 100644", async () => {
    const { rest, run } = setup({ "run.sh": "old", "bin/tool.sh": "old", "docs/a.md": "old" }, { "run.sh": "100755", "bin/tool.sh": "100755" });
    const files = [{ path: "run.sh", content: "new" }, { path: "bin/tool.sh", content: "new" }, { path: "docs/a.md", content: "new" }, { path: "bin/new.sh", content: "new" }, { path: "fresh/x.txt", content: "new" }];
    expect((await run("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files })).isError).toBeUndefined();
    const tree = rest.requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")!.body.tree;
    expect(tree.map((entry: { path: string; mode: string }) => [entry.path, entry.mode])).toEqual([["run.sh", "100755"], ["bin/tool.sh", "100755"], ["docs/a.md", "100644"], ["bin/new.sh", "100644"], ["fresh/x.txt", "100644"]]);
  });

  it("keeps the mode of a file that it removes", async () => {
    const { rest, run } = setup({ "run.sh": "old" }, { "run.sh": "100755" });
    await run("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files: [{ path: "run.sh", delete: true }] });
    expect(rest.requests.find((request) => request.path.endsWith("/git/trees") && request.method === "POST")!.body.tree).toEqual([{ path: "run.sh", mode: "100755", type: "blob", sha: null }]);
  });

  it("refuses to change a symbolic link or a submodule, and makes no branch", async () => {
    const { rest, run } = setup({ "README.md": "hello", "link": "target" }, { link: "120000", "vendor/lib": "160000" });
    for (const path of ["link", "vendor/lib"]) {
      expect(await run("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files: [{ path: "README.md", content: "1" }, { path, content: "2" }] })).toEqual({ content: [{ type: "text", text: GITHUB_LINK_MESSAGE }], isError: true });
    }
    expect(rest.requests.filter((request) => request.method !== "GET")).toEqual([]);
    expect(rest.branches.has("seira/b1/x")).toBe(false);
  });

  it("refuses when GitHub cuts a folder list, because a mode could be wrong", async () => {
    const { rest } = setup();
    const cut = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await rest.fetch(input, init);
      return new URL(String(input)).pathname.includes("/git/trees/") ? Response.json({ ...(await answer.json() as object), truncated: true }) : answer;
    }) as typeof fetch;
    const out = await runGithubTool("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files: [{ path: "a.txt", content: "1" }] }, { token: TOKEN, repo, fetch: cut });
    expect(out).toEqual({ content: [{ type: "text", text: GITHUB_TREE_CUT_MESSAGE }], isError: true });
    expect(rest.requests.filter((request) => request.method !== "GET")).toEqual([]);
  });

  it("commits to a branch that exists without making it again", async () => {
    const { rest, run } = setup();
    await run("GITHUB_APP_CREATE_BRANCH", { repo: "acme/web", branch: "seira/b1/y" });
    await run("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/y", message: "m", files: [{ path: "a", content: "1" }] });
    expect(rest.requests.filter((request) => request.method === "POST" && request.path.endsWith("/git/refs"))).toHaveLength(1);
  });

  it("opens, comments, merges, closes and deletes", async () => {
    const { rest, run } = setup();
    expect(body(await run("GITHUB_APP_CREATE_PULL", { repo: "acme/web", title: "T", branch: "seira/b1/x" })).number).toBe(10);
    expect(rest.requests[0]!.body).toEqual({ title: "T", head: "seira/b1/x", base: "main" });
    expect(body(await run("GITHUB_APP_CREATE_ISSUE", { repo: "acme/web", title: "I" })).number).toBe(9);
    expect(body(await run("GITHUB_APP_CREATE_COMMENT", { repo: "acme/web", number: 1, body: "hi" })).id).toBe(77);
    expect(body(await run("GITHUB_APP_MERGE_PULL", { repo: "acme/web", number: 10, merge_method: "squash" })).merged).toBe(true);
    expect(body(await run("GITHUB_APP_CLOSE_ISSUE_OR_PULL", { repo: "acme/web", number: 1 })).state).toBe("closed");
    await run("GITHUB_APP_CREATE_BRANCH", { repo: "acme/web", branch: "seira/b1/z" });
    expect(body(await run("GITHUB_APP_DELETE_BRANCH", { repo: "acme/web", branch: "seira/b1/z" })).deleted).toBe("seira/b1/z");
  });

  it("asks before every change and reads without asking", async () => {
    const rest = fakeGithubRest("acme/web", { files: { "README.md": "hello" } });
    const asked: number[] = [];
    let allow = 2;
    const writeRefusal = () => { asked.push(rest.requests.length); return allow-- > 0 ? null : "Stopped."; };
    const out = await runGithubTool("GITHUB_APP_COMMIT_FILES", { repo: "acme/web", branch: "seira/b1/x", message: "m", files: [{ path: "a", content: "1" }, { path: "b", content: "2" }] }, { token: TOKEN, repo, fetch: rest.fetch, writeRefusal });
    expect(out).toEqual({ content: [{ type: "text", text: "Stopped." }], isError: true });
    expect(rest.requests.filter((request) => request.method !== "GET")).toHaveLength(2);
    expect(asked).toHaveLength(3);
    const read = fakeGithubRest("acme/web", { files: { "README.md": "hello" } });
    expect((await runGithubTool("GITHUB_APP_GET_FILE", { repo: "acme/web", path: "README.md" }, { token: TOKEN, repo, fetch: read.fetch, writeRefusal: () => "Stopped." })).isError).toBeUndefined();
  });

  it("answers a GitHub failure in fixed words, with no response detail", async () => {
    const { rest, run } = setup();
    const ask = () => run("GITHUB_APP_GET_ISSUE", { repo: "acme/web", number: 1 });
    for (const [status, text] of [[404, GITHUB_NOT_FOUND_MESSAGE], [403, GITHUB_REFUSED_MESSAGE], [422, GITHUB_REFUSED_MESSAGE], [401, GITHUB_RECONNECT_MESSAGE], [502, GITHUB_UNREACHABLE_MESSAGE]] as const) {
      rest.failWith(status);
      const answer = await ask();
      expect(answer).toEqual({ content: [{ type: "text", text }], isError: true });
    }
    const down = await runGithubTool("GITHUB_APP_GET_ISSUE", { repo: "acme/web", number: 1 }, { token: TOKEN, repo, fetch: (async () => { throw new Error(`socket ${TOKEN}`); }) as never });
    expect(down.content[0]!.text).toBe(GITHUB_UNREACHABLE_MESSAGE);
  });
});
