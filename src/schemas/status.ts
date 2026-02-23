import { z } from "zod";

export const statusErrorSchema = z.object({
  message: z.string(),
  http_status: z.number().int().nullable().optional(),
  response_snippet: z.string().nullable().optional(),
  at: z.string().datetime().optional()
});

const normalizedStatusErrorSchema = z.preprocess((value) => {
  if (typeof value === "string") {
    return { message: value };
  }

  return value;
}, statusErrorSchema);

export const statusSchema = z.object({
  state: z.enum(["draft", "ready", "published", "error"]),
  published_at: z.string().datetime().nullable(),
  ebay: z.object({
    sku: z.string().nullable(),
    offer_id: z.string().nullable(),
    listing_id: z.string().nullable(),
    url: z.string().nullable()
  }),
  last_error: normalizedStatusErrorSchema.nullable()
});
