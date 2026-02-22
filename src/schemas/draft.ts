import { z } from "zod";

export const priceSchema = z.object({
  target: z.number().positive(),
  quick_sale: z.number().positive().optional(),
  floor: z.number().positive().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/)
});

export const draftSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    condition: z.string().min(1),
    price: priceSchema,
    category_hint: z.string().min(1),
    category_id: z.string().regex(/^[0-9]+$/).optional(),
    item_specifics: z.record(z.string(), z.string()).default({})
  })
  .superRefine((value, ctx) => {
    const { target, quick_sale: quickSale, floor } = value.price;

    if (quickSale !== undefined && quickSale > target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "price.quick_sale deve essere <= price.target",
        path: ["price", "quick_sale"]
      });
    }

    if (floor !== undefined && floor > target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "price.floor deve essere <= price.target",
        path: ["price", "floor"]
      });
    }

    if (floor !== undefined && quickSale !== undefined && floor > quickSale) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "price.floor deve essere <= price.quick_sale",
        path: ["price", "floor"]
      });
    }
  });
