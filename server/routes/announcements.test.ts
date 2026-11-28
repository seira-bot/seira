import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const counter = vi.hoisted(() => ({ record: vi.fn(() => true) }));
vi.mock("../announcements/counts.ts", async (importOriginal) => ({ ...(await importOriginal<typeof import("../announcements/counts.ts")>()), announcementCounter: () => counter }));
const { announcementRoutes } = await import("./announcements.ts");
const { readBody, json } = await import("../harness/http.ts");

beforeEach(() => { counter.record.mockClear(); });

async function post(body: unknown, method = "POST") {
  const req = Object.assign(Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]), { headers: {}, method });
  const written: { status?: number } = {};
  const res = { headersSent: false, writableEnded: false, writeHead(status: number) { written.status = status; return { end: () => undefined }; } };
  const jsonOut = ((_res: unknown, status: number) => { written.status = status; }) as unknown as typeof json;
  await announcementRoutes({ req: req as never, res: res as never, url: new URL("http://x/api/announcements/events"), path: "/api/announcements/events", method, auth: {} as never, json: jsonOut, readBody });
  return written.status;
}

describe("POST /api/announcements/events", () => {
  it("AC-05 answers 204 for a valid event and hands it to the counter", async () => {
    expect(await post({ id: "card-one", action: "shown" })).toBe(204);
    expect(counter.record).toHaveBeenCalledWith({ id: "card-one", action: "shown" });
  });

  it("AC-06 answers 204 when the counter drops a card the server does not serve", async () => {
    counter.record.mockReturnValueOnce(false);
    expect(await post({ id: "unknown-card", action: "close" })).toBe(204);
  });

  it("AC-06 answers 400 for a wrong shape and queues nothing", async () => {
    expect(await post({ id: "card-one", action: "bought" })).toBe(400);
    expect(await post([])).toBe(400);
    expect(counter.record).not.toHaveBeenCalled();
  });

  it("answers 405 to any other method", async () => {
    expect(await post({ id: "card-one", action: "shown" }, "GET")).toBe(405);
  });
});
