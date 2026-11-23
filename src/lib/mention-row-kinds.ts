/** The kinds of row the @ list shows. */
export const MENTION_ROW_KINDS = ["agent", "app", "mcp", "person", "team", "channel", "devs"] as const;
export type MentionRowKind = (typeof MENTION_ROW_KINDS)[number];
