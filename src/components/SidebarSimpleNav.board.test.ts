import { readFileSync } from "node:fs";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), activeView: "chat" }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { activeView: fixture.activeView }, dispatch: fixture.dispatch }) }));
vi.mock("./SidebarFooterNav", () => ({ useAutomationsNeedYou: () => false }));

import { SimpleAutomationsRow, SimpleBoardRow } from "./SidebarSimpleNav";

beforeEach(() => { fixture.dispatch.mockReset(); fixture.activeView = "chat"; });

describe("Simple's Board row", () => {
  it("sits right before Automations", () => {
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement(SimpleBoardRow), createElement(SimpleAutomationsRow)));
    expect(html.indexOf("data-sidebar-board")).toBeGreaterThan(-1);
    expect(html.indexOf("data-sidebar-board")).toBeLessThan(html.indexOf("data-sidebar-automations"));
    expect(html).toContain(">Board<");
  });

  it("is current only on the Board", () => {
    expect(renderToStaticMarkup(createElement(SimpleBoardRow))).not.toContain("aria-current");
    fixture.activeView = "board";
    expect(renderToStaticMarkup(createElement(SimpleBoardRow))).toContain('aria-current="true"');
  });

  it("is drawn before Automations in the sidebar", () => {
    const source = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    expect(source.indexOf("<SimpleBoardRow />")).toBeGreaterThan(-1);
    expect(source.indexOf("<SimpleBoardRow />")).toBeLessThan(source.indexOf("<SimpleAutomationsRow />"));
  });
});
