import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AI_IMPORT_FILE_NAME_HEADER, AI_IMPORT_PATH, type ImportJobView } from "../../shared/ai-import/api.ts";
import { AiImportJobs } from "../ai-import/job.ts";
import { importHarness } from "../ai-import/testing/harness.ts";
import type { FakeScript } from "../ai-import/testing/fake-readers.ts";
import { DATA_DIR } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { closeMessageDb } from "../message-db.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createAiImportRoutes } from "./ai-import.ts";
import { dispatchRoutes } from "./table.ts";

const READERS_MODULE = new URL("../ai-import/testing/fake-readers.ts", import.meta.url).href;
const AUTH_HEADER = "x-test-auth";

const AUTHS: Record<string, RequestAuth> = {
  owner: { kind: "loopback", scopes: ["admin", "client"] },
  service: { kind: "loopback", scopes: ["client"], trust: "service" },
  admin: { kind: "session", session: {} as never, via: "bearer", scopes: ["admin", "client"] },
  guest: { kind: "session", session: {} as never, via: "bearer", scopes: ["client"] },
};

const servers: Server[] = [];
const jobsOpened: AiImportJobs[] = [];
const dirs: string[] = [];

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(jobsOpened.splice(0).map((jobs) => jobs.close()));
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

async function serve(local: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ai-import-routes-"));
  dirs.push(dir);
  const jobs = new AiImportJobs({
    dir, ports: importHarness().ports, broadcast: () => undefined, readersModule: READERS_MODULE,
    locate: async () => [{ id: "src-1", kind: "hermes", path: join(dir, "nowhere"), name: "Hermes" }],
  });
  jobs.start();
  jobsOpened.push(jobs);
  const routes = [createAiImportRoutes({ jobs, local })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = AUTHS[String(req.headers[AUTH_HEADER] ?? "owner")]!;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${AI_IMPORT_PATH}`;
}

const asJson = (body: unknown, who = "owner"): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json", [AUTH_HEADER]: who }, body: JSON.stringify(body),
});

async function upload(base: string, script: FakeScript, name = "fake-export.json"): Promise<string> {
  const res = await fetch(`${base}/uploads`, {
    method: "POST", headers: { [AI_IMPORT_FILE_NAME_HEADER]: encodeURIComponent(name) }, body: JSON.stringify(script),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

async function until(base: string, id: string, state: ImportJobView["state"]): Promise<ImportJobView> {
  for (let i = 0; i < 400; i++) {
    const view = (await (await fetch(`${base}/jobs/${id}`)).json()) as ImportJobView;
    if (view.state === state) return view;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`The job did not reach ${state}`);
}

describe("access", () => {
  it("refuses a session without the admin scope", async () => {
    const base = await serve(true);
    for (const who of ["guest", "service"]) {
      const headers = { [AUTH_HEADER]: who };
      for (const url of [`${base}/jobs`, `${base}/jobs/abc`, `${base}/local`]) {
        const res = await fetch(url, { headers });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: "forbidden" });
      }
      const post = await fetch(`${base}/jobs`, asJson({ from: "paste", ai: "other", aboutYou: ["a"], howToReply: [], destination: { kind: "new" } }, who));
      expect(post.status).toBe(403);
      const up = await fetch(`${base}/uploads`, { method: "POST", headers: { ...headers, [AI_IMPORT_FILE_NAME_HEADER]: "a.json" }, body: "{}" });
      expect(up.status).toBe(403);
    }
  });

  it("lists local sources only for the person at this computer", async () => {
    const here = await serve(true);
    const ok = await fetch(`${here}/local`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sources: [{ id: "src-1", kind: "hermes", name: "Hermes" }] });
    expect((await fetch(`${here}/local`, { headers: { [AUTH_HEADER]: "admin" } })).status).toBe(403);

    const remote = await serve(false);
    expect((await fetch(`${remote}/local`)).status).toBe(403);
    const job = await fetch(`${remote}/jobs`, asJson({ from: "local", sourceId: "src-1" }));
    expect(job.status).toBe(403);
    const fromSession = await fetch(`${here}/jobs`, asJson({ from: "local", sourceId: "src-1" }, "admin"));
    expect(fromSession.status).toBe(403);
  });
});

describe("bodies", () => {
  it("needs a JSON content type", async () => {
    const base = await serve(true);
    const res = await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ from: "upload", uploadIds: ["x"] }) });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "invalid" });
    expect((await fetch(`${base}/jobs`, { method: "POST", body: "{}" })).status).toBe(415);
  });

  it("refuses a wrong body", async () => {
    const base = await serve(true);
    const bodies = [{}, { from: "upload" }, { from: "upload", uploadIds: [] }, { from: "upload", uploadIds: ["a"], extra: 1 }, { from: "paste", ai: "nope", aboutYou: [], howToReply: [], destination: { kind: "new" } }];
    for (const body of bodies) {
      const res = await fetch(`${base}/jobs`, asJson(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid" });
    }
    const broken = await fetch(`${base}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(broken.status).toBe(400);
    const noName = await fetch(`${base}/uploads`, { method: "POST", body: "{}" });
    expect(noName.status).toBe(400);
  });
});

