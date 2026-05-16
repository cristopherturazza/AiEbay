import type { RuntimeConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayApiError } from "../ebay/http.js";
import {
  getToSellRoot,
  readStatusOrEmpty,
  resolveListing,
  writeStatus
} from "../fs/listings.js";
import { logger } from "../logger.js";
import { createSellApiRuntime } from "./sell-workflow.js";

export interface EndListingOnEbayOptions {
  /**
   * When true, also delete the inventory offer record (POST withdraw then DELETE offer).
   * Default: false (only withdraws the public listing).
   */
  delete_offer?: boolean;
}

export interface EndListingOnEbayResult {
  slug: string;
  dir: string;
  ebay_env: RuntimeConfig["ebayEnv"];
  offer_id: string | null;
  listing_id: string | null;
  withdrawn: boolean;
  offer_deleted: boolean;
  previous_state: string;
  next_state: string;
  warnings: string[];
}

const isOfferNotPublishedError = (error: unknown): boolean => {
  if (!(error instanceof EbayApiError)) {
    return false;
  }
  // eBay error 25007 / "Offer is not published" is the typical signal when
  // an offer was created but never published (or already withdrawn).
  return /not\s+published|not\s+a\s+published|25007/i.test(error.responseSnippet);
};

export const endListingOnEbay = async (
  config: RuntimeConfig,
  slugOrPath: string,
  options: EndListingOnEbayOptions = {}
): Promise<EndListingOnEbayResult> => {
  const root = getToSellRoot(config.cwd);
  const listing = await resolveListing(root, slugOrPath);
  const status = await readStatusOrEmpty(listing.statusPath);
  const offerId = status.ebay.offer_id;
  const warnings: string[] = [];

  if (!offerId) {
    throw new SellbotError(
      "OFFER_MISSING",
      `Listing ${listing.slug} non ha un offer_id registrato in status.json: impossibile ritirare la pubblicazione su eBay.`,
      { slug: listing.slug, state: status.state }
    );
  }

  const runtime = await createSellApiRuntime(config);
  const locale = config.locale;

  let withdrawn = false;
  try {
    await runtime.inventoryClient.withdrawOffer(runtime.accessToken, offerId, locale);
    withdrawn = true;
    logger.info(`[${listing.slug}] Offerta ${offerId} ritirata da eBay (${config.ebayEnv})`);
  } catch (error) {
    if (!isOfferNotPublishedError(error)) {
      throw error;
    }
    warnings.push("L'offerta non risultava pubblicata su eBay: nessun ritiro necessario.");
    logger.warn(`[${listing.slug}] Offerta ${offerId} gia' non pubblicata, skip withdraw`);
  }

  let offerDeleted = false;
  if (options.delete_offer) {
    try {
      await runtime.inventoryClient.deleteOffer(runtime.accessToken, offerId, locale);
      offerDeleted = true;
      logger.info(`[${listing.slug}] Offerta ${offerId} eliminata da Inventory API`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Impossibile eliminare l'offerta dopo il withdraw: ${message}`);
      logger.warn(`[${listing.slug}] deleteOffer fallita: ${message}`);
    }
  }

  const previousState = status.state;
  status.state = "draft";
  status.published_at = null;
  status.ebay.listing_id = null;
  status.ebay.url = null;
  if (offerDeleted) {
    status.ebay.offer_id = null;
  }
  status.last_error = null;
  await writeStatus(listing.statusPath, status);

  return {
    slug: listing.slug,
    dir: listing.dir,
    ebay_env: config.ebayEnv,
    offer_id: offerDeleted ? null : offerId,
    listing_id: status.ebay.listing_id,
    withdrawn,
    offer_deleted: offerDeleted,
    previous_state: previousState,
    next_state: status.state,
    warnings
  };
};
