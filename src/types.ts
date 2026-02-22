import type { z } from "zod";
import { draftSchema, ebayBuildSchema, statusSchema } from "./schemas/index.js";

export type Draft = z.infer<typeof draftSchema>;
export type Status = z.infer<typeof statusSchema>;
export type EbayBuild = z.infer<typeof ebayBuildSchema>;
