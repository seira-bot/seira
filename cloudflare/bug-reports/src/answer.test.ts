import { describe, expect, it } from "vitest";

import { bugHarness, validReport } from "./test-harness";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

describe("AC-16 a new issue", () => {
  it("answers the id, the number of the new issue and joined false", async () => {
    const h = bugHarness();
    const response = await h.send(validReport());
    expect(response.status).toBe(201);
    const [issue] = [...h.github.issues.values()];
    expect(await response.json()).toEqual({ id: expect.stringMatching(ID), issue: issue!.number, joined: false });
  });

  it("answers a new number for a report with another error", async () => {
    const h = bugHarness();
    const first = await (await h.send(validReport())).json() as { issue: number };
    const other = await (await h.send(validReport({ description: "Another failure.", diagnostics: "TypeError: y is not a function\n    at other (/srv/app/x.js:1:1)" }))).json() as {
      issue: number;
      joined: boolean;
    };
    expect(other.joined).toBe(false);
    expect(other.issue).not.toBe(first.issue);
    expect(h.github.issues.size).toBe(2);
  });
});

describe("AC-17 a comment on an open issue", () => {
  it("answers the number of that issue and joined true", async () => {
    const h = bugHarness();
    const first = await h.sendNumbered(1);
    const second = await h.sendNumbered(2);
    expect(second.response.status).toBe(201);
    expect(second.body).toEqual({ id: expect.stringMatching(ID), issue: first.body.issue, joined: true });
    expect(second.body.id).not.toBe(first.body.id);
    expect(h.github.comments).toHaveLength(1);
    expect(h.github.comments[0]!.issue).toBe(first.body.issue);
  });

  it("answers a new issue with joined false after the first one is closed", async () => {
    const h = bugHarness();
    const first = await h.sendNumbered(1);
    h.github.close(first.body.issue!);
    const second = await h.sendNumbered(2);
    expect(second.body.joined).toBe(false);
    expect(second.body.issue).not.toBe(first.body.issue);
  });
});

describe("AC-18 the same report again", () => {
  it("answers the first id, issue and joined false, and does not call GitHub", async () => {
    const h = bugHarness();
    const first = await (await h.send(validReport())).json();
    const calls = h.github.requests.length;
    const again = await (await h.send(validReport())).json();
    expect(again).toEqual(first);
    expect(h.github.requests).toHaveLength(calls);
  });

  it("answers joined true for a report that joined an issue", async () => {
    const h = bugHarness();
    await h.sendNumbered(1);
    const joined = await h.sendNumbered(2);
    const calls = h.github.requests.length;
    const again = await h.sendNumbered(2);
    expect(again.body).toEqual(joined.body);
    expect(again.body.joined).toBe(true);
    expect(h.github.requests).toHaveLength(calls);
  });
});
