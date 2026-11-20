import { createContext, use, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";

export const InsideLinkContext = createContext(false);

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
      : node && typeof node === "object" && "props" in node ? textOf((node.props as { children?: ReactNode }).children) : "";

export function InlineCode({ children }: { children?: ReactNode }) {
  const insideLink = use(InsideLinkContext);
  const text = textOf(children);
  const { state, copy } = useCopyFeedback(text);
  const chip = "ui-code-chip break-words [unicode-bidi:isolate]";
  if (insideLink || !text.trim()) return <code dir="ltr" className={chip}>{children}</code>;
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    copy();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    copy();
  };
  const note = state === "copied" ? t("code.copied") : state === "failed" ? t("common.copyFailed") : null;
  return (
    <code dir="ltr" role="button" tabIndex={0} title={t("code.copyTitle")} data-copy-state={state}
      onClick={onClick} onKeyDown={onKeyDown}
      className={`${chip} relative cursor-pointer hover:bg-ink/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`}>
      {children}
      {note && <span aria-hidden="true" className="pointer-events-none absolute start-1/2 bottom-full z-[1] mb-1 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-1.5 py-1 font-sans text-[11px] leading-none text-canvas rtl:translate-x-1/2">{note}</span>}
      {note && <span role="status" className="sr-only">{note}</span>}
    </code>
  );
}
