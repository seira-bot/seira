import { z } from "zod";

import { EFFORT_LEVELS } from "../shared/wire.ts";
import { isModelVariant } from "./contracts.ts";

export const defaultModelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(500),
  effort: z.enum(EFFORT_LEVELS).optional(),
  variant: z.string().refine(isModelVariant, "invalid model variant").optional(),
}).refine((selection) => selection.variant === undefined || selection.effort === undefined,
  "choose either a model variant or an effort level");
