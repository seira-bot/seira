import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import type { ReplyBlock } from "@/lib/formatted-reply";
import { SIMPLE_BOT_BUBBLE } from "./chat-bubble";

/** Simple mode's reply with tables: one block holding the prose and each table in order. The block may grow to the
 * message's card width so a table's columns show, and its prose runs to the same edge. The hover tray sits beside it. */
export function ReplyBlocks({ blocks, citation, tray, render }: {
  blocks: readonly ReplyBlock[];
  citation: { messageId: string; ownerType: "bot" | "group"; ownerId: string; threadId: string };
  tray?: ReactNode;
  render: (text: string) => ReactNode;
}) {
  return (
    <div
      data-reply-blocks
      className="flex w-full items-center gap-1.5"
      data-citation-source={citation.messageId}
      data-citation-owner-type={citation.ownerType}
      data-citation-owner={citation.ownerId}
      data-citation-thread={citation.threadId}
    >
      <div data-chat-bubble="simple" data-reply-bubble className={cn("flex w-fit min-w-0 max-w-[var(--chat-card-pct)] flex-col gap-3", SIMPLE_BOT_BUBBLE)}>
        {blocks.map((block, index) => block.kind === "table"
          ? <div key={index} data-reply-table className="min-w-0">{render(block.text)}</div>
          : <div key={index} data-reply-prose className="min-w-full max-w-[var(--chat-bubble-max)]">{render(block.text)}</div>)}
      </div>
      {tray}
    </div>
  );
}
