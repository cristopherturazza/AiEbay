import type { Draft, EnrichmentReport, IntakeReport } from "../types.js";
import type { EnrichmentContext } from "../enrichment/modules.js";

export type IntakeProfileId = "generic" | "book";

export interface IntakeAnalysisContext {
  slug: string;
  notes: string;
  photoFiles: string[];
  currentDraft: Draft;
  existingDraft: Draft | null;
  enrichmentReport: EnrichmentReport;
  enrichmentContext: EnrichmentContext;
}

export interface IntakeProfile {
  id: IntakeProfileId;
  label: string;
  buildReport(context: IntakeAnalysisContext): IntakeReport;
}
