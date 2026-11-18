import { describe, expect, it } from "vitest";

import { createTicketStore } from "./tickets.ts";

const input = { caller: "owner", profileId: "chrome:Default", sites: new Map([["example.com", [".example.com"]]]) };

describe("import tickets", () => {
  it("works once for the caller that asked", () => {
    const tickets = createTicketStore(() => 0);
    const id = tickets.issue(input);
    expect(tickets.take(id, "owner")).toMatchObject({ profileId: "chrome:Default", expiresAt: 300_000 });
    expect(tickets.take(id, "owner")).toBeNull();
  });

  it("refuses an unknown id, another caller, and a ticket older than 5 minutes", () => {
    let now = 0;
    const tickets = createTicketStore(() => now);
    expect(tickets.take("nope", "owner")).toBeNull();
    const id = tickets.issue(input);
    expect(tickets.take(id, "someone-else")).toBeNull();
    now = 299_999;
    expect(tickets.take(id, "owner")).not.toBeNull();
    const late = tickets.issue(input);
    now += 300_000;
    expect(tickets.take(late, "owner")).toBeNull();
  });

  it("keeps a bounded number of open tickets", () => {
    const tickets = createTicketStore(() => 0);
    const first = tickets.issue(input);
    for (let index = 0; index < 60; index += 1) tickets.issue(input);
    expect(tickets.take(first, "owner")).toBeNull();
  });
});
