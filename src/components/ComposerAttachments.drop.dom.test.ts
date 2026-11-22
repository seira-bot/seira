// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Attachment } from "@/lib/composer-attachments";
import { ComposerAttachments } from "./ComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fileDrop = () => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files: [new File(["x"], "cat.png", { type: "image/png" })] },
  });
  return event;
};

let host: HTMLDivElement;
let root: Root;
let uploadImage: Mock<(file: File) => Promise<Attachment | null>>;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  uploadImage = vi.fn(async (_file: File) => null);
  const noop = () => {};
  await act(async () => {
    root.render(createElement(ComposerAttachments, {
      items: [], onAdd: noop, onRemove: noop, onChangeCitation: noop, onDisplayInChatBox: noop,
      notice: null, onNotice: noop, uploadImage,
    }));
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a file dropped anywhere in the window", () => {
  it("attaches to the message when nothing else takes it", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    await act(async () => { target.dispatchEvent(fileDrop()); });
    expect(uploadImage).toHaveBeenCalledTimes(1);
    target.remove();
  });

  it("stays out of the message when a drop zone on the page took it, such as the avatar editor", async () => {
    const zone = document.createElement("div");
    zone.addEventListener("drop", (event) => event.preventDefault());
    document.body.append(zone);
    await act(async () => { zone.dispatchEvent(fileDrop()); });
    expect(uploadImage).not.toHaveBeenCalled();
    zone.remove();
  });
});
