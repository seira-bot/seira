import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import type { Message } from "@/state/store";
import type { BugDraftView } from "../../shared/bug-offer";
import { BugDraftBody, BugDraftPanel, BugOfferLine } from "./BugOffer";
import { ChatErrorBanner } from "./ChatErrorBanner";

afterEach(() => { setLocale("en"); });

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const offered = (bugOffer: NonNullable<Message["bugOffer"]>): Message => ({ id: "m1", role: "bot", kind: "text", text: "Done.", at: 1, bugOffer } as Message);
const line = (message: Message) => renderToStaticMarkup(createElement(BugOfferLine, { message }));
const waiting = { id: "d1", state: "offer", from: "error", by: "Pippa", for: "user" } as const;

const view = (over: Partial<BugDraftView> = {}): BugDraftView => ({
  id: "d1", from: "error", by: "Pippa", state: "offer",
  title: "Reading a sheet fails", description: "Reading one sheet stopped with an error inside Seira.",
  diagnostics: "Seira 0.1.180 on Linux\nstep.fail read-sheet TypeError",
  included: { version: "0.1.180", platform: "Linux", model: "Claude Sonnet 5.5", activity: 12 },
  direct: true, formUrl: "https://github.com/seira-bot/seira/issues/new?title=x", ...over,
});

describe("the bug report offer line", () => {
  it("AC-01: says a bot wrote a report and offers to review it", () => {
    const html = line(offered(waiting));
    expect(text(html)).toBe("Something in Seira broke here. Pippa wrote a bug report.Review report");
    expect(html).toContain('aria-expanded="false"');
  });

  it("AC-11: shows nothing to a person the report is not for", () => {
    expect(line(offered({ ...waiting, for: "someone-else" }))).toBe("");
  });

  it("AC-04: says what became of a sent report, with a link to its issue", () => {
    const sent = line(offered({ ...waiting, state: "sent", issue: 512 }));
    expect(text(sent)).toBe("Bug report sent · #512");
    expect(sent).toContain('href="https://github.com/seira-bot/seira/issues/512"');
    expect(text(line(offered({ ...waiting, state: "joined", issue: 482 })))).toBe("Added to #482 · Already being looked at");
    expect(text(line(offered({ ...waiting, state: "sent" })))).toBe("Bug report sent · Got it, we're looking");
  });

  it("AC-07: says a report saved offline goes on its own", () => {
    expect(text(line(offered({ ...waiting, state: "saved" })))).toBe("Bug report saved · Sends when you're online");
  });

  it("AC-04: lets the fix status win over the offer's state", () => {
    const message = { ...offered({ ...waiting, state: "sent", issue: 512 }), bugReport: { id: "r1", status: "fixed", fixedIn: "0.1.181", running: true } } as Message;
    expect(text(line(message))).toBe("Bug report · Fixed in 0.1.181");
  });

  it("AC-10: leaves a failed turn's row to its own button", () => {
    expect(renderToStaticMarkup(createElement(BugOfferLine, { message: offered(waiting), hideOfferLine: true }))).toBe("");
  });
});

describe("the draft", () => {
  it("AC-06: opens in place, never as a dialog", () => {
    const html = renderToStaticMarkup(createElement(BugDraftPanel, { initialView: view(), onClose: () => undefined }));
    expect(html).toContain('role="region"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(text(html)).toContain("Bug report from Pippa");
    expect(text(html)).toContain("Send report");
    expect(text(html)).toContain("Not now");
  });

  it("AC-08: shows the full issue text only in Advanced mode", () => {
    const body = (advanced: boolean) => renderToStaticMarkup(createElement(BugDraftBody, { view: view(), advanced }));
    expect(body(true)).toContain("step.fail read-sheet TypeError");
    expect(text(body(true))).toContain("The issue as it will appear");
    expect(body(false)).not.toContain("step.fail read-sheet TypeError");
    expect(text(body(false))).not.toContain("The issue as it will appear");
  });

  it("AC-09: says what the person wrote when they asked for the report", () => {
    const asked = text(renderToStaticMarkup(createElement(BugDraftBody, { view: view({ from: "devs" }), advanced: false })));
    expect(asked).toContain("What you wrote");
    expect(asked).toContain("Never included: your other messages, your files, or your account.");
    const own = text(renderToStaticMarkup(createElement(BugDraftBody, { view: view(), advanced: false })));
    expect(own).toContain("What went wrong");
    expect(own).toContain("Never included: your messages, your files, or your account.");
  });

  it("AC-03: joins an open report about the same error", () => {
    const html = text(renderToStaticMarkup(createElement(BugDraftBody, { view: view({ same: { title: "Reading a sheet fails on merged cells", at: 1, issue: 482 } }), advanced: false })));
    expect(html).toContain("Already reported");
    expect(html).toContain("#482 Reading a sheet fails on merged cells");
    expect(html).toContain("Add my report");
    expect(html).not.toContain("Send report");
  });

  it("AC-05: links to GitHub when no relay takes the report", () => {
    const html = renderToStaticMarkup(createElement(BugDraftBody, { view: view({ direct: false }), advanced: false }));
    expect(html).toContain('href="https://github.com/seira-bot/seira/issues/new?title=x"');
    expect(text(html)).toContain("Open on GitHub");
    expect(text(html)).not.toContain("Send report");
  });
});

describe("the error banner's report", () => {
  const banner = (message: string) => text(renderToStaticMarkup(createElement(ChatErrorBanner, { message, threadId: "t1", onDismiss: () => undefined })));

  it("AC-02: offers a report only for an error that is Seira's own", () => {
    expect(banner("You are signed out. Sign in again.")).not.toContain("Review report");
    expect(banner("TypeError: Cannot read properties of undefined (reading 'rows')")).toContain("Review report");
    expect(text(renderToStaticMarkup(createElement(ChatErrorBanner, { message: "TypeError: Cannot read properties of undefined (reading 'rows')", onDismiss: () => undefined })))).not.toContain("Review report");
  });
});
