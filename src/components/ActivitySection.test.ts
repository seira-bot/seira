import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVITY_WHATS, activityQuery, describeEntry, formatValue, whoLabel, type ActivityEntry } from "@/lib/activity";
import { setLocale } from "@/lib/i18n";
import { ActivityRow } from "./ActivitySection";

afterEach(() => setLocale("en"));

const visibility: ActivityEntry = {
  type: "admin", at: "2026-09-21T09:00:00.000Z", who: "boss@example.test", what: "visibility", action: "visibility.update",
  target: { kind: "bot", id: "b1", name: "Payroll" }, changed: ["visibility"], before: { visibility: "everyone" }, after: { visibility: { people: ["ada@example.test"] } },
};
const approval: ActivityEntry = {
  type: "approval", at: "2026-09-20T11:00:00.000Z", who: "ada@example.test", what: "user-approved", source: "user", bot: "Ops", tool: "Bash", summary: "echo hi", threadId: "t1",
};

describe("activity helpers", () => {
  it("builds the query the list and the CSV share, leaving empty filters out", () => {
    expect(activityQuery({ who: "", what: "all", from: "", to: "" })).toBe("");
    expect(activityQuery({ who: " ada ", what: "visibility", from: "2026-09-01", to: "2026-09-30" }))
      .toBe("?who=ada&what=visibility&from=2026-09-01&to=2026-09-30");
  });

  it("says what happened in the reader's words", () => {
    expect(describeEntry(visibility)).toBe("Changed who can see a bot: Payroll");
    expect(describeEntry(approval)).toBe("Approved: Bash in Ops");
    expect(describeEntry({ ...visibility, action: "future.thing", target: undefined })).toBe("future.thing");
    expect(whoLabel("Command line")).toBe("Command line");
    expect(whoLabel("")).toBe("—");
    expect(formatValue({ people: ["ada@example.test"] })).toBe('{"people":["ada@example.test"]}');
    expect(formatValue(null)).toBe("—");
  });
});

const handoff: ActivityEntry = {
  type: "admin", at: "2026-09-22T10:00:00.000Z", who: "Studio Seira (another Seira)", what: "linked-server", action: "linked-server.handoff",
  target: { kind: "linked-server", id: "0123456789abcdef", name: "Studio Seira" }, after: { direction: "received", state: "done" },
};

describe("linked places in the activity list", () => {
  it("filters on its own category", () => {
    expect(ACTIVITY_WHATS).toContain("linked-server");
    expect(activityQuery({ who: "", what: "linked-server", from: "", to: "" })).toBe("?what=linked-server");
  });

  it("says what happened to a link in plain words, for each step the server records", () => {
    const say = (action: string) => describeEntry({ ...handoff, action });
    expect(say("linked-server.invite")).toBe("Made an invite for a link: Studio Seira");
    expect(say("linked-server.join")).toBe("Joined another Seira: Studio Seira");
    expect(say("linked-server.accept")).toBe("Another Seira joined with an invite: Studio Seira");
    expect(say("linked-server.update")).toBe("Changed a link: Studio Seira");
    expect(say("linked-server.remove")).toBe("Removed a link: Studio Seira");
    expect(say("linked-server.handoff")).toBe("Passed work over a link: Studio Seira");
    expect(say("linked-server.refused")).toBe("Refused work from a link: Studio Seira");
    expect(say("linked-server.a2a-add")).toBe("Added an A2A agent: Studio Seira");
    expect(say("linked-server.token-rotate")).toBe("Made a new token for an A2A agent: Studio Seira");
  });

  it("names the other side as the actor of its own hand-offs", () => {
    expect(whoLabel("Studio Seira (another Seira)")).toBe("Studio Seira (another Seira)");
    expect(whoLabel("Another Seira")).toBe("Another Seira");
    expect(whoLabel("Planner (A2A agent)")).toBe("Planner (A2A agent)");
    expect(whoLabel("An A2A agent")).toBe("An A2A agent");
    expect(whoLabel("boss@example.test")).toBe("boss@example.test");
  });

  it("shows the row with the other side and the label", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { entry: handoff }));
    expect(html).toContain("Studio Seira (another Seira)");
    expect(html).toContain("Passed work over a link: Studio Seira");
  });
});

describe("activity row", () => {
  it("shows who did what and offers the changed values", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { entry: visibility }));
    expect(html).toContain("boss@example.test");
    expect(html).toContain("Changed who can see a bot: Payroll");
    expect(html).toContain("Changed: visibility");
    expect(html).toContain('aria-expanded="false"');
  });

  it("shows an answered card with its summary", () => {
    const html = renderToStaticMarkup(createElement(ActivityRow, { entry: approval }));
    expect(html).toContain("Approved: Bash in Ops");
    expect(html).toContain("echo hi");
    expect(html).not.toContain("aria-expanded");
  });
});
