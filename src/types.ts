import type { z } from "zod";
import {
  draftSchema,
  ebayBuildSchema,
  enrichmentReportSchema,
  intakeReportSchema,
  statusSchema
} from "./schemas/index.js";

export type Draft = z.infer<typeof draftSchema>;
export type Status = z.infer<typeof statusSchema>;
export type EbayBuild = z.infer<typeof ebayBuildSchema>;
export type EnrichmentReport = z.infer<typeof enrichmentReportSchema>;
export type IntakeReport = z.infer<typeof intakeReportSchema>;
