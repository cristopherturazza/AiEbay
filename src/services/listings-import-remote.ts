import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config.js";
import type { InventoryItemResponse, OfferResponse } from "../ebay/inventory.js";
import {
  ensureToSellRoot,
  getToSellRoot,
  listListingFolders,
  listPhotoFiles,
  readStatusOrEmpty,
  writeDraft,
  writeStatus,
  type ListingPaths
} from "../fs/listings.js";
import type { Draft, Status } from "../types.js";
import { deriveListingUrl } from "../utils/listing-url.js";
import { slugifyTitle } from "../utils/slug.js";
import { collectRemoteOffers, type RemoteListingsRuntime } from "./remote-listings.js";

const SKU_PREFIX = "sb-";
const DEFAULT_CONDITION = "USED_GOOD";
const DUPLICATE_TOKEN_MIN_LENGTH = 4;
const DUPLICATE_OVERLAP_THRESHOLD = 0.7;
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic"]);
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/heic": ".heic"
};

export interface ImportRemoteListingsOptions {
  dryRun?: boolean;
  activeOnly?: boolean;
  limit?: number;
  downloadPhotos?: boolean;
  redownloadPhotos?: boolean;
}

export interface ImportedListing {
  slug: string;
  sku: string;
  offer_id: string;
  listing_id: string | null;
  listing_status: string | null;
  title: string;
  photos_downloaded: number;
  photos_failed: number;
}

export interface RefreshedListing {
  slug: string;
  listing_id: string | null;
  listing_status: string | null;
  changes: string[];
  photos_downloaded: number;
  photos_failed: number;
}

export interface SkippedRemoteListing {
  sku: string;
  slug: string | null;
  reason: "slug_taken" | "missing_sku" | "unusable_price";
  detail: string;
}

export interface DuplicateCandidate {
  imported_slug: string;
  local_slug: string;
  listing_id: string | null;
  detail: string;
}

export interface ImportRemoteListingsResult {
  current_env: RuntimeConfig["ebayEnv"];
  marketplace_id: string;
  dry_run: boolean;
  remote_total: number;
  imported: ImportedListing[];
  refreshed: RefreshedListing[];
  skipped: SkippedRemoteListing[];
  duplicates: DuplicateCandidate[];
}

/**
 * Le SKU generate da makeSku() sono `sb-<slug>` troncate a 50 caratteri: lo slug
 * ricostruito puo' quindi essere una versione tagliata dell'originale.
 */
export const deriveSlugFromRemote = (sku: string | null, title: string | null): string => {
  const fromSku = sku?.startsWith(SKU_PREFIX) ? sku.slice(SKU_PREFIX.length) : null;
  const candidate = fromSku ?? sku ?? title ?? "";
  const slug = slugifyTitle(candidate);
  return slug.length > 0 ? slug : "listing";
};

const tokenize = (slug: string): string[] =>
  slug.split("-").filter((token) => token.length >= DUPLICATE_TOKEN_MIN_LENGTH);

const tokensMatch = (a: string, b: string): boolean => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * Confronto tollerante al troncamento della SKU: 'lady-pride-...-prejudic' deve
 * riconoscere 'lady-pride-...-prejudice'.
 */
export const looksLikeSameListing = (slugA: string, slugB: string): boolean => {
  const tokensA = tokenize(slugA);
  const tokensB = tokenize(slugB);

  if (tokensA.length === 0 || tokensB.length === 0) {
    return false;
  }

  const matched = tokensA.filter((token) => tokensB.some((other) => tokensMatch(token, other)));
  const overlap = matched.length / Math.max(tokensA.length, tokensB.length);
  return overlap >= DUPLICATE_OVERLAP_THRESHOLD;
};

/**
 * Le imageUrls dell'Inventory API puntano alla variante piccola (EPS `$_1.JPG` = 300px,
 * `s-l225.jpg` sul formato moderno). Per riscaricare l'originale serve la variante piena:
 * `$_57.JPG` restituisce il master (es. 960x1280 invece di 300x400).
 */
