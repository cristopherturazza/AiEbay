import { z } from "zod";

export const ebayBuildSchema = z.object({
  version: z.literal(1),
  generated_at: z.string().datetime(),
  slug: z.string().min(1),
  sku: z.string().min(1),
  marketplace_id: z.string().min(1),
  locale: z.string().min(2),
  quantity: z.number().int().positive(),
  format: z.literal("FIXED_PRICE"),
  listing_duration: z.string().min(1),
  category_id: z.string().min(1),
  condition: z.string().min(1),
  pricing_summary: z.object({
    price: z.object({
      value: z.string().min(1),
      currency: z.string().regex(/^[A-Z]{3}$/)
    })
  }),
  listing_description: z.string().min(1),
  product: z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    aspects: z.record(z.string(), z.array(z.string().min(1))).default({}),
    image_files: z.array(z.string().min(1)).min(1)
  })
});
