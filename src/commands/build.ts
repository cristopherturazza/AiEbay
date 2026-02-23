import { loadRuntimeConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildListing } from "../services/build-listing.js";
import { getToSellRoot, readStatusOrEmpty, resolveListing, writeStatus } from "../fs/listings.js";
import { toStatusError } from "../utils/status-error.js";

export const runBuild = async (folder: string): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const status = await readStatusOrEmpty(listing.statusPath);
  const previouslyPublished = status.state === "published" || Boolean(status.ebay.listing_id);

  try {
    const result = await buildListing(listing, config);
    status.state = previouslyPublished ? "published" : "ready";
    if (!previouslyPublished) {
      status.published_at = null;
    }
    status.last_error = null;
    status.ebay.sku = result.ebayBuild.sku;
    await writeStatus(listing.statusPath, status);

    logger.info(`[${listing.slug}] ebay.json generato con SKU ${result.ebayBuild.sku}`);
    logger.info(
      `[${listing.slug}] category_id=${result.ebayBuild.category_id}, prezzo=${result.ebayBuild.pricing_summary.price.value} ${result.ebayBuild.pricing_summary.price.currency}`
    );
  } catch (error) {
    status.state = previouslyPublished ? "published" : "error";
    status.last_error = toStatusError(error);
    await writeStatus(listing.statusPath, status);

    throw error;
  }
};
