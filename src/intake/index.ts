import { SellbotError } from "../errors.js";
import { type ListingPaths } from "../fs/listings.js";
import { buildEnrichmentContext, generateListingEnrichment } from "../enrichment/index.js";
import type { EnrichmentModuleId } from "../enrichment/modules.js";
import type { IntakeReport } from "../types.js";
import { bookIntakeProfile } from "./book-profile.js";
import { genericIntakeProfile } from "./generic-profile.js";
import type { IntakeProfile, IntakeProfileId } from "./modules.js";

const profiles: Record<IntakeProfileId, IntakeProfile> = {
  book: bookIntakeProfile,
  generic: genericIntakeProfile
};

const resolveProfile = (moduleId: Exclude<EnrichmentModuleId, "auto">): IntakeProfile => {
  return profiles[moduleId] ?? genericIntakeProfile;
};

export interface BuildIntakeOptions {
  moduleId?: EnrichmentModuleId;
}

export interface BuildIntakeResult {
  report: IntakeReport;
  moduleId: IntakeProfileId;
}

export const buildListingIntakeReport = async (
  listing: ListingPaths,
  options: BuildIntakeOptions = {}
): Promise<BuildIntakeResult> => {
  const enrichment = await generateListingEnrichment(listing, { moduleId: options.moduleId ?? "auto" });
  const enrichmentContext = await buildEnrichmentContext(listing);
  const currentDraft = enrichment.existingDraft ?? enrichment.draft;

  if (!currentDraft) {
    throw new SellbotError("DRAFT_MISSING", `Impossibile costruire intake report senza draft per ${listing.dir}`);
  }

  const profile = resolveProfile(enrichment.moduleId);
  const report = profile.buildReport({
    slug: listing.slug,
    notes: enrichmentContext.notes,
    photoFiles: enrichmentContext.photoFiles,
    currentDraft,
    existingDraft: enrichment.existingDraft,
    enrichmentReport: enrichment.report,
    enrichmentContext
  });

  return {
    report,
    moduleId: profile.id
  };
};
