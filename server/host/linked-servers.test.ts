import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { createCoordinator, type Coordinator, type CoordinatorHost } from "../coordinator.ts";
import { json } from "../harness/http.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { LinkedServerError, capMode, createLinkedServers, type LinkedServers, type LinkedServersDeps } from "./linked-servers.ts";
import { ADMIT, BUSY_TEXT, createAdmission, createRefusalRecord } from "./linked-servers-admit.ts";
import { INVITE_TTL_MS, addInvite, cleanName, decodeInvite, encodeInvite, guestOrigin, hashSecret, liveInvite, pruneInvites, readLinks, writeLinks, type LinksFile } from "./linked-servers-store.ts";

const dirs: string[] = [];
const closers: Array<() => void> = [];
const tempDir = (label = "store") => { const dir = mkdtempSync(join(tmpdir(), `linked-servers-${label}-`)); dirs.push(dir); return dir; };
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const QUIET: CoordinatorHost = { validate: () => undefined, busy: () => false, run: async () => ({ ok: true, text: "" }), report: () => {}, changed: () => {},
  names: () => ({ requester: "a", assignee: "b" }), park: () => {}, levelOf: () => ({ level: "ask" }), chiefOf: () => false };
const WRITER = { id: "writer", name: "Writer" };

function manager(label: string, more: Partial<LinkedServersDeps> = {}) {
  const dataDir = tempDir(label);
  const rows: Array<Omit<AdminActionRow, "at">> = [], failed: string[] = [], logs: string[] = [];
  let coordinator: Coordinator | undefined;
  const made = createLinkedServers({
    dataDir, coordinator: () => (coordinator ??= createCoordinator({ dataDir, host: QUIET, log: () => {} })),
    bots: () => [WRITER], bot: (id) => (id === WRITER.id ? WRITER : undefined), level: () => "full",
    openThread: () => undefined, hasThread: () => false, personName: () => undefined, sentRow: () => {}, resultRow: () => {}, kick: () => {},
    serverName: () => "Head office", selfId: () => `${label}-environment`, publicOrigin: () => "https://head.example/",
    audit: (row) => { rows.push(row); }, attemptAllowed: () => true, attemptFailed: (key) => { failed.push(key); }, log: (line) => { logs.push(line); },
    timing: { holdMs: 200, firstRetryMs: 20 },
    ...more,
  });
  closers.push(() => { made.close(); try { coordinator?.close(); } catch { /* closed */ } });
  return { made, rows, failed, logs, dataDir };
}

