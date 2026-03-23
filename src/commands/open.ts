import { loadRuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { getToSellRoot, readEbayBuild, readStatusOrEmpty, resolveListing, writeStatus } from "../fs/listings.js";
import { logger } from "../logger.js";
import { openInBrowser } from "../utils/browser.js";
import { deriveListingUrl } from "../utils/listing-url.js";

interface OpenOptions {
  printOnly?: boolean;
}

export const runOpen = async (folder: string, options: OpenOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const status = await readStatusOrEmpty(listing.statusPath);

  let listingUrl = status.ebay.url;

  if (!listingUrl) {
    if (!status.ebay.listing_id) {
      throw new SellbotError(
        "LISTING_URL_UNAVAILABLE",
        "status.json non contiene ebay.url ne' ebay.listing_id. Pubblica prima la listing."
      );
    }

    const ebayBuild = await readEbayBuild(listing.ebayPath);
    const marketplaceId = ebayBuild?.marketplace_id ?? config.ebayMarketplaceId;
    listingUrl = deriveListingUrl(config.ebayEnv, marketplaceId, status.ebay.listing_id);
    status.ebay.url = listingUrl;
    await writeStatus(listing.statusPath, status);
  }

  logger.info(`[${listing.slug}] URL listing: ${listingUrl}`);

  if (options.printOnly) {
    return;
  }

  try {
    await openInBrowser(listingUrl);
    logger.info(`[${listing.slug}] Browser aperto`);
  } catch (error) {
    logger.warn(
      `[${listing.slug}] Impossibile aprire il browser automaticamente: ${(error as Error).message}`
    );
  }
};
