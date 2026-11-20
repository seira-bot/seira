// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { ChatMarkdown } from "./ChatMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("inline code copy", () => {
  let host: HTMLDivElement;
  let root: Root;
  let writeText: ReturnType<typeof vi.spyOn>;

  const show = async (text: string) => {
    await act(async () => root.render(createElement(ChatMarkdown, { text })));
  };
  const chip = () => host.querySelector<HTMLElement>("code[role=button]")!;

  beforeEach(() => {
    setLocale("en");
    writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it("copies the exact text and shows the copied state on click", async () => {
    await show("Run `pnpm  install` now.");
    await act(async () => chip().click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith("pnpm  install");
    expect(chip().dataset.copyState).toBe("copied");
    expect(chip().querySelector("[role=status]")?.textContent).toBe("Copied");
  });

  it("copies on Enter and Space", async () => {
    await show("Use `abc-123`.");
    for (const key of ["Enter", " "]) {
      await act(async () => {
        chip().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    }
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("abc-123");
    expect(chip().tabIndex).toBe(0);
  });

  it("keeps a drag selection and does not copy", async () => {
    await show("Some text with `abc-123` inside.");
    const range = document.createRange();
    range.selectNodeContents(host);
    window.getSelection()!.addRange(range);
    await act(async () => chip().click());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("leaves inline code inside a link to the link", async () => {
    await show("[`abc-123`](https://example.com/x)");
    expect(host.querySelector("code[role=button]")).toBeNull();
    expect(host.querySelector("a code")?.textContent).toBe("abc-123");
  });

  it("does not make a fenced code block an inline chip", async () => {
    await show("```text\nabc\n```");
    expect(host.querySelector("code[role=button]")).toBeNull();
  });
});
