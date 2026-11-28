// GitHub's REST API for one repository, served from memory for the native GitHub tools: contents, issues, pulls, search
// and the Git Data routes a commit uses. It keeps branches and answers the status a test asks for.
import { createHash } from "node:crypto";

export interface FakeRestRequest {
  method: string;
  path: string;
  authorization: string | null;
  headers: Record<string, string>;
  body: any;
}

export interface FakeGithubRest {
  fetch: typeof fetch;
  requests: FakeRestRequest[];
  branches: Map<string, string>;
  /** Every request now answers this status with an empty object. */
  failWith(status: number | null): void;
}

const sha = (text: string) => createHash("sha1").update(text).digest("hex");

/**
 * `modes` gives a Git mode to a path of the start commit. A file with no mode has 100644. A path in `modes` that is not in
 * `files` is an entry with no text: 120000 is a symbolic link and 160000 is a submodule.
 */
export function fakeGithubRest(repo: string, options: { files?: Record<string, string>; modes?: Record<string, string>; defaultBranch?: string } = {}): FakeGithubRest {
  const defaultBranch = options.defaultBranch ?? "main";
  const files = options.files ?? {};
  const modes = options.modes ?? {};
  const paths = [...new Set([...Object.keys(files), ...Object.keys(modes)])];
  const rootTree = sha("tree0");
  const folderSha = (folder: string) => (folder === "" ? rootTree : sha(`folder:${folder}`));
  const folders = ["", ...new Set(paths.flatMap((path) => path.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))))];
  const folderEntries = (folder: string) => {
    const names = new Set(paths.filter((path) => folder === "" || path.startsWith(`${folder}/`)).map((path) => path.slice(folder === "" ? 0 : folder.length + 1).split("/")[0]!));
    return [...names].map((name) => {
      const full = folder === "" ? name : `${folder}/${name}`;
      if (folders.includes(full)) return { path: name, mode: "040000", type: "tree", sha: folderSha(full) };
      const mode = modes[full] ?? "100644";
      return { path: name, mode, type: mode === "160000" ? "commit" : "blob", sha: sha(`entry:${full}`) };
    });
  };
  const branches = new Map<string, string>([[defaultBranch, sha("start")]]);
  const requests: FakeRestRequest[] = [];
  let failing: number | null = null;
  let counter = 0;
  const prefix = `/repos/${repo}`;

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com") throw new TypeError(`fake GitHub: no route for ${url}`);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = decodeURIComponent(url.pathname);
    requests.push({ method, path: url.pathname + url.search, authorization: headers.authorization ?? null, headers, body });
    if (failing !== null) return Response.json({}, { status: failing });
    const ok = (data: unknown, status = 200) => Response.json(data, { status });
    const missing = () => Response.json({ message: "Not Found" }, { status: 404 });
    const rel = path.startsWith(prefix) ? path.slice(prefix.length) : null;

    if (path === "/search/code") return ok({ total_count: 1, items: [{ path: "src/a.ts", html_url: `https://github.com/${repo}/blob/main/src/a.ts` }] });
    if (rel === null) return missing();

    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/contents\/(.+)$/u.exec(rel))) {
      const name = m[1]!;
      if (files[name] !== undefined) return ok({ type: "file", name, path: name, size: Buffer.byteLength(files[name]!), sha: sha(name), encoding: "base64", content: Buffer.from(files[name]!).toString("base64") });
      const children = Object.keys(files).filter((file) => file.startsWith(`${name}/`));
      return children.length ? ok(children.map((file) => ({ name: file.split("/").pop(), type: "file", size: 1 }))) : missing();
    }
    if (method === "GET" && rel === "/issues") return ok([{ number: 1, title: "Bug", state: "open", user: { login: "ana" }, labels: [{ name: "bug" }], updated_at: "2026-01-01", html_url: `https://github.com/${repo}/issues/1` }, { number: 2, title: "A pull", state: "open", pull_request: {}, user: { login: "ana" }, labels: [] }]);
    if (method === "GET" && (m = /^\/issues\/(\d+)$/u.exec(rel))) return ok({ number: Number(m[1]), title: "Bug", state: "open", user: { login: "ana" }, labels: [], body: "It breaks.", html_url: `https://github.com/${repo}/issues/${m[1]}` });
    if (method === "GET" && /^\/issues\/\d+\/comments/u.test(rel)) return ok([{ user: { login: "bo" }, created_at: "2026-01-02", body: "Me too" }]);
    if (method === "GET" && rel === "/pulls") return ok([{ number: 3, title: "Fix", state: "open", head: { ref: "seira/b1/fix" }, base: { ref: defaultBranch }, user: { login: "bot" }, labels: [] }]);
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/u.exec(rel))) return ok({ number: Number(m[1]), title: "Fix", state: "open", head: { ref: "seira/b1/fix" }, base: { ref: defaultBranch }, changed_files: 1, additions: 2, deletions: 0, body: "Body", user: { login: "bot" }, labels: [] });
    if (method === "POST" && /^\/issues\/\d+\/comments$/u.test(rel)) return ok({ id: 77, html_url: `https://github.com/${repo}/issues/1#c77` }, 201);
    if (method === "POST" && rel === "/issues") return ok({ number: 9, html_url: `https://github.com/${repo}/issues/9` }, 201);
    if (method === "POST" && rel === "/pulls") return ok({ number: 10, html_url: `https://github.com/${repo}/pull/10` }, 201);
    if (method === "PUT" && /^\/pulls\/\d+\/merge$/u.test(rel)) return ok({ merged: true, sha: sha("merge") });
    if (method === "PATCH" && (m = /^\/issues\/(\d+)$/u.exec(rel))) return ok({ number: Number(m[1]), state: body?.state });

    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/u.exec(rel))) return branches.has(m[1]!) ? ok({ object: { sha: branches.get(m[1]!) } }) : missing();
    if (method === "POST" && rel === "/git/refs") {
      const name = String(body.ref).replace(/^refs\/heads\//u, "");
      if (branches.has(name)) return ok({ message: "Reference already exists" }, 422);
      branches.set(name, body.sha);
      return ok({ ref: body.ref }, 201);
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/u.exec(rel))) { branches.set(m[1]!, body.sha); return ok({ object: { sha: body.sha } }); }
    if (method === "DELETE" && (m = /^\/git\/refs\/heads\/(.+)$/u.exec(rel))) return branches.delete(m[1]!) ? new Response(null, { status: 204 }) : missing();
    if (method === "GET" && /^\/git\/commits\/[0-9a-f]+$/u.test(rel)) return ok({ tree: { sha: rootTree } });
    if (method === "GET" && (m = /^\/git\/trees\/([0-9a-f]+)$/u.exec(rel))) {
      const folder = folders.find((name) => folderSha(name) === m![1]);
      return folder === undefined ? missing() : ok({ sha: m[1], tree: folderEntries(folder), truncated: false });
    }
    if (method === "POST" && rel === "/git/blobs") return ok({ sha: sha(`blob${++counter}${body.content}`) }, 201);
    if (method === "POST" && rel === "/git/trees") return ok({ sha: sha(`tree${++counter}`) }, 201);
    if (method === "POST" && rel === "/git/commits") return ok({ sha: sha(`commit${++counter}${body.message}`) }, 201);
    return missing();
  }) as typeof fetch;

  return { fetch: fetcher, requests, branches, failWith: (status) => { failing = status; } };
}
