import { rm } from "node:fs/promises";
import type { RuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import {
  getToSellRoot,
  listListingFolders,
  readStatusOrEmpty,
  resolveListing
} from "../fs/listings.js";

export interface DeleteListingOptions {
  force?: boolean;
}

export interface DeleteListingResult {
  slug: string;
  dir: string;
  was_published: boolean;
  ebay_offer_id: string | null;
  ebay_listing_id: string | null;
}

export const deleteListing = async (
  config: RuntimeConfig,
  slugOrPath: string,
  options: DeleteListingOptions = {}
): Promise<DeleteListingResult> => {
  const root = getToSellRoot(config.cwd);
  const listing = await resolveListing(root, slugOrPath);
  const status = await readStatusOrEmpty(listing.statusPath);
  const wasPublished = status.state === "published";

  if (wasPublished && !options.force) {
    throw new SellbotError(
      "LISTING_PUBLISHED",
      `Listing ${listing.slug} è in stato 'published' su eBay (${config.ebayEnv}). ` +
        `Cancellare la cartella locale NON ritira la pubblicazione: usa prima 'sellbot_listing_revise' o ritira manualmente. ` +
        `Per forzare comunque la cancellazione locale, ripassa con force=true.`,
      {
        slug: listing.slug,
        ebay_env: config.ebayEnv,
        offer_id: status.ebay.offer_id,
        listing_id: status.ebay.listing_id,
        url: status.ebay.url
      }
    );
  }

  await rm(listing.dir, { recursive: true, force: true });

  return {
    slug: listing.slug,
    dir: listing.dir,
    was_published: wasPublished,
    ebay_offer_id: status.ebay.offer_id,
    ebay_listing_id: status.ebay.listing_id
  };
};

export type DeletableState = "draft" | "ready" | "error" | "published";

export const DEFAULT_BULK_DELETE_STATES: ReadonlySet<DeletableState> = new Set([
  "draft",
  "ready",
  "error"
]);

export interface BulkDeleteListingsOptions {
  states?: ReadonlySet<DeletableState>;
  includePublished?: boolean;
}

export interface BulkDeleteSkipped {
  slug: string;
  state: string;
  reason: "state_excluded" | "published_protected";
}

export interface BulkDeleteListingsResult {
  deleted: Array<{ slug: string; state: string }>;
  skipped: BulkDeleteSkipped[];
  total_scanned: number;
}

export const deleteListingsBulk = async (
  config: RuntimeConfig,
  options: BulkDeleteListingsOptions = {}
): Promise<BulkDeleteListingsResult> => {
  const root = getToSellRoot(config.cwd);
  const states = options.states ?? DEFAULT_BULK_DELETE_STATES;
  const includePublished = Boolean(options.includePublished);

  const listings = await listListingFolders(root);
  const deleted: BulkDeleteListingsResult["deleted"] = [];
  const skipped: BulkDeleteSkipped[] = [];

  for (const listing of listings) {
    const status = await readStatusOrEmpty(listing.statusPath);
    const state = status.state;

    const stateAllowed = states.has(state as DeletableState);
    const isPublished = state === "published";

    if (isPublished && !includePublished) {
      skipped.push({ slug: listing.slug, state, reason: "published_protected" });
      continue;
    }

    if (!stateAllowed && !(isPublished && includePublished)) {
      skipped.push({ slug: listing.slug, state, reason: "state_excluded" });
      continue;
    }

    await rm(listing.dir, { recursive: true, force: true });
    deleted.push({ slug: listing.slug, state });
  }

  return {
    deleted,
    skipped,
    total_scanned: listings.length
  };
};
