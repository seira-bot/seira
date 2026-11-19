import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { setLocale } from "@/lib/i18n";
import { StoreContext, type Message } from "@/state/store";
import { StatusActivityRow } from "./StatusActivityRow";

afterEach(() => { setLocale("en"); });

const FORM = "https://github.com/seira-bot/seira/issues/new?template=bug_report.yml&title=Pictures+never+load&what-happened=It+broke";
const notice = (bugReportUrl?: string): Message => ({ id: "n1", role: "bot", kind: "activity", at: 2,
  tool: { name: "notice: Your bug report is ready. Open it on GitHub, check the text, and submit it there.", ok: true, ...(bugReportUrl ? { bugReportUrl } : {}) } } as Message);
const render = (message: Message) => renderToStaticMarkup(createElement(StoreContext.Provider, { value: { state: {}, dispatch: () => {} } as never },
  createElement(StatusActivityRow, { message })));

describe("a notice that carries a prefilled bug report", () => {
  it("offers an Open on GitHub link that opens in a new window", () => {
    const html = render(notice(FORM));
    expect(html).toContain("Your bug report is ready.");
    expect(html).toMatch(/<a [^>]*href="https:\/\/github\.com\/seira-bot\/seira\/issues\/new\?template=bug_report\.yml&amp;title=Pictures\+never\+load&amp;what-happened=It\+broke"/);
    expect(html).toMatch(/<a [^>]*target="_blank"/);
    expect(html).toMatch(/<a [^>]*rel="noreferrer"/);
    expect(html).toContain(">Open on GitHub</a>");
    expect(html).not.toContain("template=bug_report.yml</");
  });

  it("follows the app's language", () => {
    setLocale("de");
    expect(render(notice(FORM))).toContain(">Auf GitHub öffnen</a>");
  });

  it("shows no link for an address outside the Seira issue form, and no link without an address", () => {
    for (const bad of ["https://evil.example/x", "https://github.com/other/repo/issues/new?template=bug_report.yml", "javascript:alert(1)", "https://github.com/seira-bot/seira/issues/new"]) {
      const html = render(notice(bad));
      expect(html, bad).toContain("Your bug report is ready.");
      expect(html, bad).not.toContain("<a ");
    }
    expect(render(notice())).not.toContain("<a ");
  });
});
