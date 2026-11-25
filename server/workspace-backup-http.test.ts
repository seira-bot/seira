// Archive work is mocked so revocation can be held at a deterministic boundary.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceBackupSummary } from "../shared/workspace-backup.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { SessionRegistry } from "./sessions.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";
import { userError, userErrorThrown } from "./user-errors.ts";

const archive = vi.hoisted(() => ({ create: vi.fn(), stage: vi.fn(), commit: vi.fn(), remove: vi.fn() }));
vi.mock("./workspace-backup.ts", async (original) => ({
  ...await original<typeof import("./workspace-backup.ts")>(),
  createWorkspaceBackup: archive.create, stageWorkspaceBackup: archive.stage,
  commitPendingWorkspaceRestore: archive.commit, removeWorkspaceBackupJob: archive.remove,
}));
import { createWorkspaceBackupRoutes, isWorkspaceBackupSessionControl } from "./workspace-backup-http.ts";

const PASSWORD = "fixture password 123";
let dataDir: string;
let server: Server;
let url: string;
let sessions: SessionRegistry;
let maintenance: WorkspaceBackupMaintenance;
let admin: ReturnType<SessionRegistry["issue"]>;

function fakeArchive() {
  const id = randomUUID();
  const directory = join(dataDir, ".backups", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "workspace.seirabackup");
  writeFileSync(path, "fixture encrypted bytes", { mode: 0o600 });
  const summary: WorkspaceBackupSummary = { format: "seira.workspace-backup", version: 1, id, createdAt: "2026-09-11T00:00:00Z", appVersion: "0.1.71", files: 1, directories: 0, bytes: 23, bots: 0, groups: 0, threads: 0, messages: 0, exclusions: [], warnings: [] };
  return { id, path, summary };
}

beforeEach(async () => {
  vi.resetAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), "seira-backup-http-"));
  maintenance = new WorkspaceBackupMaintenance();
  sessions = new SessionRegistry({ file: join(dataDir, "sessions.json") });
  admin = sessions.issue({ label: "Fixture admin", scopes: ["admin", "client"] });
  archive.create.mockImplementation(async () => fakeArchive());
  archive.stage.mockImplementation(async () => fakeArchive());
  archive.commit.mockImplementation((_dataDir: string, id: string) => ({ id, restartRequired: true }));
  archive.remove.mockImplementation((_dataDir: string, id: string) => rmSync(join(dataDir, ".backups", id), { recursive: true, force: true }));
  await listen();
});

