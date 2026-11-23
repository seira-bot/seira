import { describe, expect, it } from "vitest";

import { ACCOUNT_ALIAS_REQUIRED, planAccountLink, type LinkableAccount } from "./connector-account-link.ts";

const plan = (accounts: readonly LinkableAccount[], alias?: string) =>
  planAccountLink("gmail", accounts, alias, 10, () => "seira-retry-1");

describe("planAccountLink", () => {
  it("links the first account without a label", () => {
    expect(plan([])).toEqual({ ok: true, alias: undefined, replace: [] });
  });

  it("asks for a label beside a working account", () => {
    expect(plan([{ id: "ca_1", status: "ACTIVE" }])).toEqual({ ok: false, status: 400, error: ACCOUNT_ALIAS_REQUIRED });
    expect(plan([{ id: "ca_1", status: "ACTIVE", usableBySession: true }])).toEqual({ ok: false, status: 400, error: ACCOUNT_ALIAS_REQUIRED });
  });

  it("reconnects without a label when the only ACTIVE account is one the Session cannot use", () => {
    expect(plan([{ id: "ca_1", status: "ACTIVE", usableBySession: false }])).toEqual({ ok: true, alias: "seira-retry-1", replace: [] });
  });

  it("still asks for a label when a usable account sits beside an unusable one", () => {
    expect(plan([
      { id: "ca_1", status: "ACTIVE", usableBySession: false },
      { id: "ca_2", status: "ACTIVE", usableBySession: true },
    ])).toEqual({ ok: false, status: 400, error: ACCOUNT_ALIAS_REQUIRED });
  });

  it("replaces an unusable account that holds the requested label", () => {
    expect(plan([{ id: "ca_1", alias: "Work", status: "ACTIVE", usableBySession: false }], "work"))
      .toEqual({ ok: true, alias: "work", replace: ["ca_1"] });
  });

  it("refuses a label that a usable account holds", () => {
    expect(plan([{ id: "ca_1", alias: "Work", status: "ACTIVE" }], "Work"))
      .toEqual({ ok: false, status: 409, error: 'Account alias "Work" is already in use for gmail' });
  });

  it("counts an unusable ACTIVE account toward the cap", () => {
    const accounts = Array.from({ length: 10 }, (_, index) => ({ id: `ca_${index}`, alias: `a${index}`, status: "ACTIVE", usableBySession: false }));
    expect(plan(accounts, "new")).toEqual({ ok: false, status: 409, error: "gmail already has the maximum of 10 accounts" });
  });
});
