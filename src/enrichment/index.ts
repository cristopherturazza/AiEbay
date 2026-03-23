import { SellbotError } from "../errors.js";
import { readDraft, readNotes, listPhotoFiles, type ListingPaths } from "../fs/listings.js";
import type { EnrichmentReport } from "../types.js";
import { bookEnrichmentModule } from "./book-module.js";
import { genericEnrichmentModule } from "./generic-module.js";
import type { EnrichmentContext, EnrichmentModule, EnrichmentModuleId } from "./modules.js";

const registeredModules: EnrichmentModule[] = [bookEnrichmentModule, genericEnrichmentModule];

export const listEnrichmentModules = (): Array<Pick<EnrichmentModule, "id" | "label">> => {
  return registeredModules.map((module) => ({ id: module.id, label: module.label }));
};

export const buildEnrichmentContext = async (listing: ListingPaths): Promise<EnrichmentContext> => {
  const notes = await readNotes(listing.notesPath);
  const photoFiles = await listPhotoFiles(listing.photosDir);
  const observations = [
    ...notes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((value) => ({ source: "notes" as const, value })),
    ...photoFiles.map((value) => ({ source: "photo_file" as const, value }))
  ];

  return {
    slug: listing.slug,
    notes,
    photoFiles,
    observations
  };
};

const resolveModule = (context: EnrichmentContext, requestedModule: EnrichmentModuleId): EnrichmentModule => {
  if (requestedModule !== "auto") {
    const selected = registeredModules.find((module) => module.id === requestedModule);
    if (!selected) {
      throw new SellbotError("ENRICHMENT_MODULE_UNSUPPORTED", `Modulo enrichment non supportato: ${requestedModule}`);
    }

    return selected;
  }

  return [...registeredModules]
    .sort((left, right) => right.canHandle(context) - left.canHandle(context))[0] ?? genericEnrichmentModule;
};

export interface GenerateEnrichmentOptions {
  moduleId?: EnrichmentModuleId;
}

export interface GenerateEnrichmentResult {
  moduleId: EnrichmentModule["id"];
  draft: EnrichmentReport["draft_preview"];
  report: EnrichmentReport;
  existingDraft: Awaited<ReturnType<typeof readDraft>>;
  photoFiles: string[];
}

export const generateListingEnrichment = async (
  listing: ListingPaths,
  options: GenerateEnrichmentOptions = {}
): Promise<GenerateEnrichmentResult> => {
  const context = await buildEnrichmentContext(listing);
  const module = resolveModule(context, options.moduleId ?? "auto");
  const existingDraft = await readDraft(listing.draftPath);
  const enriched = module.enrich(context);

  return {
    moduleId: module.id,
    draft: enriched.draft,
    report: enriched.report,
    existingDraft,
    photoFiles: context.photoFiles
  };
};
