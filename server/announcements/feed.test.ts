import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCEMENTS_URL, CLOUD_ANNOUNCEMENTS_URL, MAX_CARDS, type AnnouncementFeed } from "../../shared/announcements.ts";
import {
  ANNOUNCEMENTS_DISABLE_ENV, ANNOUNCEMENTS_RETRY_MS, ANNOUNCEMENTS_TTL_MS, AnnouncementStore, announcementsCachePath, BUNDLED_ANNOUNCEMENTS,
  cloudAnnouncementStore, EMPTY_ANNOUNCEMENTS, mergeAnnouncementCards,
} from "./feed.ts";

const NOW = Date.parse("2026-12-01T10:00:00Z");
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), "seira-announcements-")); scratch.push(dir); return dir; };
const card = (id: string, extra: Record<string, unknown> = {}) => ({
  id, kind: "product", title: "Title", body: "Body.", primary: { label: "Open", action: { open_url: "https://example.com/" } }, ends: "2026-12-31T00:00:00Z", ...extra,
});
const feed = (updatedAt: string, cards: unknown[]): AnnouncementFeed => ({ version: 1, updatedAt, cards: cards as AnnouncementFeed["cards"] });
const bundled = feed("2026-11-01T00:00:00Z", []);
const answer = (body: unknown, init: ResponseInit = { status: 200 }) => new Response(typeof body === "string" ? body : JSON.stringify(body), init);

function subject(options: { fetch?: typeof fetch; dir?: string; env?: NodeJS.ProcessEnv; bundled?: AnnouncementFeed } = {}) {
  let time = NOW;
  const log = vi.fn();
  const store = new AnnouncementStore({ dataDir: options.dir ?? dataDir(), bundled: options.bundled ?? bundled, now: () => time, log, env: options.env ?? {}, fetch: options.fetch });
  return { store, log, advance: (ms: number) => { time += ms; } };
}

it("bundles the repository's file, and never fetches while switched off", async () => {
  expect(BUNDLED_ANNOUNCEMENTS.version).toBe(1);
  const fetchMock = vi.fn();
  const { store } = subject({ fetch: fetchMock, env: { [ANNOUNCEMENTS_DISABLE_ENV]: "1" }, bundled: feed("2026-11-01T00:00:00Z", [card("bundled-card")]) });
  expect(await store.cardsForPage()).toEqual([]);
  await store.refresh({ force: true });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(store.disabled).toBe(true);
});

it("tests never reach the network: the suite switches it off for every server it starts", () => {
  expect(process.env[ANNOUNCEMENTS_DISABLE_ENV]).toBe("1");
});