/** Serves the backup routes; `extra` adds options such as a launcher restart. */
async function listen(extra: Partial<Parameters<typeof createWorkspaceBackupRoutes>[0]> = {}) {
  const authenticate = (req: IncomingMessage) => resolveRequestAuth(req, { sessions, cookieName: "fixture", streamPath: "/api/events", url: new URL(req.url!, url) });
  const routes = createWorkspaceBackupRoutes({
    dataDir, appVersion: "0.1.71", restored: {},
    readBody: async (req, limit = 1_000_000) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > limit) throw Object.assign(new Error("body too large"), { status: 413 });
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString() || "{}");
    },
    authorized: (req, original) => {
      const current = authenticate(req).auth;
      return Boolean(current?.scopes.includes("admin") && current.kind === original.kind &&
        (current.kind !== "session" || (original.kind === "session" && current.session.id === original.session.id)));
    },
    status: () => ({ busy: maintenance.active, pendingRestore: maintenance.pendingRestore }),
    exclusive: (work, keepLocked) => maintenance.run(work, { idle: () => true, pause: () => {}, resume: () => {}, flush: async () => {} }, keepLocked),
    ...extra,
  });
  server = createServer(async (req, res) => {
    const path = new URL(req.url!, url).pathname;
    const method = req.method!;
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let release: (() => void) | undefined;
    try {
      const gate = authenticate(req);
      if (!gate.auth) return json(gate.status, { error: gate.error });
      if (await routes(req, res, path, gate.auth)) return;
      if (!isWorkspaceBackupSessionControl(method, path)) release = maintenance.request();
      if (method === "GET" && path === "/api/auth/sessions") return json(200, { sessions: sessions.list() });
      if (method === "POST" && path === "/api/auth/logout") {
        if (gate.auth.kind === "session") sessions.revoke(gate.auth.session.id);
        return json(200, { ok: true });
      }
      if (method === "DELETE" && /^\/api\/auth\/sessions\/[\w-]+$/.test(path)) return json(200, { ok: sessions.revoke(path.split("/").at(-1)!) });
      json(404, { error: "Fixture route not found" });
    } catch (error) { json((error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) }); }
    finally { release?.(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  url = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

function post(path: string, body: unknown, token = admin.token) {
  return fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

it("carries a fixed backup refusal and its redacted string path to the client", async () => {
  const params = { path: "workspaces/ws/project/loop" };
  archive.create.mockRejectedValueOnce(userErrorThrown("serverError.backup.recursiveLink", params));
  const response = await post("/api/workspace-backup/export", { password: PASSWORD });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(userError("serverError.backup.recursiveLink", params));
});

it("reports the size of each part in a read-only route", async () => {
  mkdirSync(join(dataDir, "task-workspaces", "bot"), { recursive: true });
  writeFileSync(join(dataDir, "task-workspaces", "bot", "clip.bin"), Buffer.alloc(1234));
  const response = await fetch(`${url}/api/workspace-backup/sizes`, { headers: { authorization: `Bearer ${admin.token}` } });
  expect(response.status).toBe(200);
  const body = await response.json() as { parts: Record<string, number>; total: number; canLeaveOut: string[] };
  expect(body.parts["work-folders"]).toBe(1234);
  expect(body.total).toBe(Object.values(body.parts).reduce((sum, bytes) => sum + bytes, 0));
  expect(body.canLeaveOut).toEqual(["work-folders"]);
});

it("does not count what the export leaves out", async () => {
  mkdirSync(join(dataDir, "task-workspaces", "bot"), { recursive: true });
  writeFileSync(join(dataDir, "task-workspaces", "bot", "clip.bin"), Buffer.alloc(1234));
  // The export skips these top-level folders, so the report must too.
  for (const name of ["tools", "browser", "cache", "tmp"]) {
    mkdirSync(join(dataDir, name), { recursive: true });
    writeFileSync(join(dataDir, name, "big.bin"), Buffer.alloc(5000));
  }
  const body = await fetch(`${url}/api/workspace-backup/sizes`, { headers: { authorization: `Bearer ${admin.token}` } }).then((response) => response.json()) as { parts: Record<string, number>; total: number };
  expect(body.parts.other).toBe(0);
  expect(body.total).toBe(1234);
});

it("gives no sizes on a Team Cloud, where the raw folder holds other members' private data", async () => {
  mkdirSync(join(dataDir, "task-workspaces", "member-chat"), { recursive: true });
  writeFileSync(join(dataDir, "task-workspaces", "member-chat", "private.bin"), Buffer.alloc(4321));
  vi.stubEnv("SEIRA_CLOUD_ROLE", "team");
  try {
    const response = await fetch(`${url}/api/workspace-backup/sizes`, { headers: { authorization: `Bearer ${admin.token}` } });
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).toContain("not available on a Team Cloud");
    expect(text).not.toContain("4321");
    expect(text).not.toContain("parts");
  } finally { vi.unstubAllEnvs(); }
});

it("passes the parts to leave out to the export, and refuses an unknown part with a clear message", async () => {
  expect((await post("/api/workspace-backup/export", { password: PASSWORD, leaveOut: ["work-folders"] })).status).toBe(200);
  expect(archive.create).toHaveBeenLastCalledWith(dataDir, expect.objectContaining({ leaveOut: ["work-folders"] }));
  const refused = await post("/api/workspace-backup/export", { password: PASSWORD, leaveOut: ["bots"] });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(await refused.json())).toContain('Cannot leave out \\"bots\\". Allowed: work-folders.');
  expect(archive.create).toHaveBeenCalledOnce();
});

it("names the exported file Seira-<date>.seirabackup in the reply and the download", async () => {
  const exported = await post("/api/workspace-backup/export", { password: PASSWORD }).then((response) => response.json()) as { id: string; filename: string };
  expect(exported.filename).toBe("Seira-2026-09-11.seirabackup");
  const download = await fetch(`${url}/api/workspace-backup/download/${exported.id}`, { headers: { authorization: `Bearer ${admin.token}` } });
  expect(download.headers.get("content-disposition")).toBe('attachment; filename="Seira-2026-09-11.seirabackup"');
  await download.arrayBuffer();
});

it.each(["revoke", "logout"])("keeps session controls authenticated and usable during a held export (%s)", async (action) => {
  let started!: () => void;
  let release!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const output = fakeArchive();
  archive.create.mockImplementationOnce(async () => { started(); await held; return output; });
  const exporting = post("/api/workspace-backup/export", { password: PASSWORD });
  try {
    await starting;
    expect(maintenance.active).toBe(true);
    const member = sessions.issue({ label: "Fixture member", scopes: ["client"] });
    expect((await fetch(`${url}/api/auth/sessions`, { headers: { authorization: `Bearer ${member.token}` } })).status).toBe(403);
    expect((await fetch(`${url}/api/auth/sessions`)).status).toBe(200);
    expect((await fetch(`${url}/api/bots`)).status).toBe(503);
    const response = action === "logout"
      ? await post("/api/auth/logout", {})
      : await fetch(`${url}/api/auth/sessions/${admin.session.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
  } finally { release(); }
  expect((await exporting).status).toBe(403);
  expect(archive.remove).toHaveBeenCalledWith(dataDir, output.id);
  expect(existsSync(join(dataDir, ".backups", output.id))).toBe(false);
  expect(maintenance.active).toBe(false);
});

it("does not broaden maintenance exemptions beyond the three exact session routes", () => {
  for (const [method, path] of [["GET", "/api/auth/sessions"], ["POST", "/api/auth/logout"], ["DELETE", "/api/auth/sessions/fixture-id"]]) expect(isWorkspaceBackupSessionControl(method, path)).toBe(true);
  for (const [method, path] of [["POST", "/api/auth/sessions"], ["GET", "/api/auth/logout"], ["DELETE", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/id/extra"], ["GET", "/api/auth/sessions/"], ["POST", "/api/auth/pairing"], ["PATCH", "/api/settings"]]) expect(isWorkspaceBackupSessionControl(method, path)).toBe(false);
});

it("keeps a validated stage after rejecting a malformed or oversized upload", async () => {
  const uploaded = await fetch(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: "fixture bytes" }).then((response) => response.json()) as { id: string };
  const preview = await post("/api/workspace-backup/preview", { id: uploaded.id, password: PASSWORD }).then((response) => response.json()) as { id: string };
  for (const length of ["0", String(11 * 1024 ** 3)]) {
    const status = await new Promise<number>((resolve, reject) => {
      const upload = request(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-length": length }, signal: AbortSignal.timeout(5000) }, (response) => { response.resume(); resolve(response.statusCode!); });
      upload.on("error", reject);
      upload.end();
    });
    expect(status).toBe(413);
    expect(existsSync(join(dataDir, ".backups", preview.id))).toBe(true);
  }
  expect((await post("/api/workspace-backup/restore", { id: preview.id, confirmation: "REPLACE" })).status).toBe(200);
  expect(archive.commit).toHaveBeenCalledWith(dataDir, preview.id);
});

it("accepts drafts between 1 and 2 MiB and enforces the preference cap in UTF-8 bytes", async () => {
  const clientState = { "seira-drafts": "a".repeat(1536 * 1024) };
  expect((await post("/api/workspace-backup/export", { password: PASSWORD, clientState })).status).toBe(200);
  expect(archive.create.mock.calls[0][1].clientState).toEqual(clientState);
  // Fits the request framing allowance but exceeds the preference byte cap; string.length alone would accept it.
  const tooLarge = { "seira-drafts": "é".repeat(1024 ** 2) };
  const rejected = await post("/api/workspace-backup/export", { password: PASSWORD, clientState: tooLarge });
  expect(rejected.status).toBe(413);
  expect((await rejected.json() as { error: string }).error).toContain("2 MB backup preference limit");
  expect(archive.create).toHaveBeenCalledOnce();
  expect(readdirSync(join(dataDir, ".backups"))).toHaveLength(1);
});

async function stagedRestore() {
  const uploaded = await fetch(`${url}/api/workspace-backup/upload`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: "fixture bytes" }).then((response) => response.json()) as { id: string };
  return await post("/api/workspace-backup/preview", { id: uploaded.id, password: PASSWORD }).then((response) => response.json()) as { id: string };
}

function status() {
  return fetch(`${url}/api/workspace-backup/status`, { headers: { authorization: `Bearer ${admin.token}` } }).then((response) => response.json()) as Promise<Record<string, unknown>>;
}

it("restarts a server its launcher starts again (My Cloud) once a restore commits, after answering", async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const restart = vi.fn();
  await listen({ restart });
  expect(await status()).toMatchObject({ restarts: true, pendingRestore: false });
  const preview = await stagedRestore();
  expect(restart).not.toHaveBeenCalled();
  const restored = await post("/api/workspace-backup/restore", { id: preview.id, confirmation: "REPLACE" });
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ restarting: true, restoreId: preview.id });
  await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  expect(await status()).toMatchObject({ restarts: true, pendingRestore: true });
});

it("leaves the restart to the person where no launcher restarts the server", async () => {
  expect(await status()).not.toHaveProperty("restarts");
  const preview = await stagedRestore();
  const restored = await post("/api/workspace-backup/restore", { id: preview.id, confirmation: "REPLACE" });
  expect(restored.status).toBe(200);
  expect(await restored.json()).not.toHaveProperty("restarting");
  expect(await status()).toMatchObject({ pendingRestore: true });
});

it("clears an old upload leftover that an earlier version named, and keeps a recent one", async () => {
  const uploads = join(dataDir, ".backups", "uploads");
  mkdirSync(uploads, { recursive: true });
  const old = join(uploads, `${randomUUID()}.ombbackup`);
  const recent = join(uploads, `${randomUUID()}.ombbackup`);
  const current = join(uploads, `${randomUUID()}.seirabackup`);
  for (const file of [old, recent, current]) writeFileSync(file, "x");
  const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
  for (const file of [old, current]) utimesSync(file, longAgo, longAgo);
  await listen();
  expect(existsSync(old)).toBe(false);
  expect(existsSync(current)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});

const BASE = "/api/workspace-backup/upload";
const MIB = 1024 ** 2;
const send = (path: string, init: { method?: string; body?: Buffer | string; token?: string } = {}) =>
  fetch(`${url}${path}`, { method: init.method ?? "POST", headers: { authorization: `Bearer ${init.token ?? admin.token}` }, body: init.body });
const startUpload = async (bytes: number) => await send(`${BASE}/start`, { body: JSON.stringify({ bytes }) }).then((response) => response.json()) as { id: string; chunkBytes: number };
const uploadFile = (id: string) => join(dataDir, ".backups", "uploads", `${id}.seirabackup`);
const received = async (id: string) => (await send(`${BASE}/${id}`, { method: "GET" }).then((response) => response.json()) as { received: number }).received;

it("stores ordered parts and hands the joined file to validation", async () => {
  const started = await startUpload(10);
  expect(started.chunkBytes).toBe(32 * MIB);
  for (const [offset, part] of [[0, "abcd"], [4, "efgh"], [8, "ij"]] as const) {
    const response = await send(`${BASE}/${started.id}/chunk?offset=${offset}`, { body: part });
    expect(await response.json()).toEqual({ received: offset + part.length });
  }
  expect(await received(started.id)).toBe(10);
  const finished = await send(`${BASE}/${started.id}/finish`);
  expect(await finished.json()).toEqual({ id: started.id });
  expect((await send(`${BASE}/${started.id}/finish`)).status).toBe(200);
  let joined = "";
  archive.stage.mockImplementationOnce(async (_dataDir: string, file: string) => { joined = readFileSync(file, "utf8"); return fakeArchive(); });
  const preview = await post("/api/workspace-backup/preview", { id: started.id, password: PASSWORD });
  expect(preview.status).toBe(200);
  expect(archive.stage).toHaveBeenCalledWith(dataDir, uploadFile(started.id), expect.anything());
  expect(joined).toBe("abcdefghij");
});

it("checks the checksum a caller sends at finish, and drops the file when it differs", async () => {
  const good = "0".repeat(64);
  const started = await startUpload(4);
  await send(`${BASE}/${started.id}/chunk?offset=0`, { body: "abcd" });
  expect((await send(`${BASE}/${started.id}/finish?sha256=not-hex`)).status).toBe(400);
  expect((await send(`${BASE}/${started.id}/finish?sha256=${good}`)).status).toBe(422);
  expect(existsSync(uploadFile(started.id))).toBe(false);
  expect((await send(`${BASE}/${started.id}/finish`)).status).toBe(404);
  const again = await startUpload(4);
  await send(`${BASE}/${again.id}/chunk?offset=0`, { body: "abcd" });
  const sha256 = createHash("sha256").update("abcd").digest("hex");
  expect((await send(`${BASE}/${again.id}/finish?sha256=${sha256}`)).status).toBe(200);
});

it("returns the checksum of the exported file in the export reply", async () => {
  archive.create.mockImplementationOnce(async () => ({ ...fakeArchive(), sha256: "a".repeat(64) }));
  const exported = await post("/api/workspace-backup/export", { password: PASSWORD }).then((response) => response.json()) as { sha256?: string };
  expect(exported.sha256).toBe("a".repeat(64));
});

it("refuses a part whose offset is not the stored byte count", async () => {
  const started = await startUpload(10);
  await send(`${BASE}/${started.id}/chunk?offset=0`, { body: "abcd" });
  expect((await send(`${BASE}/${started.id}/chunk?offset=0`, { body: "zzzz" })).status).toBe(409);
  expect((await send(`${BASE}/${started.id}/chunk?offset=6`, { body: "zzzz" })).status).toBe(409);
  expect(readFileSync(uploadFile(started.id), "utf8")).toBe("abcd");
  expect(await received(started.id)).toBe(4);
});

it("refuses a part above 32 MiB, a part past the announced size, and a bad total", async () => {
  const started = await startUpload(40 * MIB);
  expect((await send(`${BASE}/${started.id}/chunk?offset=0`, { body: Buffer.alloc(32 * MIB + 1) })).status).toBe(413);
  expect(await received(started.id)).toBe(0);
  const small = await startUpload(3);
  expect((await send(`${BASE}/${small.id}/chunk?offset=0`, { body: "abcd" })).status).toBe(413);
  for (const bytes of [0, 11 * 1024 ** 3]) expect((await send(`${BASE}/start`, { body: JSON.stringify({ bytes }) })).status).toBe(413);
});

it("drops the bytes of a part that ends early so the count stays valid", async () => {
  const started = await startUpload(20);
  await send(`${BASE}/${started.id}/chunk?offset=0`, { body: "abcd" });
  await new Promise<void>((resolve) => {
    const part = request(`${url}${BASE}/${started.id}/chunk?offset=4`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "content-length": "10" } });
    part.on("error", () => resolve());
    part.write("xyz", () => setTimeout(() => part.destroy(), 50));
  });
  await vi.waitFor(() => expect(statSync(uploadFile(started.id)).size).toBe(4));
  expect(await received(started.id)).toBe(4);
  expect((await send(`${BASE}/${started.id}/chunk?offset=4`, { body: "efgh" })).status).toBe(200);
});

it("refuses to finish a short upload and an unknown id", async () => {
  const started = await startUpload(10);
  await send(`${BASE}/${started.id}/chunk?offset=0`, { body: "abcd" });
  expect((await send(`${BASE}/${started.id}/finish`)).status).toBe(400);
  expect((await post("/api/workspace-backup/preview", { id: started.id, password: PASSWORD })).status).toBe(404);
  expect((await send(`${BASE}/${randomUUID()}`, { method: "GET" })).status).toBe(404);
  expect((await send(`${BASE}/${randomUUID()}/chunk?offset=0`, { body: "a" })).status).toBe(404);
  expect((await send(`${BASE}/${randomUUID()}/finish`)).status).toBe(404);
});

it("removes an unfinished upload when a new one starts or when it sits idle for an hour", async () => {
  const first = await startUpload(10);
  await send(`${BASE}/${first.id}/chunk?offset=0`, { body: "abcd" });
  const second = await startUpload(10);
  expect(existsSync(uploadFile(first.id))).toBe(false);
  expect(existsSync(uploadFile(second.id))).toBe(true);
  const later = Date.now() + 61 * 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(later);
  try { expect((await send(`${BASE}/${second.id}`, { method: "GET" })).status).toBe(404); }
  finally { clock.mockRestore(); }
  expect(existsSync(uploadFile(second.id))).toBe(false);
});

it("refuses every upload route to a caller without admin access", async () => {
  const member = sessions.issue({ label: "Fixture member", scopes: ["client"] });
  const started = await startUpload(10);
  for (const [path, method] of [[`${BASE}/start`, "POST"], [`${BASE}/${started.id}/chunk?offset=0`, "POST"], [`${BASE}/${started.id}`, "GET"], [`${BASE}/${started.id}/finish`, "POST"]]) {
    expect((await send(path, { method, body: method === "POST" ? "{}" : undefined, token: member.token })).status).toBe(403);
  }
});

function chunkedPart(path: string, parts: string[]) {
  return new Promise<number>((resolve, reject) => {
    const part = request(`${url}${path}`, { method: "POST", headers: { authorization: `Bearer ${admin.token}`, "transfer-encoding": "chunked" }, signal: AbortSignal.timeout(5000) }, (response) => { response.resume(); resolve(response.statusCode!); });
    part.on("error", reject);
    for (const piece of parts) part.write(piece);
    part.end();
  });
}

it("takes the part size from the URL when a proxy sends the body without Content-Length", async () => {
  const started = await startUpload(10);
  expect(await chunkedPart(`${BASE}/${started.id}/chunk?offset=0&bytes=4`, ["ab", "cd"])).toBe(200);
  expect(await received(started.id)).toBe(4);
  expect(await chunkedPart(`${BASE}/${started.id}/chunk?offset=4&bytes=3`, ["efgh"])).toBe(413);
  expect(await chunkedPart(`${BASE}/${started.id}/chunk?offset=4&bytes=5`, ["ef"])).toBe(400);
  expect(await chunkedPart(`${BASE}/${started.id}/chunk?offset=4`, ["ef"])).toBe(411);
  expect(readFileSync(uploadFile(started.id), "utf8")).toBe("abcd");
  expect(await received(started.id)).toBe(4);
});

it("refuses a part whose Content-Length and bytes differ", async () => {
  const started = await startUpload(10);
  expect((await send(`${BASE}/${started.id}/chunk?offset=0&bytes=3`, { body: "abcd" })).status).toBe(400);
  expect((await send(`${BASE}/${started.id}/chunk?offset=0&bytes=4`, { body: "abcd" })).status).toBe(200);
});

async function exportedDownload() {
  const exported = await post("/api/workspace-backup/export", { password: PASSWORD }).then((response) => response.json()) as { id: string };
  const fetchRange = (range?: string) => fetch(`${url}/api/workspace-backup/download/${exported.id}`, { headers: { authorization: `Bearer ${admin.token}`, ...(range ? { range } : {}) } });
  return fetchRange;
}

it("offers byte ranges on the download", async () => {
  const response = await (await exportedDownload())();
  expect(response.status).toBe(200);
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(await response.text()).toBe("fixture encrypted bytes");
});

it.each([
  ["bytes=0-6", "fixture", "bytes 0-6/23"],
  ["bytes=8-", "encrypted bytes", "bytes 8-22/23"],
  ["bytes=-5", "bytes", "bytes 18-22/23"],
  ["bytes=18-999", "bytes", "bytes 18-22/23"],
])("answers %s with 206 and only those bytes", async (range, body, contentRange) => {
  const response = await (await exportedDownload())(range);
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe(contentRange);
  expect(response.headers.get("content-length")).toBe(String(body.length));
  expect(await response.text()).toBe(body);
});

it.each(["bytes=23-", "bytes=500-600", "bytes=-0"])("answers the unsatisfiable range %s with 416", async (range) => {
  const response = await (await exportedDownload())(range);
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */23");
  await response.arrayBuffer();
});

it("sends the whole file for several ranges at once", async () => {
  const response = await (await exportedDownload())("bytes=0-1,4-5");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("fixture encrypted bytes");
});

it("still refuses a download without a session", async () => {
  const exported = await post("/api/workspace-backup/export", { password: PASSWORD }).then((response) => response.json()) as { id: string };
  const response = await fetch(`${url}/api/workspace-backup/download/${exported.id}`, { headers: { range: "bytes=0-3" } });
  expect(response.status).toBeGreaterThanOrEqual(401);
  await response.arrayBuffer();
});

it("shows how many bots a restore left behind and what needs action in the status, and no path", async () => {
  expect(await status()).toMatchObject({ leftBehind: null, needsAction: null });
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await listen({ restored: { restored: true, id: "11111111-1111-4111-8111-111111111111", leftBehind: { bots: 1, paths: ["C:\\Work"] }, needsAction: [{ kind: "routines-on", count: 2 }] } });
  const shown = await status();
  expect(shown).toMatchObject({ leftBehind: { bots: 1 }, needsAction: [{ kind: "routines-on", count: 2 }] });
  expect(shown.leftBehind).toEqual({ bots: 1 });
  expect(JSON.stringify(shown)).not.toContain("Work");
});

it("keeps an empty list for a new restore with nothing to do, and null for an old receipt", async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await listen({ restored: { restored: true, id: "11111111-1111-4111-8111-111111111111", needsAction: [] } });
  expect((await status()).needsAction).toEqual([]);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await listen({ restored: { restored: true, id: "11111111-1111-4111-8111-111111111111" } });
  expect((await status()).needsAction).toBeNull();
});
