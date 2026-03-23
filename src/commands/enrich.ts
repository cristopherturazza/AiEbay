import { loadRuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import {
  getToSellRoot,
  readStatusOrEmpty,
  resolveListing,
  writeDraft,
  writeEnrichmentReport,
  writeStatus
} from "../fs/listings.js";
import { logger } from "../logger.js";
import { generateListingEnrichment } from "../enrichment/index.js";
import type { EnrichmentModuleId } from "../enrichment/modules.js";
import { makeSku } from "../utils/sku.js";
import { toStatusError } from "../utils/status-error.js";

interface EnrichOptions {
  module?: EnrichmentModuleId;
  force?: boolean;
}

export const runEnrich = async (folder: string, options: EnrichOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const status = await readStatusOrEmpty(listing.statusPath);
  const previouslyPublished = status.state === "published" || Boolean(status.ebay.listing_id);

  try {
    const result = await generateListingEnrichment(listing, {
      moduleId: options.module ?? "auto"
    });

    await writeEnrichmentReport(listing.enrichmentPath, result.report);
    logger.info(
      `[${listing.slug}] enrichment completato con modulo=${result.moduleId} confidence=${result.report.confidence}`
    );

    const shouldWriteDraft = options.force || !result.existingDraft;
    if (shouldWriteDraft) {
      let draftToWrite = result.draft;
      if (result.existingDraft?.category_id && !draftToWrite.category_id) {
        draftToWrite = { ...draftToWrite, category_id: result.existingDraft.category_id };
      }
      if (result.existingDraft?.shipping_profile && !draftToWrite.shipping_profile) {
        draftToWrite = { ...draftToWrite, shipping_profile: result.existingDraft.shipping_profile };
      }

      await writeDraft(listing.draftPath, draftToWrite);
      logger.info(`[${listing.slug}] draft.json ${result.existingDraft ? "rigenerato" : "creato"} dal modulo`);
    } else {
      logger.info(`[${listing.slug}] draft.json esistente preservato; usa --force per rigenerarlo`);
    }

    if (result.photoFiles.length === 0) {
      throw new SellbotError("PHOTOS_MISSING", `Nessuna immagine trovata in ${listing.photosDir}`);
    }

    status.state = previouslyPublished ? "published" : "ready";
    if (!previouslyPublished) {
      status.published_at = null;
    }
    status.ebay.sku = status.ebay.sku ?? makeSku(listing.slug);
    status.last_error = null;
    await writeStatus(listing.statusPath, status);
  } catch (error) {
    status.state = previouslyPublished ? "published" : "error";
    status.last_error = toStatusError(error);
    status.ebay.sku = status.ebay.sku ?? makeSku(listing.slug);
    await writeStatus(listing.statusPath, status);
    throw error;
  }
};
