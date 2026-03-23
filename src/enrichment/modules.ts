import type { Draft, EnrichmentReport } from "../types.js";

export type EnrichmentModuleId = "auto" | "generic" | "book";
export type EnrichmentConfidence = EnrichmentReport["confidence"];

export interface ListingObservation {
  source: "notes" | "photo_file";
  value: string;
}

export interface EnrichmentContext {
  slug: string;
  notes: string;
  photoFiles: string[];
  observations: ListingObservation[];
}

export interface EnrichmentModule {
  id: Exclude<EnrichmentModuleId, "auto">;
  label: string;
  canHandle(context: EnrichmentContext): number;
  enrich(context: EnrichmentContext): {
    draft: Draft;
    report: EnrichmentReport;
  };
}
