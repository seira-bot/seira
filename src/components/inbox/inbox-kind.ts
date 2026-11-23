import type { InboxRow } from "../../../shared/inbox";

/** News: a line the person only needs to read, not decide. */
export const isNews = (row: Pick<InboxRow, "kind" | "tab" | "decision">): boolean => row.kind !== "ask" && row.tab === "info" && !row.decision;

/** A decision: an ask that waits on the person, or news that asks them to decide. */
export const isDecision = (row: Pick<InboxRow, "tab" | "decision">): boolean => row.tab === "needs-you" || (row.tab === "info" && row.decision === true);
