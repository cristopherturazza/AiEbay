import { z } from "zod";

const acquisitionSchema = z.object({
  primary: z.enum(["derive", "search_web", "ask_user"]),
  fallback: z.enum(["search_web", "ask_user"]).optional()
});

const intakeFieldSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(["present", "missing", "uncertain"]),
  importance: z.enum(["required", "recommended", "optional"]),
  value: z.string().min(1).optional(),
  source: z.enum(["draft", "notes", "enrichment", "derived"]).optional(),
  note: z.string().min(1).optional(),
  acquisition: acquisitionSchema
});

const intakeActionSchema = z.object({
  kind: z.enum(["search_web", "ask_user", "add_photo", "review"]),
  field: z.string().min(1),
  prompt: z.string().min(1),
  rationale: z.string().min(1).optional(),
  search_queries: z.array(z.string().min(1)).default([])
});

const pricingSuggestionSchema = z.object({
  strategy: z.literal("reference_new_price_discount"),
  condition_bucket: z.enum(["perfect", "used", "defect"]),
  discount_percent: z.number().int().min(0).max(100),
  reference_new_price: z.number().positive().optional(),
  current_target: z.number().positive().optional(),
  suggested_target: z.number().positive().optional(),
  suggested_quick_sale: z.number().positive().optional(),
  suggested_floor: z.number().positive().optional(),
  delta_to_current_target: z.number().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  ready: z.boolean(),
  note: z.string().min(1),
  missing_inputs: z.array(z.string().min(1)).default([])
});

export const intakeReportSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  profile: z.string().min(1),
  fields: z.array(intakeFieldSchema).default([]),
  actions: z.array(intakeActionSchema).default([]),
  pricing: pricingSuggestionSchema,
  summary: z.object({
    completeness: z.enum(["complete", "needs_search", "needs_user_input", "blocked"]),
    search_first: z.array(z.string().min(1)).default([]),
    ask_user: z.array(z.string().min(1)).default([]),
    publish_blockers: z.array(z.string().min(1)).default([])
  })
});
