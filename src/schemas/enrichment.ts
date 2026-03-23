import { z } from "zod";
import { draftSchema } from "./draft.js";

const confidenceSchema = z.enum(["low", "medium", "high"]);

export const enrichmentEvidenceSchema = z.object({
  field: z.string().min(1),
  value: z.string().min(1),
  source: z.enum(["notes", "photo_file", "derived"]),
  confidence: confidenceSchema
});

export const enrichmentReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  module: z.string().min(1),
  confidence: confidenceSchema,
  extracted: z.record(z.string(), z.string()).default({}),
  warnings: z.array(z.string()).default([]),
  evidence: z.array(enrichmentEvidenceSchema).default([]),
  draft_preview: draftSchema
});
