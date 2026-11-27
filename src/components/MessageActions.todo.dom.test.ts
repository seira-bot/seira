// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageActions, MESSAGE_ROW, type MessageMenuItem } from "./MessageActions";

const picked = vi.fn();
const items: MessageMenuItem[] = [
  { key: "todo-selection", icon: null, label: "From selection", selectionOnly: true, onSelect: picked },
  { key: "todo-message", icon: null, label: "From message", onSelect: picked },
];

describe("the todo rows of a message menu", () => {
  let root: Root, host: HTMLElement, bubble: HTMLElement, other: HTMLElement;
  const draw = () => flushSync(() => root.render(createElement("div", { [MESSAGE_ROW]: "" },
    createElement(MessageActions, { side: "user", menu: items }),
    createElement("div", { "data-chat-bubble": "" }, createElement("span", { id: "words" }, "December prices")))));
  const labels = () => [...document.querySelectorAll("[role=menuitem]")].map((item) => item.textContent);
  const select = (element: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  };
  const rightClick = () => flushSync(() => { bubble.querySelector("#words")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });

  beforeEach(() => {
    host = document.createElement("div");
    other = document.createElement("p");
    other.textContent = "Another message";
    document.body.append(host, other);
    root = createRoot(host);
    draw();
    bubble = host.querySelector<HTMLElement>("[data-chat-bubble]")!;
    picked.mockClear();
  });
  afterEach(() => {
    window.getSelection()!.removeAllRanges();
    flushSync(() => root.unmount());
    host.remove();
    other.remove();
  });

  it("offers only the message row without a selection", () => {
    flushSync(() => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!.click());
    expect(labels()).toEqual(["From message"]);
  });

  it("offers the selection row when text of this message is selected, and hands the text on", () => {
    select(bubble.querySelector<HTMLElement>("#words")!);
    flushSync(() => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!.click());
    expect(labels()).toEqual(["From selection", "From message"]);
    flushSync(() => (document.querySelectorAll("[role=menuitem]")[0] as HTMLButtonElement).click());
    expect(picked).toHaveBeenCalledWith("December prices");
  });

  it("ignores a selection in another message", () => {
    select(other);
    flushSync(() => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!.click());
    expect(labels()).toEqual(["From message"]);
  });

  it("opens on a right-click that has a selection inside this message", () => {
    select(bubble.querySelector<HTMLElement>("#words")!);
    rightClick();
    expect(labels()).toEqual(["From selection", "From message"]);
  });

  it("leaves a right-click with a selection in another message to the browser", () => {
    select(other);
    rightClick();
    expect(labels()).toEqual([]);
  });

  it("opens on a right-click without a selection and offers the message row only", () => {
    rightClick();
    expect(labels()).toEqual(["From message"]);
  });
});
