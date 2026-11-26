import { z } from "zod";

import { AI_POOL_LEVELS } from "../shared/ai-pool.ts";
import { defaultModelSelectionSchema } from "./model-selection-schema.ts";

export * from "../shared/ai-pool.ts";

export const aiPoolSchema = z.object({
  enabled: z.boolean(),
  /**
   * `even` shares usage by levels of usage left.
   * `turns` gives each new conversation the next AI in the list and keeps it there while that AI can run.
   * `inOrder` uses the first AI until it cannot run, then the next.
   */
  mode: z.enum(["even", "turns", "inOrder"]).default("even"),
  /** The AIs that share usage, in order. Two to ten, each at most once. */
  members: z.array(defaultModelSelectionSchema).max(10).default([]),
  /** Usage left, in percent, that `even` mode steps down through. */
  levels: z.array(z.number().int().min(1).max(99)).min(1).max(9).optional(),
  /** Usage left, in percent, at which an AI stops taking new work from the pool. */
  floor: z.number().int().min(0).max(98).optional(),
}).strict().superRefine((pool, ctx) => {
  const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
  if (pool.enabled && pool.members.length < 2) issue("Choose at least two AIs before you turn on the AI pool.", ["members"]);
  if (new Set(pool.members.map((member) => member.instanceId)).size !== pool.members.length) issue("Each AI can join the pool once.", ["members"]);
  const levels = pool.levels;
  if (levels?.some((level, index) => index > 0 && level >= levels[index - 1]!)) issue("Each level must be lower than the one before it.", ["levels"]);
  if (pool.floor !== undefined && pool.floor >= (levels ?? AI_POOL_LEVELS).at(-1)!) issue("The floor must be lower than the last level.", ["floor"]);
});
export type AiPoolConfig = z.output<typeof aiPoolSchema>;

