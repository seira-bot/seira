import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { finishKeyFocus, openKeySettings, useKeyFocus } from "./key-focus";

function asked() {
  let request: ReturnType<typeof useKeyFocus> = null;
  renderToStaticMarkup(createElement(() => { request = useKeyFocus(); return null; }));
  return request as ReturnType<typeof useKeyFocus>;
}

it("opens the keys page at a key's own row", () => {
  expect(openKeySettings("box")).toEqual({ type: "toggleAppSettings", open: true, section: "connections" });
  const request = asked();
  expect(request).toMatchObject({ id: "box", row: "box" });
  finishKeyFocus(request!);
  expect(asked()).toBeNull();
});

it("opens Routing or Images for a key whose field is there, and asks the keys page for nothing", () => {
  for (const id of ["jev", "openrouterHelper", "workersAi", "customDecider"] as const) {
    expect(openKeySettings(id), id).toEqual({ type: "toggleAppSettings", open: true, section: "decisionModel" });
  }
  for (const id of ["imageOpenai", "imageGemini", "imageCustom"] as const) {
    expect(openKeySettings(id), id).toEqual({ type: "toggleAppSettings", open: true, section: "imageGeneration" });
  }
  expect(asked()).toBeNull();
  expect(openKeySettings("openrouter")).toEqual({ type: "toggleAppSettings", open: true, section: "connections" });
});
