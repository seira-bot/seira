// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { AttachmentPreviewDialog } from "./AttachmentPreview";
import { TableDialog } from "./RichTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function render(element: ReturnType<typeof createElement>) {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

/** The dialog sits at 100,100 to 500,400; the rest of the screen is its dim backdrop. */
async function openPreview() {
  const onClose = vi.fn();
  await render(createElement(TableDialog, { title: "notes.md", returnFocus: null, onClose, children: createElement("p", null, "Body text") }));
  const dialog = document.querySelector("dialog")!;
  dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON: () => ({}) });
  return { onClose, dialog, body: document.querySelector("dialog p")! };
}

function press(down: Element, up: Element, x: number, y: number) {
  act(() => {
    down.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y }));
    up.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  });
}

describe("the file and table preview dialog", () => {
  it("closes on a click on the dim area around it", async () => {
    const { onClose, dialog } = await openPreview();
    press(dialog, dialog, 20, 20);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open for a click inside it, on its edge, or a text selection dragged out of it", async () => {
    const { onClose, dialog, body } = await openPreview();
    press(body, body, 200, 200);
    press(dialog, dialog, 100, 250);
    act(() => {
      body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200, clientY: 200 }));
      dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 20, clientY: 20 }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has a 44px close button with the same icon", async () => {
    await openPreview();
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close table"]')!;
    expect(close.className.split(" ")).toContain("size-11");
    expect(close.querySelector("svg")?.getAttribute("width")).toBe("16");
  });
});

describe("the image preview dialog", () => {
  it("has a 44px close button with the same icon", async () => {
    await render(createElement(AttachmentPreviewDialog, { image: { src: "/api/files/shot.png", name: "shot.png" }, onClose: () => {} }));
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')!;
    expect(close.className.split(" ")).toContain("size-11");
    expect(close.querySelector("svg")?.getAttribute("width")).toBe("19");
  });
});
