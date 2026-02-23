import { logger } from "../logger.js";
import {
  getToSellRoot,
  listListingFolders,
  listPhotoFiles,
  readDraft,
  readNotes,
  readStatusOrEmpty,
  writeDraft,
  writeStatus
} from "../fs/listings.js";
import { generateDraftFromNotes } from "../utils/draft-generator.js";
import { makeSku } from "../utils/sku.js";
import type { Draft } from "../types.js";

export const runScan = async (): Promise<void> => {
  const root = getToSellRoot();
  const listings = await listListingFolders(root);

  if (listings.length === 0) {
    logger.warn(`Nessuna cartella trovata in ${root}`);
    return;
  }

  let readyCount = 0;
  let draftCount = 0;
  let publishedCount = 0;
  let createdDraftCount = 0;

  for (const listing of listings) {
    const photos = await listPhotoFiles(listing.photosDir);
    const hasPhotos = photos.length > 0;

    let draft: Draft | null = null;
    let draftReadError: string | null = null;

    try {
      draft = await readDraft(listing.draftPath);
    } catch (error) {
      draftReadError = (error as Error).message;
    }

    if (!draft && !draftReadError) {
      const notes = await readNotes(listing.notesPath);
      const generatedDraft = generateDraftFromNotes({
        slug: listing.slug,
        notes,
        photoFiles: photos
      });

      await writeDraft(listing.draftPath, generatedDraft);
      draft = generatedDraft;
      createdDraftCount += 1;
      logger.info(`[${listing.slug}] creato draft.json`);
    }

    const status = await readStatusOrEmpty(listing.statusPath);

    if (status.state === "published") {
      status.ebay.sku = status.ebay.sku ?? makeSku(listing.slug);
      await writeStatus(listing.statusPath, status);
      publishedCount += 1;
      logger.info(`[${listing.slug}] state=published preservato`);
      continue;
    }

    if (hasPhotos && draft && !draftReadError) {
      status.state = "ready";
      status.published_at = null;
      status.last_error = null;
      readyCount += 1;
    } else {
      status.state = "draft";
      status.published_at = null;
      status.last_error = {
        message: hasPhotos
          ? draftReadError ?? "draft.json non valido o assente"
          : "Manca la cartella photos/ o non contiene immagini",
        http_status: null,
        response_snippet: null,
        at: new Date().toISOString()
      };
      draftCount += 1;
    }

    status.ebay.sku = status.ebay.sku ?? makeSku(listing.slug);
    await writeStatus(listing.statusPath, status);

    logger.info(
      `[${listing.slug}] state=${status.state} photos=${photos.length} draft=${draft ? "ok" : "missing"}`
    );
  }

  logger.info(
    `Scan completato: cartelle=${listings.length}, ready=${readyCount}, draft=${draftCount}, published=${publishedCount}, draft_creati=${createdDraftCount}`
  );
};
