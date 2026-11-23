import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { AdminActionRow } from "../admin-activity.ts";
import { RECORDS_MAX, SPOOL_KEEP_MS } from "../bot-link/link.ts";
import { peerKey } from "../bot-link/protocol.ts";
import { createCoordinator, type Coordinator, type CoordinatorHost } from "../coordinator.ts";
import { json } from "../harness/http.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { LinkedServerError, capMode, createLinkedServers, type LinkedServers, type LinkedServersDeps } from "./linked-servers.ts";
import { ADMIT, BUSY_TEXT, createAdmission, createFrameBudget, createRefusalRecord } from "./linked-servers-admit.ts";
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
/** An invite made and taken: the joiner's credential, and the link as the inviter keeps it. */
async function accepted(made: LinkedServers, origin: string) {
  const answer = made.invite({ kind: "cli" });
  if ("error" in answer) throw new Error(answer.error);
  const { body } = await post(`${origin}/api/linked-servers/accept`, { code: codeOf(answer.invite), place: { id: "branch-environment", name: "Branch" } });
  const linkId = made.list()[0]!.id;
  return { token: String(body.token), linkId, key: peerKey(`guest:${linkId}`) };
}
const handoff = (id: string) => ({ t: "handoff", id, to: "writer", from: { botId: "scout", name: "Scout", threadId: "scout-chat" }, thread: "t", text: "Do it", mode: "work", origin: { kind: "person" } });
type Numbered = { seq: number; frame: { t: string } };
const NO_FILES: LinkedServersDeps["files"] = { carried: () => [], store: async () => [], crossed: () => {} };
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
    expect(guestOrigin("http://lan-host.example:8123")).toBeNull();
    expect(guestOrigin("http://a.example")).toBeNull();
    expect(guestOrigin("https://user:pass@a.example")).toBeNull();
    expect(guestOrigin("ftp://a.example")).toBeNull();
    expect(guestOrigin("not an address")).toBeNull();
  });

  it("keeps a far name to one clean line", () => {
    expect(cleanName("  Head\noffice\u0007 \u202Eevil  ")).toBe("Head office evil");
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

  it("writes one row a minute for a link's refusals of any reason, with their count", () => {
    let now = 0;
    const record = createRefusalRecord(() => now);
    expect([1, 2, 3, 4, 5].map(() => record.count("a"))).toEqual([1, null, null, null, null]);
    expect(record.count("b")).toBe(1);
    now = ADMIT.windowMs - 1;
    expect(record.count("a")).toBeNull();
    now = ADMIT.windowMs;
    expect(record.count("a")).toBe(6);
    expect(record.count("a")).toBeNull();
    record.forget("a");
    expect(record.count("a")).toBe(1);
  });

  it("takes the work frames of an exchange only while all of them fit in the link's sliding minute", () => {
    let now = 0;
    const budget = createFrameBudget(() => now, 10);
    expect(budget.take("a", 0)).toBe(true);
    expect(budget.take("a", 11)).toBe(false);
    expect(budget.take("a", 6)).toBe(true);
    now = 30_000;
    expect(budget.take("a", 5)).toBe(false);
    expect(budget.take("a", 4)).toBe(true);
    expect(budget.take("a", 1)).toBe(false);
    expect(budget.take("b", 10)).toBe(true);
    now = ADMIT.windowMs;
    expect(budget.take("a", 6)).toBe(true);
    expect(budget.take("a", 1)).toBe(false);
    budget.forget("a");
    expect(budget.take("a", 10)).toBe(true);
    expect(ADMIT.frames).toBeGreaterThanOrEqual(3 * ADMIT.perWindow);
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
    expect(manager("lan", { publicOrigin: () => "http://lan-host.example:8123" }).made.invite({ kind: "cli" })).toEqual({ error: "no_address" });

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

    for (const origin of ["http://lan-host.example:8123", "http://head.example", "ftp://head.example"]) {
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
      if (path === "/api/linked-servers/accept") return new Response(JSON.stringify({ token, place: { id: "head-environment", name: "Head\u202Eoffice" } }), { status: 200 });
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
    await until(() => !existsSync(own), "the credential is gone");
    expect(made.list()[0]?.state).toBe("ended");
  });

  it("counts a wrong credential on the exchange and file paths as a failed try, and refuses a sender with too many", async () => {
    let allowed = true;
    const { made, failed } = manager("head", { attemptAllowed: () => allowed });
    const origin = await serving(made);
    const { token } = await accepted(made, origin);
    const stranger = `lsk_${"B".repeat(43)}`, file = `${origin}/api/linked-servers/file?id=x&way=sent&index=0&name=a.txt`;
    const sync = (bearer: string) => post(`${origin}/api/linked-servers/sync`, { ack: 0, frames: [], wait: 0 }, { authorization: `Bearer ${bearer}` });

    expect((await sync(stranger)).status).toBe(401);
    expect((await fetch(file, { method: "PUT", headers: { authorization: `Bearer ${stranger}` }, body: "x" })).status).toBe(401);
    expect((await fetch(file)).status).toBe(401);
    expect(failed).toHaveLength(3);
    expect(failed.every((key) => key.startsWith("linked-server:"))).toBe(true);
    expect((await sync(token)).status).toBe(200);
    expect(failed).toHaveLength(3);

    allowed = false;
    expect((await sync(token)).status).toBe(429);
    expect((await sync(stranger)).status).toBe(429);
    expect(failed).toHaveLength(3);
  });

  it("refuses a file when the link's waiting files would pass their bytes or their number of hand-offs, until they are swept", async () => {
    let now = Date.now();
    const { made, dataDir } = manager("head", { now: () => now, files: NO_FILES, limits: { spool: { bytes: 100, ids: 2 } } });
    const origin = await serving(made);
    const { token, linkId } = await accepted(made, origin);
    const spool = join(dataDir, "linked-servers", linkId, "bot-link-files");
    const at = (id: string, index: number) => `${origin}/api/linked-servers/file?id=${id}&way=sent&index=${index}&name=a.txt`;
    const put = async (id: string, index: number, bytes: number) =>
      (await fetch(at(id, index), { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: new Uint8Array(bytes) })).status;

    expect(await put("h-1", 0, 60)).toBe(200);
    expect(await put("h-1", 1, 50)).toBe(413);
    expect(await put("h-2", 0, 40)).toBe(200);
    expect(await put("h-3", 0, 0)).toBe(413);
    expect(await put("h-1", 0, 60)).toBe(200);
    const unsized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1)); controller.close(); } });
    expect((await fetch(at("h-4", 0), { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: unsized, duplex: "half" } as RequestInit)).status).toBe(413);
    expect(readdirSync(spool)).toHaveLength(2);
    expect(readdirSync(spool).flatMap((one) => readdirSync(join(spool, one, "sent")))).toEqual(["0-a.txt", "0-a.txt"]);

    now += SPOOL_KEEP_MS + 60_000;
    made.start();
    expect(readdirSync(spool)).toEqual([]);
    expect(await put("h-3", 0, 100)).toBe(200);
  });

  it("takes no frames of an exchange that would pass the link's work frames for the minute, and leaves no trace of a cancel for unknown work", async () => {
    let now = Date.now();
    const { made, rows, dataDir } = manager("head", { now: () => now, limits: { frames: 4 } });
    const origin = await serving(made);
    const { token, linkId } = await accepted(made, origin);
    const state = join(dataDir, "linked-servers", linkId, "bot-link.json");
    const sync = (frames: unknown[], fresh = false) => post(`${origin}/api/linked-servers/sync`, { ...(fresh ? { fresh } : {}), ack: 0, frames, wait: 0 }, { authorization: `Bearer ${token}` });
    const cancels = (from: number, count: number) => Array.from({ length: count }, (_, index) => ({ t: "cancel", id: `unknown-${from + index}` }));
    expect((await sync([], true)).status).toBe(200);
    const kept = readFileSync(state, "utf8"), written = rows.length;

    const answer = await sync(cancels(0, 4));
    expect(answer.status).toBe(200);
    expect((answer.body.frames as Numbered[]).map((one) => one.frame.t)).not.toContain("result");
    expect(readFileSync(state, "utf8")).toBe(kept);
    expect(rows).toHaveLength(written);

    expect((await sync(cancels(4, 1))).status).toBe(429);
    expect((await sync([{ t: "done", id: "unknown-0" }])).status).toBe(200);
    now += ADMIT.windowMs;
    expect((await sync(cancels(5, 5))).status).toBe(429);
    expect((await sync(cancels(5, 4))).status).toBe(200);
    expect((await sync(cancels(9, 1))).status).toBe(429);
  });

  it("takes the work frames an honest server sends in a minute: its hand-offs, their cancels and its results", async () => {
    const { made } = manager("head");
    const origin = await serving(made);
    const { token } = await accepted(made, origin);
    const sync = (frames: unknown[]) => post(`${origin}/api/linked-servers/sync`, { ack: 0, frames, wait: 0 }, { authorization: `Bearer ${token}` });
    const ids = Array.from({ length: ADMIT.perWindow }, (_, index) => `h-${index}`);
    expect((await sync(ids.map(handoff))).status).toBe(200);
    expect((await sync(ids.map((id) => ({ t: "cancel", id })))).status).toBe(200);
    expect((await sync(ids.map((id) => ({ t: "result", id: `out-${id}`, ok: true, text: "" })))).status).toBe(200);
    const rest = ADMIT.frames - 3 * ADMIT.perWindow;
    expect(rest).toBeGreaterThan(0);
    expect((await sync(Array.from({ length: rest }, (_, index) => ({ t: "cancel", id: ids[index % ids.length] })))).status).toBe(200);
    expect((await sync([{ t: "cancel", id: "h-0" }])).status).toBe(429);
  });

  it("writes one refusal row a minute for a link, with the count, and no hand-off row for a refused hand-off", async () => {
    let now = Date.now();
    const { made, rows } = manager("head", { now: () => now });
    const origin = await serving(made);
    const { token } = await accepted(made, origin);
    const sync = (frames: unknown[]) => post(`${origin}/api/linked-servers/sync`, { ack: 0, frames, wait: 0 }, { authorization: `Bearer ${token}` });
    expect((await sync([handoff("h-1"), handoff("h-2"), handoff("h-3")])).status).toBe(200);
    now += ADMIT.windowMs;
    expect((await sync([handoff("h-4")])).status).toBe(200);
    expect(rows.filter((row) => row.action === "linked-server.refused").map((row) => row.after)).toEqual([
      { reason: "bot", bot: "writer", farBot: "scout", handoff: "h-1", count: 1 }, { reason: "bot", bot: "writer", farBot: "scout", handoff: "h-4", count: 3 }]);
    expect(rows.filter((row) => row.action === "linked-server.handoff")).toEqual([]);
  });

  it("takes no work frames while the frames that wait for the link pass its bound, until it acknowledges them", async () => {
    const { made, dataDir } = manager("head", { limits: { outbox: 3 } });
    const origin = await serving(made);
    const { token, linkId } = await accepted(made, origin);
    const work = () => Object.keys((JSON.parse(readFileSync(join(dataDir, "linked-servers", linkId, "bot-link.json"), "utf8")) as { work: Record<string, unknown> }).work);
    const sync = (frames: unknown[], ack = 0, fresh = false) =>
      post(`${origin}/api/linked-servers/sync`, { ...(fresh ? { fresh } : {}), ack, frames, wait: 0 }, { authorization: `Bearer ${token}` });
    expect((await sync([], 0, true)).status).toBe(200);
    const answer = await sync([handoff("h-1"), handoff("h-2"), handoff("h-3")]);
    const waiting = answer.body.frames as Numbered[];
    expect(waiting.map((one) => one.frame.t)).toEqual(["hello", "result", "result", "result"]);

    expect((await sync([handoff("h-4"), { t: "cancel", id: "h-1" }])).status).toBe(200);
    expect(work()).toEqual(["h-1", "h-2", "h-3"]);
    expect((await sync([handoff("h-4")], Math.max(...waiting.map((one) => one.seq)))).status).toBe(200);
    expect(work()).toEqual(["h-1", "h-2", "h-3", "h-4"]);
  });

  it("keeps a link's work records within their bound at each refusal, not only at the hourly tidy", async () => {
    const first = manager("head");
    const { linkId, key } = await accepted(first.made, await serving(first.made));
    first.made.close();
    const path = join(first.dataDir, "linked-servers", linkId, "bot-link.json");
    const records = () => (JSON.parse(readFileSync(path, "utf8")) as { work: Record<string, unknown> }).work;
    const at = Date.now();
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")) as object, work: Object.fromEntries(Array.from({ length: RECORDS_MAX }, (_, index) =>
      [`old-${index}`, { peer: key, root: `link-old-${index}`, from: "", at: at - RECORDS_MAX + index, done: { ok: false, outcome: "refused" } }])) }), { mode: 0o600 });
    expect(Object.keys(records())).toHaveLength(RECORDS_MAX);

    const { made } = manager("again", { dataDir: first.dataDir });
    made.instances()[0]!.link.receive(key, [handoff("new-1"), handoff("new-2"), handoff("new-3")]);
    const kept = Object.keys(records());
    expect(kept).toHaveLength(RECORDS_MAX);
    expect(kept).toEqual(expect.arrayContaining(["new-1", "new-2", "new-3"]));
    expect(kept).not.toContain("old-0");
  });
});
