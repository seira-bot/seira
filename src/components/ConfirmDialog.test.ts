// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIRM_LAYER, ConfirmDialog } from "./ConfirmDialog";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

const show = (layer?: string) => flushSync(() => root.render(createElement(ConfirmDialog, {
  open: true, title: "Remove the saved key?", body: "It stays on this computer.", confirmLabel: "Remove", layer, onCancel: () => {}, onConfirm: () => {},
})));
const scrim = () => document.querySelector('[role="alertdialog"]')!.parentElement!;
const layerNumber = (className: string) => Number(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(className)?.[1]);
const layersIn = (file: string) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/z-\[(\d+)\]/g)].map((m) => Number(m[1]));

describe("confirm dialog layer", () => {
  it("opens on its default layer in a portal on <body>, outside the popover that asked for it", () => {
    show();
    expect(scrim().className).toContain(CONFIRM_LAYER);
    expect(scrim().parentElement).toBe(document.body);
  });

  it("sits above the model picker and the provider menu that opens its confirmations", () => {
    const popovers = [...layersIn("./ModelPicker.tsx"), ...layersIn("./ProviderMenu.tsx")];
    expect(Math.max(...popovers)).toBeGreaterThanOrEqual(90);
    expect(layerNumber(CONFIRM_LAYER)).toBeGreaterThan(Math.max(...popovers));
  });

  it("lets a caller choose another layer", () => {
    show("z-[60]");
    expect(scrim().className).toContain("z-[60]");
    expect(scrim().className).not.toContain(CONFIRM_LAYER);
  });
});