export const upgradeEbayImageUrl = (url: string): string => {
  if (!/i\.ebayimg\.com/i.test(url)) {
    return url;
  }

  if (/\$_\d+\.(jpg|jpeg|png)/i.test(url)) {
    return url.replace(/\$_\d+\.(jpg|jpeg|png)/i, "$_57.$1");
  }

  return url.replace(/\/s-l\d+\.(jpg|jpeg|png)/i, "/s-l1600.$1");
};

const photoExtension = (url: string, contentType: string | null): string => {
  const fromContentType = contentType ? CONTENT_TYPE_EXTENSIONS[contentType.split(";")[0].trim().toLowerCase()] : undefined;
  if (fromContentType) {
    return fromContentType;
  }

  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (PHOTO_EXTENSIONS.has(extension)) {
      return extension;
    }
  } catch {
    // URL non parsabile: si ricade sul default.
  }

  return ".jpg";
};

const downloadPhotos = async (
  photosDir: string,
  imageUrls: string[]
): Promise<{ downloaded: number; failed: number }> => {
  let downloaded = 0;
  let failed = 0;

  await mkdir(photosDir, { recursive: true });

  for (let index = 0; index < imageUrls.length; index += 1) {
    const url = upgradeEbayImageUrl(imageUrls[index]);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        failed += 1;
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const extension = photoExtension(url, response.headers.get("content-type"));
      const name = `remote-${String(index + 1).padStart(2, "0")}${extension}`;
      await writeFile(path.join(photosDir, name), buffer);
      downloaded += 1;
    } catch {
      failed += 1;
    }
  }

  return { downloaded, failed };
};

const IMPORTED_PHOTO_PATTERN = /^remote-\d+\.[a-z]+$/i;

/**
 * Se la cartella ha foto scattate a mano, le copie eBay sarebbero doppioni: un revise
 * ripubblicherebbe due volte gli stessi scatti.
 */
const hasOwnPhotos = async (photosDir: string): Promise<boolean> => {
  const photos = await listPhotoFiles(photosDir);
  return photos.some((name) => !IMPORTED_PHOTO_PATTERN.test(name));
};

/**
 * Rimuove solo le foto generate dall'import: quelle aggiunte a mano restano.
 */
