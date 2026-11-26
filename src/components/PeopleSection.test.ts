import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readMembership } from "../lib/membership";
import { grantFor, openFolderDepartments } from "../lib/department-access";
import { accessLine, inviteLink, lastSeenLabel, mergePeople, PeopleTable, peopleFromSessions, PortalPeople, type Person } from "./PeopleSection";

describe("people helpers", () => {
  it("builds an invite link that opens the sign-in page with the address filled in", () => {
    expect(inviteLink("https://acme.agentada.cc/", "Bob@Acme.test")).toBe("https://acme.agentada.cc/pair?email=Bob%40Acme.test");
    expect(inviteLink("https://acme.agentada.cc", "@acme.test")).toBe("https://acme.agentada.cc/pair");
  });

  it("joins the sign-in list with devices and this month's usage, by address", () => {
    const people = mergePeople(
      { admins: ["Ada@Example.test"], members: ["bob@acme.test", "@acme.test", "ada@example.test"] },
      [
        { email: "ada@example.test", lastSeenAt: 1_000 },
        { email: "ADA@example.test", lastSeenAt: 5_000 },
        { label: "phone", lastSeenAt: 9_000 } as { email?: string; lastSeenAt: number },
      ],
      [{ key: "user:ada@example.test", turns: 12, costUsd: 3.5 }, { key: "owner", turns: 1, costUsd: 0.1 }],
    );
    expect(people).toEqual([
      { entry: "ada@example.test", role: "admin", isDomain: false, lastSeenAt: 5_000, devices: 2, turns: 12, costUsd: 3.5 },
      { entry: "bob@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
      { entry: "@acme.test", role: "member", isDomain: true, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
    ]);
    const estimated = mergePeople({ admins: ["ada@example.test"], members: [] }, [], [{ key: "user:ada@example.test", turns: 2, costUsd: 1.5, estimatedUsd: 0.5 }]);
    expect(estimated[0]).toMatchObject({ costUsd: 1.5, estimated: true });
    expect(renderToStaticMarkup(createElement(PeopleTable, { people: estimated, busy: false, onRole() {}, onRemove() {}, onLink() {} }))).toContain("~$1.50");
    expect(lastSeenLabel(null)).toBe("Never");
    expect(lastSeenLabel(Date.now() - 60_000)).toBe("Today");
    expect(lastSeenLabel(Date.parse("2026-09-01T12:00:00Z"), Date.parse("2026-09-10T12:00:00Z"))).toBe("2026-09-01");
  });
});

describe("people table", () => {
  const people: Person[] = [
    { entry: "ada@example.test", role: "admin", isDomain: false, lastSeenAt: null, devices: 2, turns: 12, costUsd: 3.5 },
    { entry: "@acme.test", role: "member", isDomain: true, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
  ];
  const noop = () => {};

  it("shows role chips, devices, spend, and the actions that fit each row", () => {
    const html = renderToStaticMarkup(createElement(PeopleTable, { people, busy: false, onRole: noop, onRemove: noop, onLink: noop }));
    expect(html).toContain("ada@example.test");
    expect(html).toContain("Admin");
    expect(html).toContain("2 device(s)");
    expect(html).toContain("$3.50");
    expect(html).toContain("Never");
    expect(html).toContain("everyone at acme.test");
    expect(html).toContain(">Make user<");
    expect(html).toContain(">Make admin<");
    expect(html).toContain(">Remove<");
    expect(html).toContain('aria-label="Invite link"');
  });

  it("lays the header and every row on one grid, with the access under the person and the actions on a line of their own", () => {
    const html = renderToStaticMarkup(createElement(PeopleTable, { people, busy: false, onRole: noop, onRemove: noop, onLink: noop, onAccess: noop, access: {} }));
    expect(html.startsWith('<div class="grid ')).toBe(true);
    expect(html).toContain("sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]");
    expect(html.match(/col-span-full grid grid-cols-subgrid/g)).toHaveLength(people.length + 1);
    expect(html.match(/data-person-access="true"/g)).toHaveLength(people.length);
    expect(html.match(/data-person-actions="true" class="col-span-full /g)).toHaveLength(people.length);
  });

  it("says so when nobody is on the list", () => {
    expect(renderToStaticMarkup(createElement(PeopleTable, { people: [], busy: false, onRole: noop, onRemove: noop, onLink: noop }))).toContain("Nobody yet");
  });
});

describe("people on a workspace the organisation's Admin manages", () => {
  const url = "https://admin.example.test/people?workspace=acme";

  it("reads who decides membership defensively, defaulting to this server's own list", () => {
    expect(readMembership({ membership: { authority: "portal", pairingCodes: false, peopleUrl: url } })).toEqual({ authority: "portal", pairingCodes: false, peopleUrl: url });
    expect(readMembership({})).toEqual({ authority: "local", pairingCodes: true, peopleUrl: null });
    expect(readMembership(null)).toEqual({ authority: "local", pairingCodes: true, peopleUrl: null });
    for (const peopleUrl of ["javascript:alert(1)", "http://admin.example.test/people", "not a url", 7]) {
      expect(readMembership({ membership: { authority: "portal", peopleUrl } }).peopleUrl, String(peopleUrl)).toBeNull();
    }
  });

  it("lists who signed in, by address, with role from their sessions", () => {
    const people = peopleFromSessions(
      [
        { email: "Bob@acme.test", lastSeenAt: 2_000, scopes: ["client"] },
        { email: "ada@acme.test", lastSeenAt: 1_000, scopes: ["admin", "client"] },
        { email: "bob@acme.test", lastSeenAt: 7_000, scopes: ["client"] },
        { lastSeenAt: 9_000, scopes: ["admin", "client"] },
      ],
      [{ key: "user:bob@acme.test", turns: 3, costUsd: 1.25 }],
    );
    expect(people).toEqual([
      { entry: "ada@acme.test", role: "admin", isDomain: false, lastSeenAt: 1_000, devices: 1, turns: 0, costUsd: null },
      { entry: "bob@acme.test", role: "member", isDomain: false, lastSeenAt: 7_000, devices: 2, turns: 3, costUsd: 1.25 },
    ]);
  });

  it("says where people are managed, links there safely, and offers nothing to edit", () => {
    const people: Person[] = [{ entry: "bob@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 1, turns: 3, costUsd: 1.25 }];
    const html = renderToStaticMarkup(createElement(PortalPeople, { peopleUrl: url, people }));
    expect(html).toContain("data-people-portal");
    expect(html).toContain("People are managed in your organization&#x27;s Admin");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("Manage people in Admin");
    expect(html).toContain("bob@acme.test");
    expect(html).toContain("$1.25");
    expect(html).not.toMatch(/Make admin|Make user|>Remove<|Invite link|<input|<form|pairing code|ends their account sessions/);
    expect(renderToStaticMarkup(createElement(PortalPeople, { peopleUrl: null, people: [] }))).toContain("Nobody has signed in here yet.");
  });
});

describe("each user's access", () => {
  const people: Person[] = [
    { entry: "ada@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
    { entry: "bob@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
    { entry: "cy@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
    { entry: "dee@acme.test", role: "admin", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null },
  ];
  const noop = () => {};
  const grant = { departments: [{ name: "Sales", level: "chat" as const }, { name: "", level: "view" as const }], bots: [{ id: "ani", level: "view" as const }] };

  it("AC-22 shows each user's departments and bots with their levels, or the whole team, and a way to change them", () => {
    const names: Record<string, string> = { ani: "Ani" };
    const html = renderToStaticMarkup(createElement(PeopleTable, {
      people, busy: false, onRole: noop, onRemove: noop, onLink: noop, onAccess: noop, botName: (id) => names[id] ?? id,
      access: { "ada@acme.test": grant, "cy@acme.test": { departments: [], bots: [] } },
    }));
    expect(accessLine(grant, (id) => names[id] ?? id)).toBe("Sales · Can chat, General · Can view, Ani · Can view");
    expect(html).toContain("Sales · Can chat, General · Can view, Ani · Can view</span>");
    expect(html).toContain("No department</span>");
    expect(html.match(/Whole team<\/span>/g)).toHaveLength(2);
    expect(html.match(/>Change access</g)).toHaveLength(3);
  });

  it("shows nothing about access where nobody can be limited", () => {
    const html = renderToStaticMarkup(createElement(PeopleTable, { people, busy: false, onRole: noop, onRemove: noop, onLink: noop }));
    expect(html).not.toMatch(/Whole team|Change access|data-person-access/);
  });

  it("keeps the folder warning of a chosen department", () => {
    expect(openFolderDepartments(["Sales", "Finance"], new Set(["Finance"]))).toEqual(["Sales"]);
  });
});

describe("a user under a domain's departments", () => {
  const ada: Person = { entry: "ada@acme.test", role: "member", isDomain: false, lastSeenAt: null, devices: 0, turns: 0, costUsd: null };
  const noop = () => {};

  it("shows the departments of the domain, as the server applies them, unless the address has its own", () => {
    const only = (name: string) => ({ departments: [{ name, level: "chat" as const }], bots: [] });
    const access = { "@acme.test": only("Sales"), "bob@acme.test": only("Finance") };
    expect(grantFor(access, "ada@acme.test")).toEqual(only("Sales"));
    expect(grantFor(access, "bob@acme.test")).toEqual(only("Finance"));
    expect(grantFor(access, "cy@other.test")).toBeUndefined();
    expect(grantFor(access, "@other.test")).toBeUndefined();
    const html = renderToStaticMarkup(createElement(PeopleTable, { people: [ada], busy: false, onRole: noop, onRemove: noop, onLink: noop, onAccess: noop, access }));
    expect(html).toContain("Sales · Can chat</span>");
    expect(html).not.toContain("Whole team");
  });
});
