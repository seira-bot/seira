/** One thing that still uses an AI provider, named for a person. Sent with a refused Hide or Remove. */
export type ProviderUse =
  | { kind: "default" }
  /** Uses the caller may not see, counted without names. */
  | { kind: "other"; count: number }
  | { kind: "bot" | "backup" | "running"; botId: string; botName: string }
  | { kind: "conversation"; botId: string; botName: string; threadId: string; title: string };

export const isProviderUse = (value: unknown): value is ProviderUse => {
  if (!value || typeof value !== "object") return false;
  const use = value as Record<string, unknown>;
  if (use.kind === "default") return true;
  if (use.kind === "other") return typeof use.count === "number";
  if (typeof use.botId !== "string" || typeof use.botName !== "string") return false;
  if (use.kind === "bot" || use.kind === "backup" || use.kind === "running") return true;
  return use.kind === "conversation" && typeof use.threadId === "string" && typeof use.title === "string";
};

/** The uses in a refused reply's body; anything else is dropped. */
export const providerUsesOf = (body: unknown): ProviderUse[] => {
  const uses = (body as { uses?: unknown } | null | undefined)?.uses;
  return Array.isArray(uses) ? uses.filter(isProviderUse) : [];
};
