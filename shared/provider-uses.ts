/** One thing that still uses a provider, listed in the 409 that refuses to hide or remove it. It carries bot names and
 * counts, never conversation titles. */
export type ProviderUse =
  | { kind: "default" }
  | { kind: "model" | "backup" | "running"; bot: string }
  | { kind: "thread"; bot: string; count: number };
