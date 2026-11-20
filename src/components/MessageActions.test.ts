// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatBusyContext, MessageActions, type MessageMenuItem } from "./MessageActions";

type Props = Parameters<typeof MessageActions>[0];

const pin: MessageMenuItem = { key: "pin", icon: null, label: "Pin message", onSelect: () => {} };

const render = (props: Partial<Omit<Props, "children">> = {}) =>
  renderToStaticMarkup(
    createElement(MessageActions, {
      side: "bot",
      ...props,
      children: [
        createElement("button", { type: "button", key: "reply" }, "reply"),
        createElement("button", { type: "button", key: "copy" }, "copy"),
      ],
    }),
  );

describe("MessageActions", () => {
  it("shows only reply and copy, hidden until the message is hovered or focused", () => {
    const html = render({ menu: [pin] });
    expect(html).toContain(">reply<");
    expect(html).toContain(">copy<");
    expect(html).toContain("opacity-0");
    expect(html).toContain("pointer-events-none");
    expect(html).not.toContain('data-shown="true"');
  });

  it("moves the rest behind a closed more menu", () => {
    const html = render({ menu: [pin] });
    expect(html).toContain('aria-label="Message actions"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Pin message");
  });

  it("drops the more button when nothing is in the menu", () => {
    expect(render()).not.toContain('aria-haspopup="menu"');
  });

  it("stays out while a control must remain reachable", () => {
    const html = render({ forceOpen: true });
    expect(html).toContain('data-shown="true"');
    expect(html).not.toContain("opacity-0");
  });

  it("mirrors the row on the user side so it starts at the bubble", () => {
    expect(render({ side: "user" })).toContain("flex-row-reverse");
    expect(render({ side: "bot" })).not.toContain("flex-row-reverse");
  });

  it("drops idle-only items from an open menu while the chat's turn runs", () => {
    const draw: MessageMenuItem = { key: "draw", icon: null, label: "Draw as workflow", onSelect: () => {}, idleOnly: true };
    const labels = (busy: boolean) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      flushSync(() => root.render(createElement(ChatBusyContext, { value: busy }, createElement(MessageActions, { side: "bot", menu: [draw, pin] }))));
      flushSync(() => host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
      const found = [...host.querySelectorAll("[role=menuitem]")].map((item) => item.textContent);
      flushSync(() => root.unmount());
      host.remove();
      return found;
    };
    expect(labels(false)).toEqual(["Draw as workflow", "Pin message"]);
    expect(labels(true)).toEqual(["Pin message"]);
  });
});
