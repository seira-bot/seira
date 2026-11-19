import { z } from "zod";

import { hasControl } from "./common";

export const REPORT_BODY_LIMIT = 614_400;
export const STATUS_BODY_LIMIT = 16 * 1024;
export const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const installId = z.string().min(1).max(128).refine((value) => !hasControl(value));
const field = (max: number) => z.string().min(1).max(max);
const hintPart = z.string().max(200).optional();

export const reportSchema = z.object({
  installId,
  source: z.literal("bot"),
  description: field(10_000),
  appVersion: field(40),
  platform: field(40),
  diagnostics: z.string().max(262_144),
  title: field(120).optional(),
  fingerprint: z.object({ kind: hintPart, step: hintPart, frame: hintPart }).optional(),
  contactEmail: z.unknown().optional(),
  contact: z.unknown().optional(),
});

export type Report = z.infer<typeof reportSchema>;

export const statusSchema = z.object({
  installId,
  ids: z.array(z.string().regex(REPORT_ID_PATTERN)).max(50),
});
