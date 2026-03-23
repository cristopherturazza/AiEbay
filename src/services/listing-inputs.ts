import { SellbotError } from "../errors.js";
import { listPhotoFiles, readDraft, type ListingPaths } from "../fs/listings.js";
import type { Draft } from "../types.js";

export interface ListingDraftInputs {
  draft: Draft;
  photoFiles: string[];
}

export const readListingDraftInputs = async (listing: ListingPaths): Promise<ListingDraftInputs> => {
  const draft = await readDraft(listing.draftPath);

  if (!draft) {
    throw new SellbotError("DRAFT_MISSING", `draft.json mancante in ${listing.dir}`);
  }

  const photoFiles = await listPhotoFiles(listing.photosDir);

  if (photoFiles.length === 0) {
    throw new SellbotError(
      "PHOTOS_MISSING",
      `Nessuna immagine .jpg/.jpeg/.png/.heic trovata in ${listing.photosDir}`
    );
  }

  return { draft, photoFiles };
};