describe("jobs", () => {
  it("runs the upload flow", async () => {
    const base = await serve(true);
    const uploadId = await upload(base, { agents: 1, conversations: 3, messagesPer: 2 });
    const created = await fetch(`${base}/jobs`, asJson({ from: "upload", uploadIds: [uploadId] }));
    expect(created.status).toBe(200);
    const job = (await created.json()) as ImportJobView;
    expect(job.source.kind).toBe("chatgpt");

    const one = await fetch(`${base}/jobs/${job.id}`);
    expect(one.status).toBe(200);
    expect(((await one.json()) as ImportJobView).id).toBe(job.id);

    const list = (await (await fetch(`${base}/jobs`)).json()) as { jobs: ImportJobView[] };
    expect(list.jobs.map((entry) => entry.id)).toContain(job.id);

    const ready = await until(base, job.id, "ready");
    expect(ready.counts.conversations).toBe(3);
    const applied = await fetch(`${base}/jobs/${job.id}/apply`, asJson({ destinations: {} }));
    expect(applied.status).toBe(200);
    expect(((await applied.json()) as ImportJobView).state).toBe("applying");
    const done = await until(base, job.id, "done");
    expect(done.progress.done).toBe(6);
  });

  it("answers 404 for a job it does not know", async () => {
    const base = await serve(true);
    for (const url of [`${base}/jobs/no-such-job`, `${base}/jobs/${"a".repeat(100)}`, `${base}/jobs/x/other`, `${base}/nothing`]) {
      const res = await fetch(url);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not-found" });
    }
    for (const action of ["apply", "cancel", "undo"]) {
      const res = await fetch(`${base}/jobs/no-such-job/${action}`, action === "apply" ? asJson({ destinations: {} }) : { method: "POST" });
      expect(res.status).toBe(404);
    }
  });

  it("maps a job error to its status", async () => {
    const base = await serve(true);
    const uploadId = await upload(base, { agents: 1, conversations: 1, messagesPer: 2 });
    const job = (await (await fetch(`${base}/jobs`, asJson({ from: "upload", uploadIds: [uploadId] }))).json()) as ImportJobView;
    await until(base, job.id, "ready");
    const undo = await fetch(`${base}/jobs/${job.id}/undo`, { method: "POST" });
    expect(undo.status).toBe(409);
    expect(await undo.json()).toEqual({ error: "conflict" });

    const unknown = await upload(base, {}, "other.json");
    const refused = await fetch(`${base}/jobs`, asJson({ from: "upload", uploadIds: [unknown] }));
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "unknown-source" });

    const missing = await fetch(`${base}/jobs`, asJson({ from: "upload", uploadIds: ["00000000-0000-4000-8000-000000000000"] }));
    expect(missing.status).toBe(404);

    const big = await fetch(`${base}/jobs`, asJson({ from: "paste", ai: "other", aboutYou: ["a".repeat(60_000), "b".repeat(60_000)], howToReply: [], destination: { kind: "new" } }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "too-much-data" });
  });

  it("sends no-store on every answer", async () => {
    const base = await serve(true);
    const uploadId = await upload(base, { agents: 1, conversations: 1 });
    const answers = [
      await fetch(`${base}/jobs`),
      await fetch(`${base}/jobs/no-such-job`),
      await fetch(`${base}/local`),
      await fetch(`${base}/jobs`, asJson({ from: "upload", uploadIds: [uploadId] })),
      await fetch(`${base}/jobs`, asJson({})),
      await fetch(`${base}/jobs`, { method: "POST" }),
    ];
    for (const res of answers) expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
