import { generateDraftFromNotes } from "../utils/draft-generator.js";
import type { EnrichmentModule } from "./modules.js";

export const genericEnrichmentModule: EnrichmentModule = {
  id: "generic",
  label: "Generic listing",
  canHandle(): number {
    return 0.1;
  },
  enrich(context) {
    const draft = generateDraftFromNotes({
      slug: context.slug,
      notes: context.notes,
      photoFiles: context.photoFiles
    });

    return {
      draft,
      report: {
        version: 1,
        generated_at: new Date().toISOString(),
        module: "generic",
        confidence: "medium",
        extracted: {},
        warnings: [
          "Draft generato con strategia generica: verifica manualmente categoria, titolo e dettagli prima del publish."
        ],
        evidence: context.photoFiles.map((photoFile) => ({
          field: "photo",
          value: photoFile,
          source: "photo_file",
          confidence: "low" as const
        })),
        draft_preview: draft
      }
    };
  }
};