describe("downloading the file", () => {
  it("asks main's raw file with a plain GET, nothing of the person's sent, and keeps what it got", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => answer(feed("2026-12-01T09:00:00Z", [card("phone-app")])));
    const dir = dataDir();
    const { store } = subject({ fetch: fetchMock as unknown as typeof fetch, dir });
    expect((await store.cardsForPage()).map((entry) => entry.id)).toEqual(["phone-app"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(ANNOUNCEMENTS_URL);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(Object.keys(init!.headers as Record<string, string>).sort()).toEqual(["accept", "user-agent"]);
    expect(url).not.toMatch(/[?#]/);
    expect(existsSync(announcementsCachePath(dir))).toBe(true);
    // A later start reads the copy on disk before any download.
    expect(subject({ dir, fetch: vi.fn() }).store.cards().map((entry) => entry.id)).toEqual(["phone-app"]);
  });

  it("fetches at most hourly, however many pages ask", async () => {
    const fetchMock = vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", [])));
    const { store, advance } = subject({ fetch: fetchMock as unknown as typeof fetch });
    await Promise.all([store.cardsForPage(), store.cardsForPage(), store.cardsForPage()]);
    advance(ANNOUNCEMENTS_TTL_MS - 1000);
    await store.cardsForPage();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(2000);
    await store.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("offline, rate-limited, too large, slow or not JSON: keeps the last good copy, says nothing to the page, retries later", async () => {
    const dir = dataDir();
    mkdirSync(dirname(announcementsCachePath(dir)), { recursive: true });
    writeFileSync(announcementsCachePath(dir), JSON.stringify({ fetchedAtMs: NOW - ANNOUNCEMENTS_TTL_MS * 2, feed: feed("2026-11-20T00:00:00Z", [card("kept")]) }));
    const failures: Array<() => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => answer("rate limited", { status: 429 }),
      async () => answer("x".repeat(70 * 1024)),
      async () => answer("<html>"),
      async () => answer({ version: 2, updatedAt: "2026-12-01T00:00:00Z", cards: [] }),
    ];
    for (const failure of failures) {
      const { store, log } = subject({ dir, fetch: vi.fn(failure) as unknown as typeof fetch });
      expect((await store.cardsForPage()).map((entry) => entry.id), "the page is not kept waiting on a copy it has").toEqual(["kept"]);
      await store.refresh();
      expect(store.cards().map((entry) => entry.id)).toEqual(["kept"]);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/keeping the current copy/));
    }
    const fetchMock = vi.fn(async () => { throw new Error("offline"); });
    const { store, advance } = subject({ dir, fetch: fetchMock as unknown as typeof fetch });
    await store.refresh();
    await store.refresh();
    expect(fetchMock, "backs off after a failure").toHaveBeenCalledTimes(1);
    advance(ANNOUNCEMENTS_RETRY_MS + 1);
    await store.refresh();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a page's first ask waits a moment for the first download, never longer", async () => {
    const hanging = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const { store } = subject({ fetch: hanging as unknown as typeof fetch });
    const started = Date.now();
    expect(await store.cardsForPage(50)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an older copy from GitHub's cache cannot bring back a card a newer one removed", async () => {
    const dir = dataDir();
    const newer = subject({ dir, fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", []))) as unknown as typeof fetch });
    await newer.store.refresh();
    const stale = subject({ dir, fetch: vi.fn(async () => answer(feed("2026-11-30T00:00:00Z", [card("pulled-back")]))) as unknown as typeof fetch });
    expect(await stale.store.cardsForPage()).toEqual([]);
    expect(JSON.parse(readFileSync(announcementsCachePath(dir), "utf8")).feed.updatedAt).toBe("2026-12-01T09:00:00Z");
  });

  it("skips a card it cannot read and one whose time has passed, and shows the rest", async () => {
    const cards = [card("good"), card("bad", { primary: { label: "Go", action: { run: "x" } } }), card("over", { ends: "2026-11-30T00:00:00Z" })];
    const { store, log } = subject({ fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", cards))) as unknown as typeof fetch });
    expect((await store.cardsForPage()).map((entry) => entry.id)).toEqual(["good"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipping cards\.1/));
  });
});

function cloudSubject(options: { fetch?: typeof fetch; dir?: string; env?: NodeJS.ProcessEnv } = {}) {
  let time = NOW;
  const log = vi.fn();
  const store = new AnnouncementStore({
    dataDir: options.dir ?? dataDir(), url: CLOUD_ANNOUNCEMENTS_URL, cacheFile: "cloud.json", logName: "announcements:cloud",
    bundled: EMPTY_ANNOUNCEMENTS, now: () => time, log, env: options.env ?? {}, fetch: options.fetch,
  });
  return { store, log, advance: (ms: number) => { time += ms; } };
}

describe("the Seira Cloud feed", () => {
  it("downloads the Cloud address anonymously, keeps it in cloud.json and reads it again after a restart", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => answer(feed("2026-12-01T09:00:00Z", [card("from-cloud", { image: { mark: "claude" } })])));
    const dir = dataDir();
    const { store } = cloudSubject({ fetch: fetchMock as unknown as typeof fetch, dir });
    expect((await store.cardsForPage()).map((entry) => entry.id)).toEqual(["from-cloud"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CLOUD_ANNOUNCEMENTS_URL);
    expect(url).not.toMatch(/[?#]/);
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(Object.keys(init!.headers as Record<string, string>).sort()).toEqual(["accept", "user-agent"]);
    expect(existsSync(announcementsCachePath(dir, "cloud.json"))).toBe(true);
    expect(existsSync(announcementsCachePath(dir))).toBe(false);
    const restarted = cloudSubject({ dir, fetch: vi.fn() as unknown as typeof fetch });
    expect(restarted.store.cards().map((entry) => entry.id)).toEqual(["from-cloud"]);
    const failing = cloudSubject({ dir, fetch: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    await failing.store.refresh({ force: true });
    expect(failing.log).toHaveBeenCalledWith(expect.stringMatching(/^\[announcements:cloud\] /));
  });

  it("a failing, slow, redirecting, oversized or misshapen Cloud answer keeps the last good Cloud copy, and the project's cards still come", async () => {
    const dir = dataDir();
    mkdirSync(dirname(announcementsCachePath(dir, "cloud.json")), { recursive: true });
    writeFileSync(announcementsCachePath(dir, "cloud.json"), JSON.stringify({ fetchedAtMs: NOW - ANNOUNCEMENTS_TTL_MS * 2, feed: feed("2026-11-20T00:00:00Z", [card("cloud-kept")]) }));
    const hanging = (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const failures: Array<(url: unknown, init?: RequestInit) => Promise<Response>> = [
      async () => { throw new TypeError("fetch failed"); },
      async () => { throw new TypeError("redirect mode is set to error"); },
      async () => answer("down", { status: 503 }),
      async () => answer("x".repeat(70 * 1024)),
      async () => answer({ version: 2, updatedAt: "2026-12-01T00:00:00Z", cards: [] }),
      async () => answer("<html>"),
      hanging,
    ];
    for (const failure of failures) {
      const cloud = new AnnouncementStore({
        dataDir: dir, url: CLOUD_ANNOUNCEMENTS_URL, cacheFile: "cloud.json", bundled: EMPTY_ANNOUNCEMENTS, now: () => NOW, log: vi.fn(), env: {},
        fetch: vi.fn(failure) as unknown as typeof fetch, timeoutMs: 20,
      });
      const project = subject({ fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", [card("project-card")]))) as unknown as typeof fetch });
      const [cloudCards, projectCards] = await Promise.all([cloud.cardsForPage(), project.store.cardsForPage()]);
      expect(mergeAnnouncementCards(cloudCards, projectCards).map((entry) => entry.id)).toEqual(["cloud-kept", "project-card"]);
      await cloud.refresh({ force: true });
      expect(cloud.cards().map((entry) => entry.id)).toEqual(["cloud-kept"]);
    }
  });

  it("ignores a Cloud copy older than the one it holds", async () => {
    const dir = dataDir();
    const newer = cloudSubject({ dir, fetch: vi.fn(async () => answer(feed("2026-12-01T09:00:00Z", []))) as unknown as typeof fetch });
    await newer.store.refresh();
    const stale = cloudSubject({ dir, fetch: vi.fn(async () => answer(feed("2026-11-30T00:00:00Z", [card("pulled-back")]))) as unknown as typeof fetch });
    expect(await stale.store.cardsForPage()).toEqual([]);
    expect(JSON.parse(readFileSync(announcementsCachePath(dir, "cloud.json"), "utf8")).feed.updatedAt).toBe("2026-12-01T09:00:00Z");
  });

  it("switched off, it never fetches and gives no cards", async () => {
    const fetchMock = vi.fn();
    const { store } = cloudSubject({ fetch: fetchMock, env: { [ANNOUNCEMENTS_DISABLE_ENV]: "1" } });
    expect(await store.cardsForPage()).toEqual([]);
    await store.refresh({ force: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges Cloud cards first, drops a repeated id and keeps at most the card limit", () => {
    const ids = (cards: Array<{ id: string }>) => cards.map((entry) => entry.id);
    const make = (id: string) => card(id) as unknown as AnnouncementFeed["cards"][number];
    expect(ids(mergeAnnouncementCards([make("c1"), make("shared")], [make("shared"), make("p1")]))).toEqual(["c1", "shared", "p1"]);
    const many = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => make(`${prefix}${index}`));
    const merged = mergeAnnouncementCards(many("c", 15), many("p", 15));
    expect(merged).toHaveLength(MAX_CARDS);
    expect(ids(merged).slice(0, 15)).toEqual(ids(many("c", 15)));
  });
});

describe("GET /api/announcements", () => {
  it("answers with the cards, and is open to every signed-in page", async () => {
    const { announcementRoutes, ANNOUNCEMENTS_PATH } = await import("../routes/announcements.ts");
    const { PASS } = await import("../routes/table.ts");
    const { requiredScope } = await import("../request-auth.ts");
    const sent: Array<{ status: number; body: unknown }> = [];
    const json = ((_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); }) as never;
    const context = (method: string, path: string) => ({ req: {} as never, res: {} as never, url: new URL(`http://x${path}`), path, method, auth: {} as never, json, readBody: (async () => ({})) as never });
    expect(await announcementRoutes(context("GET", "/api/other"))).toBe(PASS);
    await announcementRoutes(context("GET", ANNOUNCEMENTS_PATH));
    expect(sent[0]).toEqual({ status: 200, body: { cards: [], disabled: true } });
    await announcementRoutes(context("POST", ANNOUNCEMENTS_PATH));
    expect(sent[1]!.status).toBe(405);
    expect(requiredScope("GET", ANNOUNCEMENTS_PATH)).toBe("client");
    expect(requiredScope("POST", ANNOUNCEMENTS_PATH)).toBe("admin");
  });

  it("answers with the merged cards and the newer of the two dates", async () => {
    const { announcementRoutes, ANNOUNCEMENTS_PATH } = await import("../routes/announcements.ts");
    const cloud = cloudAnnouncementStore();
    vi.spyOn(AnnouncementStore.prototype, "disabled", "get").mockReturnValue(false);
    vi.spyOn(AnnouncementStore.prototype, "cardsForPage").mockImplementation(async function (this: AnnouncementStore) {
      return (this === cloud ? [card("cloud-card"), card("shared")] : [card("shared"), card("project-card")]) as AnnouncementFeed["cards"];
    });
    const dates = (cloudDate: string, projectDate: string) =>
      vi.spyOn(AnnouncementStore.prototype, "current").mockImplementation(function (this: AnnouncementStore) {
        return feed(this === cloud ? cloudDate : projectDate, []);
      });
    const sent: Array<{ status: number; body: unknown }> = [];
    const json = ((_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); }) as never;
    const context = { req: {} as never, res: {} as never, url: new URL(`http://x${ANNOUNCEMENTS_PATH}`), path: ANNOUNCEMENTS_PATH, method: "GET", auth: {} as never, json, readBody: (async () => ({})) as never };
    const spy = dates("2026-12-02T00:00:00Z", "2026-12-01T00:00:00Z");
    await announcementRoutes(context);
    spy.mockRestore();
    dates("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z");
    await announcementRoutes(context);
    const body = (index: number) => sent[index]!.body as { cards: Array<{ id: string }>; updatedAt: string };
    expect(body(0).cards.map((entry) => entry.id)).toEqual(["cloud-card", "shared", "project-card"]);
    expect(body(0).updatedAt).toBe("2026-12-02T00:00:00Z");
    expect(body(1).updatedAt).toBe("2026-12-01T00:00:00Z");
  });
});