const clearImportedPhotos = async (photosDir: string): Promise<void> => {
  let entries: string[];

  try {
    entries = await readdir(photosDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (IMPORTED_PHOTO_PATTERN.test(entry)) {
      await rm(path.join(photosDir, entry), { force: true });
    }
  }
};

const firstAspectValues = (aspects: Record<string, string[]> | undefined): Record<string, string> => {
  const specifics: Record<string, string> = {};

  for (const [key, values] of Object.entries(aspects ?? {})) {
    const value = values.find((candidate) => candidate.trim().length > 0);
    if (value) {
      specifics[key] = value.trim();
    }
  }

  return specifics;
};

const buildDraftFromRemote = (
  inventoryItem: InventoryItemResponse,
  offer: OfferResponse
): Draft | null => {
  const title = inventoryItem.product?.title?.trim();
  const rawPrice = offer.pricingSummary?.price?.value;
  const price = rawPrice === undefined ? Number.NaN : Number(rawPrice);

  if (!title || !Number.isFinite(price) || price <= 0) {
    return null;
  }

  const description = inventoryItem.product?.description?.trim();

  return {
    title,
    description: description && description.length > 0 ? description : title,
    condition: inventoryItem.condition?.trim() || DEFAULT_CONDITION,
    price: {
      target: price,
      currency: offer.pricingSummary?.price?.currency ?? "EUR"
    },
    category_hint: title,
    ...(offer.categoryId ? { category_id: offer.categoryId } : {}),
    item_specifics: firstAspectValues(inventoryItem.product?.aspects)
  };
};

const importNotes = (sku: string, listingId: string | null): string =>
  [
    "Cartella ricostruita da eBay con sellbot listings:import-remote.",
    `SKU: ${sku}`,
    `Listing ID: ${listingId ?? "n/d"}`,
    "",
    "intake.json, enrichment.json e le note originali non sono recuperabili:",
    "eBay conserva solo il pubblicato (titolo, descrizione, aspects, foto, prezzo).",
    ""
  ].join("\n");

const remoteStatusFor = (
  config: RuntimeConfig,
  offer: OfferResponse,
  sku: string,
  checkedAt: string
): Status => {
  const listingId = offer.listing?.listingId ?? null;
  const marketplaceId = offer.marketplaceId ?? config.ebayMarketplaceId;

  return {
    state: listingId ? "published" : "ready",
    published_at: null,
    ebay: {
      sku,
      offer_id: offer.offerId,
      listing_id: listingId,
      url: listingId ? deriveListingUrl(config.ebayEnv, marketplaceId, listingId) : null,
      listing_status: offer.listing?.listingStatus ?? null,
      listing_status_checked_at: checkedAt
    },
    last_error: null
  };
};

interface LocalListingState {
  listing: ListingPaths;
  status: Status;
}

const refreshLocalStatus = (current: Status, offer: OfferResponse, checkedAt: string): { next: Status; changes: string[] } => {
  const listingStatus = offer.listing?.listingStatus ?? null;
  const changes: string[] = [];

  if ((current.ebay.listing_status ?? null) !== listingStatus) {
    changes.push(`listing_status: ${current.ebay.listing_status ?? "n/d"} → ${listingStatus ?? "n/d"}`);
  }

  if (current.ebay.offer_id !== offer.offerId) {
    changes.push(`offer_id: ${current.ebay.offer_id ?? "n/d"} → ${offer.offerId}`);
  }

  return {
    next: {
      ...current,
      ebay: {
        ...current.ebay,
        offer_id: offer.offerId,
        listing_status: listingStatus,
        listing_status_checked_at: checkedAt
      }
    },
    changes
  };
};

export const importRemoteListings = async (
  config: RuntimeConfig,
  options: ImportRemoteListingsOptions = {},
  runtime?: RemoteListingsRuntime
): Promise<ImportRemoteListingsResult> => {
  const dryRun = options.dryRun ?? false;
  const downloadPhotosEnabled = options.downloadPhotos ?? true;
  const redownloadPhotos = (options.redownloadPhotos ?? false) && downloadPhotosEnabled;
  const checkedAt = new Date().toISOString();
  const root = getToSellRoot(config.cwd);
  await ensureToSellRoot(root);

  const { pairs } = await collectRemoteOffers(
    config,
    {
      activeOnly: options.activeOnly ?? false,
      limit: options.limit
    },
    runtime
  );

  const folders = await listListingFolders(root);
  const localStates: LocalListingState[] = await Promise.all(
    folders.map(async (listing) => ({ listing, status: await readStatusOrEmpty(listing.statusPath) }))
  );

  const byListingId = new Map<string, LocalListingState>();
  const bySlug = new Map<string, LocalListingState>();
  for (const state of localStates) {
    bySlug.set(state.listing.slug, state);
    if (state.status.ebay.listing_id) {
      byListingId.set(state.status.ebay.listing_id, state);
    }
  }

  const unlinked = localStates.filter((state) => !state.status.ebay.listing_id);

  const imported: ImportedListing[] = [];
  const refreshed: RefreshedListing[] = [];
  const skipped: SkippedRemoteListing[] = [];
  const duplicates: DuplicateCandidate[] = [];

  for (const { inventoryItem, offer } of pairs) {
    const sku = offer.sku ?? inventoryItem.sku ?? null;
    const listingId = offer.listing?.listingId ?? null;

    if (!sku) {
      skipped.push({
        sku: "",
        slug: null,
        reason: "missing_sku",
        detail: `Offer ${offer.offerId} senza SKU: impossibile derivare una cartella.`
      });
      continue;
    }

    const linked = listingId ? byListingId.get(listingId) : undefined;
    if (linked) {
      const { next, changes } = refreshLocalStatus(linked.status, offer, checkedAt);
      const linkedImageUrls = inventoryItem.product?.imageUrls ?? [];
      let linkedPhotos = { downloaded: 0, failed: 0 };

      if (!dryRun) {
        await writeStatus(linked.listing.statusPath, next);

        if (redownloadPhotos && linkedImageUrls.length > 0) {
          if (await hasOwnPhotos(linked.listing.photosDir)) {
            changes.push("foto locali gia' presenti: redownload saltato per non creare doppioni");
          } else {
            await clearImportedPhotos(linked.listing.photosDir);
            linkedPhotos = await downloadPhotos(linked.listing.photosDir, linkedImageUrls);
            changes.push(`foto reimportate: ${linkedPhotos.downloaded}`);
          }
        }
      } else if (redownloadPhotos) {
        linkedPhotos = { downloaded: linkedImageUrls.length, failed: 0 };
      }

      refreshed.push({
        slug: linked.listing.slug,
        listing_id: listingId,
        listing_status: offer.listing?.listingStatus ?? null,
        changes,
        photos_downloaded: linkedPhotos.downloaded,
        photos_failed: linkedPhotos.failed
      });
      continue;
    }

    const slug = deriveSlugFromRemote(sku, inventoryItem.product?.title ?? null);
    const collision = bySlug.get(slug);
    if (collision) {
      skipped.push({
        sku,
        slug,
        reason: "slug_taken",
        detail: `La cartella ${slug} esiste gia' e non e' collegata a questa listing: non viene sovrascritta.`
      });
      continue;
    }

    const draft = buildDraftFromRemote(inventoryItem, offer);
    if (!draft) {
      skipped.push({
        sku,
        slug,
        reason: "unusable_price",
        detail: `Offer ${offer.offerId} senza titolo o prezzo valido: draft non ricostruibile.`
      });
      continue;
    }

    const dir = path.join(root, slug);
    const photosDir = path.join(dir, "photos");
    const imageUrls = inventoryItem.product?.imageUrls ?? [];
    let photos = { downloaded: 0, failed: 0 };

    if (!dryRun) {
      await mkdir(dir, { recursive: true });
      await writeDraft(path.join(dir, "draft.json"), draft);
      await writeStatus(path.join(dir, "status.json"), remoteStatusFor(config, offer, sku, checkedAt));
      await writeFile(path.join(dir, "notes.txt"), importNotes(sku, listingId), "utf8");

      if (downloadPhotosEnabled && imageUrls.length > 0) {
        photos = await downloadPhotos(photosDir, imageUrls);
      }
    } else if (downloadPhotosEnabled) {
      photos = { downloaded: imageUrls.length, failed: 0 };
    }

    imported.push({
      slug,
      sku,
      offer_id: offer.offerId,
      listing_id: listingId,
      listing_status: offer.listing?.listingStatus ?? null,
      title: draft.title,
      photos_downloaded: photos.downloaded,
      photos_failed: photos.failed
    });

    for (const candidate of unlinked) {
      if (looksLikeSameListing(slug, candidate.listing.slug)) {
        duplicates.push({
          imported_slug: slug,
          local_slug: candidate.listing.slug,
          listing_id: listingId,
          detail:
            `${candidate.listing.slug} sembra lo stesso articolo di ${slug}, che risulta gia' su eBay. ` +
            "Verifica prima di pubblicarla: rischi un doppione."
        });
      }
    }
  }

  return {
    current_env: config.ebayEnv,
    marketplace_id: config.ebayMarketplaceId,
    dry_run: dryRun,
    remote_total: pairs.length,
    imported,
    refreshed,
    skipped,
    duplicates
  };
};