/** A server that answers only what the manager serves before sign-in, and 404 for the rest. */
async function serving(made: LinkedServers): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void made.serve({ req, res, url, path: url.pathname, method: req.method ?? "GET" }).then((answered) => {
      if (!answered) { req.resume(); json(res, 404, { error: "not here" }); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const codeOf = (invite: string) => decodeInvite(invite)!.code;
const until = async (what: () => boolean, label: string, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the link record", () => {
  it("keeps an invite as a hash, good once and for fifteen minutes", () => {
    const file: LinksFile = { v: 1, links: [], invites: [] };
    const start = 1_000_000;
    const { code, expiresAt } = addInvite(file, start);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(expiresAt).toBe(start + INVITE_TTL_MS);
    expect(JSON.stringify(file)).not.toContain(code);
    expect(file.invites[0]!.hash).toBe(hashSecret(code));

    expect(liveInvite(file, code, start + INVITE_TTL_MS - 1)).toBeDefined();
    expect(liveInvite(file, code, start + INVITE_TTL_MS)).toBeUndefined();
    expect(liveInvite(file, "x".repeat(43), start)).toBeUndefined();
    expect(liveInvite(file, `${code}=`, start)).toBeUndefined();

    liveInvite(file, code, start + 1)!.usedAt = start + 1;
    expect(liveInvite(file, code, start + 2)).toBeUndefined();
    pruneInvites(file, start + 2);
    expect(file.invites).toEqual([]);

    const late = addInvite(file, start);
    pruneInvites(file, start + INVITE_TTL_MS);
    expect(liveInvite(file, late.code, start)).toBeUndefined();
    expect(file.invites).toEqual([]);
  });

  it("writes mode 600 and reads back only a record that parses", () => {
    const dir = tempDir();
    expect(readLinks(dir)).toEqual({ v: 1, links: [], invites: [] });
    const file: LinksFile = { v: 1, invites: [], links: [{ id: "0123456789abcdef", role: "inviter", place: { id: "far", name: "Far" }, exposed: ["writer"], cap: "ask", tokenHash: hashSecret("lsk_x"), createdAt: 1 }] };
    writeLinks(dir, file);
    const path = join(dir, "linked-servers", "links.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readLinks(dir)).toEqual(file);
    expect(readFileSync(path, "utf8")).not.toContain("lsk_x");

    const lines: string[] = [];
    writeLinks(dir, { ...file, links: [{ ...file.links[0]!, tokenHash: undefined }] } as LinksFile);
    expect(readLinks(dir, (line) => lines.push(line)).links).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("reads back an invite it wrote, and refuses any other text", () => {
    const text = encodeInvite({ origin: "https://a.example", name: "Head office", code: "A".repeat(43) });
    expect(text.startsWith("seira-link:")).toBe(true);
    expect(decodeInvite(`  ${text}\n`)).toEqual({ origin: "https://a.example", name: "Head office", code: "A".repeat(43) });
    expect(decodeInvite(text.replace("seira-link:", "other:"))).toBeNull();
    expect(decodeInvite(`${text}!`)).toBeNull();
    expect(decodeInvite(`seira-link:${Buffer.from(JSON.stringify({ v: 1, origin: "https://a.example", name: "A", code: "short" })).toString("base64url")}`)).toBeNull();
    expect(decodeInvite(`seira-link:${Buffer.from(JSON.stringify({ v: 1, origin: "https://a.example", name: "A", code: "A".repeat(43), more: 1 })).toString("base64url")}`)).toBeNull();
  });

  it("asks another server only at https or at this machine's loopback", () => {
    expect(guestOrigin("https://a.example/path")).toBe("https://a.example");
    expect(guestOrigin("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123");
    expect(guestOrigin("http://localhost:8123")).toBe("http://localhost:8123");
    expect(guestOrigin("http://[::1]:8123")).toBe("http://[::1]:8123");
    expect(guestOrigin("http://192.168.1.4:8123")).toBeNull();
    expect(guestOrigin("http://a.example")).toBeNull();
    expect(guestOrigin("https://user:pass@a.example")).toBeNull();
    expect(guestOrigin("ftp://a.example")).toBeNull();
    expect(guestOrigin("not an address")).toBeNull();
  });

  it("keeps a far name to one clean line", () => {
    expect(cleanName("  Head\noffice\u0007 ‮evil  ")).toBe("Head office evil");
    expect(cleanName("😀".repeat(200))).toBe("😀".repeat(60));
    expect(cleanName(`a${"😀".repeat(200)}`)).toBe(`a${"😀".repeat(59)}`);
    expect(cleanName("b".repeat(300))).toHaveLength(120);
    expect(cleanName("\n\t")).toBe("");
  });
});

describe("admission", () => {
  it("refuses at eight open hand-offs, and after thirty admitted in a sliding minute", () => {
    let now = 0;
    const admission = createAdmission(() => now);
    expect(admission.admit("a", ADMIT.open)).toBe(BUSY_TEXT);
    expect(BUSY_TEXT).not.toMatch(/\d/u);
    for (let index = 0; index < ADMIT.perWindow; index++) { now = index * 1_000; expect(admission.admit("a", 0)).toBeNull(); }
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    expect(admission.admit("b", 0)).toBeNull();
    now = ADMIT.windowMs - 1;
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    now = ADMIT.windowMs;
    expect(admission.admit("a", 0)).toBeNull();
    expect(admission.admit("a", 0)).toBe(BUSY_TEXT);
    admission.forget("a");
    expect(admission.admit("a", 0)).toBeNull();
  });

  it("writes one row a minute for refusals over the limits, with their count", () => {
    let now = 0;
    const record = createRefusalRecord(() => now);
    expect([1, 2, 3, 4, 5].map(() => record.count("a", "limit"))).toEqual([1, null, null, null, null]);
    expect(record.count("a", "bot")).toBe(1);
    expect(record.count("b", "limit")).toBe(1);
    now = ADMIT.windowMs;
    expect(record.count("a", "limit")).toBe(5);
    expect(record.count("a", "limit")).toBeNull();
    record.forget("a");
    expect(record.count("a", "limit")).toBe(1);
  });
});

describe("the approval cap", () => {
  it("keeps a lower mode and lowers any other to the cap", () => {
    expect([capMode("ask", "auto"), capMode("edits", "auto"), capMode("auto", "auto")]).toEqual(["ask", "edits", "auto"]);
    expect([capMode("edits", "ask"), capMode("auto", "edits"), capMode("full", "auto"), capMode("custom", "edits"), capMode("full", "ask")]).toEqual(["ask", "edits", "auto", "edits", "ask"]);
  });
});

describe("the linked servers manager", () => {
  it("makes an invite only with a secure address and room for one more link, and keeps its code as a hash", () => {
    expect(manager("none", { publicOrigin: () => null }).made.invite({ kind: "cli" })).toEqual({ error: "no_address" });
    expect(manager("lan", { publicOrigin: () => "http://192.168.1.4:8123" }).made.invite({ kind: "cli" })).toEqual({ error: "no_address" });

    const { made, rows, dataDir } = manager("head");
    const answer = made.invite({ kind: "cli" });
    if ("error" in answer) throw new Error(answer.error);
    expect(decodeInvite(answer.invite)).toEqual({ origin: "https://head.example", name: "Head office", code: codeOf(answer.invite) });
    expect(answer.expiresAt - Date.now()).toBeLessThanOrEqual(INVITE_TTL_MS);
    expect(readFileSync(join(dataDir, "linked-servers", "links.json"), "utf8")).not.toContain(codeOf(answer.invite));
    expect(rows.map((row) => row.action)).toEqual(["linked-server.invite"]);
    expect(JSON.stringify(rows)).not.toContain(codeOf(answer.invite));

    const full = tempDir("full");
    writeLinks(full, { v: 1, invites: [], links: Array.from({ length: 20 }, (_, index) => ({
      id: index.toString(16).padStart(16, "0"), role: "joiner" as const, place: { id: `far-${index}`, name: "Far" }, exposed: [], cap: "ask" as const, createdAt: 1 })) });
    expect(manager("full", { dataDir: full }).made.invite({ kind: "cli" })).toEqual({ error: "full" });
  });

  it("answers a wrong, used or throttled code with one refusal, and a right one with a credential it keeps only as a hash", async () => {
    let allowed = true;
    const { made, rows, failed, dataDir } = manager("head", { attemptAllowed: () => allowed });
    const origin = await serving(made);
    const accept = `${origin}/api/linked-servers/accept`;
    const answer = made.invite({ kind: "cli" });
    if ("error" in answer) throw new Error(answer.error);
    const code = codeOf(answer.invite), place = { id: "branch-environment", name: "Branch\u0007\noffice" };

    const wrong = await post(accept, { code: "A".repeat(43), place });
    expect(wrong).toEqual({ status: 403, body: { error: "That invite is not valid any more. Ask for a new one." } });
    expect(await post(accept, { code, place, more: 1 })).toEqual(wrong);
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatch(/^linked-server:/u);
    allowed = false;
    expect((await post(accept, { code, place })).status).toBe(429);
    expect(failed).toHaveLength(2);
    expect(made.list()).toEqual([]);

    allowed = true;
    const right = await post(accept, { code, place });
    expect(right.status).toBe(200);
    expect(right.body.place).toEqual({ id: "head-environment", name: "Head office" });
    const token = String(right.body.token);
    expect(token).toMatch(/^lsk_[A-Za-z0-9_-]{43}$/u);
    expect(await post(accept, { code, place })).toEqual(wrong);

    const [view] = made.list();
    expect(view).toMatchObject({ name: "Branch office", role: "inviter", state: "offline", exposed: [], cap: "ask", bots: [] });
    const stored = readFileSync(join(dataDir, "linked-servers", "links.json"), "utf8");
    expect(stored).toContain(hashSecret(token));
    expect(stored).not.toContain(token);
    for (const text of [JSON.stringify(made.list()), JSON.stringify(rows)]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(hashSecret(token));
      expect(text).not.toContain(code);
      expect(text).not.toContain(hashSecret(code));
    }
    expect(rows.find((row) => row.action === "linked-server.accept")?.actor).toEqual({ kind: "linked-server", linkId: view!.id, name: "Branch office" });
  });

  it("takes a link's credential on its own paths only, and refuses it on every other path", async () => {
    const { made } = manager("head");
    const origin = await serving(made);
    const answer = made.invite({ kind: "cli" });
    if ("error" in answer) throw new Error(answer.error);
    const { body } = await post(`${origin}/api/linked-servers/accept`, { code: codeOf(answer.invite), place: { id: "branch-environment", name: "Branch" } });
    const token = String(body.token);

    for (const [method, path] of [["GET", "/api/bots"], ["POST", "/api/bot-link/sync"], ["GET", "/api/linked-servers"], ["DELETE", "/api/linked-servers/0123456789abcdef"]] as const) {
      const response = await fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toEqual({ error: "This sign-in works only for the link between two servers." });
    }
    expect((await fetch(`${origin}/api/bots`)).status).toBe(404);
    expect((await fetch(`${origin}/api/bots`, { headers: { authorization: "Bearer other-token" } })).status).toBe(404);

    const stranger = `lsk_${"B".repeat(43)}`;
    expect((await post(`${origin}/api/linked-servers/sync`, { ack: 0, frames: [], wait: 0 }, { authorization: `Bearer ${stranger}` })).status).toBe(401);
    expect((await post(`${origin}/api/linked-servers/sync`, { ack: 0, frames: [], wait: 0 }, { authorization: `Bearer ${token.slice(4)}` })).status).toBe(401);
    expect((await fetch(`${origin}/api/linked-servers/file?id=x&way=sent&index=0&name=a.txt`)).status).toBe(401);
    const synced = await post(`${origin}/api/linked-servers/sync`, { fresh: true, ack: 0, frames: [], wait: 0 }, { authorization: `Bearer ${token}` });
    expect(synced.status).toBe(200);
    expect(made.list()[0]!.state).toBe("online");
  });

  it("removes a link: its record, its credential and its folder go, and its credential stops working", async () => {
    const { made, rows, dataDir } = manager("head");
    const origin = await serving(made);
    const answer = made.invite({ kind: "cli" });
    if ("error" in answer) throw new Error(answer.error);
    const { body } = await post(`${origin}/api/linked-servers/accept`, { code: codeOf(answer.invite), place: { id: "branch-environment", name: "Branch" } });
    const [view] = made.list();
    const folder = join(dataDir, "linked-servers", view!.id);
    expect(existsSync(join(folder, "bot-link.json"))).toBe(true);

    expect(made.update("ffffffffffffffff", { cap: "auto" }, { kind: "cli" })).toBeNull();
    expect(made.update(view!.id, { exposed: ["writer", "writer", "../x"], cap: "edits" }, { kind: "cli" })).toMatchObject({ exposed: ["writer"], cap: "edits" });
    expect(rows.at(-1)).toMatchObject({ action: "linked-server.update", changed: ["exposed", "cap"], before: { exposed: [], cap: "ask" }, after: { exposed: ["writer"], cap: "edits" } });

    expect(await made.remove(view!.id, { kind: "cli" })).toBe(true);
    expect(await made.remove(view!.id, { kind: "cli" })).toBe(false);
    expect(existsSync(folder)).toBe(false);
    expect(made.list()).toEqual([]);
    expect(readFileSync(join(dataDir, "linked-servers", "links.json"), "utf8")).not.toContain(hashSecret(String(body.token)));
    expect((await post(`${origin}/api/linked-servers/sync`, { ack: 0, frames: [], wait: 0 }, { authorization: `Bearer ${String(body.token)}` })).status).toBe(401);
    expect(rows.map((row) => row.action)).toEqual(["linked-server.invite", "linked-server.accept", "linked-server.update", "linked-server.remove"]);

    expect(manager("again", { dataDir }).made.list()).toEqual([]);
  });

  it("joins only an invite at a secure address, and says nothing the other server answered", async () => {
    const asked: string[] = [];
    let answer = () => new Response(JSON.stringify({ error: "remote secret words" }), { status: 500 });
    const fake = (async (input: Parameters<typeof fetch>[0]) => { asked.push(String(input)); return answer(); }) as typeof fetch;
    const { made, logs, rows } = manager("branch", { fetch: fake });
    const invite = (origin: string) => encodeInvite({ origin, name: "Head", code: "C".repeat(43) });
    const failure = async (text: string) => {
      try { await made.join(text, { kind: "cli" }); } catch (error) { if (error instanceof LinkedServerError) return error; throw error; }
      throw new Error("the join worked");
    };

    for (const origin of ["http://192.168.1.4:8123", "http://head.example", "ftp://head.example"]) {
      expect(await failure(invite(origin))).toMatchObject({ status: 400, message: "That invite points to an address that is not secure, so it was not used." });
    }
    expect(await failure("seira-link:not-an-invite")).toMatchObject({ status: 400 });
    expect(asked).toEqual([]);

    expect((await failure(invite("https://head.example"))).message).toBe("The other server could not be reached. Try again later.");
    expect(asked).toEqual(["https://head.example/api/linked-servers/accept"]);
    answer = () => new Response(JSON.stringify({ error: "remote secret words" }), { status: 403 });
    expect((await failure(invite("https://head.example"))).message).toBe("That invite is not valid any more. Ask for a new one.");
    answer = () => new Response(JSON.stringify({ token: `lsk_${"D".repeat(43)}`, place: { id: "head", name: "x".repeat(70_000) } }), { status: 200 });
    expect((await failure(invite("https://head.example"))).message).toBe("The other server could not be reached. Try again later.");
    answer = () => new Response(JSON.stringify({ token: "remote secret words", place: { id: "head", name: "Head" } }), { status: 200 });
    expect((await failure(invite("https://head.example"))).status).toBe(502);
    expect(JSON.stringify([...logs, ...rows])).not.toContain("remote secret words");
    expect(made.list()).toEqual([]);
  });

  it("keeps the credential a join got in the link's own file, and shows the link as ended once the other server refuses it", async () => {
    const token = `lsk_${"E".repeat(43)}`;
    let sync = () => new Response(null, { status: 500 });
    const fake = (async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/linked-servers/accept") return new Response(JSON.stringify({ token, place: { id: "head-environment", name: "Head‮office" } }), { status: 200 });
      return sync();
    }) as typeof fetch;
    const { made, rows, dataDir } = manager("branch", { fetch: fake });
    const view = await made.join(encodeInvite({ origin: "http://127.0.0.1:9", name: "Head", code: "C".repeat(43) }), { kind: "cli" });
    expect(view).toMatchObject({ name: "Head office", role: "joiner", exposed: [], cap: "ask" });
    expect(view.state).not.toBe("ended");
    const own = join(dataDir, "linked-servers", view.id, "bot-link.json");
    expect(readFileSync(own, "utf8")).toContain(token);
    if (process.platform !== "win32") expect(statSync(own).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dataDir, "linked-servers", "links.json"), "utf8")).not.toContain(token);
    expect(JSON.stringify([...rows, made.list()])).not.toContain(token);

    sync = () => new Response(null, { status: 401 });
    await until(() => made.list()[0]?.state === "ended", "the link shows as ended");
    expect(existsSync(own)).toBe(false);
  });
});
