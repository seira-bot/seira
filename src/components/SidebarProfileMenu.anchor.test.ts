import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: {}, routines: [], webhooks: [], routineRuns: [], bots: [] }, dispatch: vi.fn() }) }));
vi.mock("./SidebarPhoneButton", () => ({ useSidebarPhoneStatus: () => ({ kind: "unavailable" }) }));

import { SidebarProfileMenu } from "./SidebarProfileMenu";

beforeEach(() => { vi.stubGlobal("window", { ogb: { updater: {} } }); });
afterEach(() => { vi.unstubAllGlobals(); });

type Props = NonNullable<Parameters<typeof SidebarProfileMenu>[0]>;
const layouts: Array<[string, Props]> = [
  ["the full row", {}],
  ["icon only", { iconOnly: true }],
  ["the rail", { iconOnly: true, rail: true }],
  ["the circle", { iconOnly: true, circle: true }],
];

it.each(layouts)("carries data-ui sidebar.account once in Advanced mode: %s", (_name, props) => {
  const html = renderToStaticMarkup(createElement<Props>(SidebarProfileMenu, props));
  expect(html.match(/data-ui="sidebar\.account"/g)).toHaveLength(1);
});
