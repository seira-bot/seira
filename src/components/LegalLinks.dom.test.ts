// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import { LegalLinks } from "./LegalLinks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  Reflect.deleteProperty(window, "ogb");
  document.body.innerHTML = "";
});

it("opens the Privacy Policy and the Terms of Service on seira.bot in the browser", async () => {
  const openExternal = vi.fn(async (_url: string) => {});
  Object.assign(window, { ogb: { openExternal } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root.render(createElement(LegalLinks)); });
  const links = [...document.querySelectorAll<HTMLButtonElement>("[data-legal-link]")];
  expect(links.map((link) => link.textContent)).toEqual(["Privacy Policy", "Terms of Service"]);
  for (const link of links) await act(async () => { link.click(); });
  expect(openExternal.mock.calls.map(([url]) => url)).toEqual(["https://seira.bot/privacy", "https://seira.bot/terms"]);
  act(() => root.unmount());
});
