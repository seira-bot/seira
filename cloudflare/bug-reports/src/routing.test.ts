import { describe, expect, it } from "vitest";

import worker from "./index";
import { bugHarness } from "./test-harness";

describe("routing", () => {
  it("answers GET /health", async () => {
    const h = bugHarness();
    const response = await h.call("/health");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("answers /health through the exported handler", async () => {
    const h = bugHarness();
    const response = await worker.fetch(new Request("https://bugs.test/health"), h.env);
    expect(response.status).toBe(200);
  });

  it.each(["/api/bug-reports", "/api/bug-reports/status"])("answers 405 with Allow for GET %s", async (path) => {
    const h = bugHarness();
    for (const method of ["GET", "PUT", "DELETE"]) {
      const response = await h.call(path, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });

  it("answers 404 for another path", async () => {
    const h = bugHarness();
    const response = await h.call("/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toHaveProperty("error");
  });

  it("answers 500 without details when the database fails", async () => {
    const h = bugHarness({ DB: { prepare: () => { throw new Error("secret detail"); } } as never });
    const response = await h.send({ installId: "i", source: "bot", description: "d", appVersion: "1", platform: "p", diagnostics: "" });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret detail");
  });
});
