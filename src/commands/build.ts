import { loadRuntimeConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildListing } from "../services/build-listing.js";
import { emptyStatus, getToSellRoot, readStatus, resolveListing, writeStatus } from "../fs/listings.js";
import { toStatusError } from "../utils/status-error.js";

export const runBuild = async (folder: string): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);

  try {
    const result = await buildListing(listing, config);

    let status;
    try {
      status = await readStatus(listing.statusPath);
    } catch {
      status = emptyStatus();
    }

    status.state = "ready";
    status.published_at = null;
    status.last_error = null;
    status.ebay.sku = result.ebayBuild.sku;
    await writeStatus(listing.statusPath, status);

    logger.info(`[${listing.slug}] ebay.json generato con SKU ${result.ebayBuild.sku}`);
    logger.info(
      `[${listing.slug}] category_id=${result.ebayBuild.category_id}, prezzo=${result.ebayBuild.pricing_summary.price.value} ${result.ebayBuild.pricing_summary.price.currency}`
    );
  } catch (error) {
    let status;
    try {
      status = await readStatus(listing.statusPath);
    } catch {
      status = emptyStatus();
    }

    status.state = "error";
    status.last_error = toStatusError(error);
    await writeStatus(listing.statusPath, status);

    throw error;
  }
};
