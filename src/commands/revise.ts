import { loadRuntimeConfig, requirePublishConfiguration } from "../config.js";
import { SellbotError } from "../errors.js";
import {
  type OfferResponse,
  type UpdateOfferPayload
} from "../ebay/inventory.js";
import {
  getToSellRoot,
  readStatusOrEmpty,
  resolveListing,
  writeStatus
} from "../fs/listings.js";
import { logger } from "../logger.js";
import { syncListingBuildFromDraft } from "../services/build-listing.js";
import { readListingDraftInputs } from "../services/listing-inputs.js";
import { hasPublishedListing, persistListingFailure } from "../services/listing-status.js";
import { syncInventoryItemFromBuild, validatePoliciesAndLocation } from "../services/publish-helpers.js";
import { buildListingReviewSummary, createSellApiRuntime, logFulfillmentResolution } from "../services/sell-workflow.js";
import { confirm } from "../utils/confirm.js";
import { deriveListingUrl } from "../utils/listing-url.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";
import { deriveDraftShippingProfile } from "../shipping/book-logistics.js";

interface ReviseOptions {
  yes?: boolean;
}

const buildUpdateOfferPayload = (
  currentOffer: OfferResponse,
  listingBuild: Awaited<ReturnType<typeof syncListingBuildFromDraft>>["ebayBuild"],
  publishConfig: ReturnType<typeof requirePublishConfiguration>
): UpdateOfferPayload => {
  const payload: UpdateOfferPayload = {
    sku: currentOffer.sku ?? listingBuild.sku,
    marketplaceId: toRestMarketplaceId(currentOffer.marketplaceId ?? listingBuild.marketplace_id),
    format: currentOffer.format ?? listingBuild.format,
    availableQuantity: currentOffer.availableQuantity ?? listingBuild.quantity,
    categoryId: currentOffer.categoryId ?? listingBuild.category_id,
    merchantLocationKey: currentOffer.merchantLocationKey ?? publishConfig.merchantLocationKey,
    listingDescription: listingBuild.listing_description,
    listingPolicies: {
      ...(currentOffer.listingPolicies ?? {}),
      fulfillmentPolicyId: publishConfig.policies.fulfillmentPolicyId,
      paymentPolicyId: publishConfig.policies.paymentPolicyId,
      returnPolicyId: publishConfig.policies.returnPolicyId
    },
    listingDuration: currentOffer.listingDuration ?? listingBuild.listing_duration,
    pricingSummary: listingBuild.pricing_summary
  };

  if (currentOffer.includeCatalogProductDetails !== undefined) {
    payload.includeCatalogProductDetails = currentOffer.includeCatalogProductDetails;
  }

  if (currentOffer.hideBuyerDetails !== undefined) {
    payload.hideBuyerDetails = currentOffer.hideBuyerDetails;
  }

  if (currentOffer.quantityLimitPerBuyer !== undefined) {
    payload.quantityLimitPerBuyer = currentOffer.quantityLimitPerBuyer;
  }

  if (currentOffer.listingStartDate !== undefined) {
    payload.listingStartDate = currentOffer.listingStartDate;
  }

  if (currentOffer.lotSize !== undefined) {
    payload.lotSize = currentOffer.lotSize;
  }

  if (currentOffer.charity !== undefined) {
    payload.charity = currentOffer.charity;
  }

  if (currentOffer.extendedProducerResponsibility !== undefined) {
    payload.extendedProducerResponsibility = currentOffer.extendedProducerResponsibility;
  }

  if (currentOffer.tax !== undefined) {
    payload.tax = currentOffer.tax;
  }

  return payload;
};

export const runRevise = async (folder: string, options: ReviseOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);

  const status = await readStatusOrEmpty(listing.statusPath);
  const previouslyPublished = hasPublishedListing(status);

  try {
    const offerId = status.ebay.offer_id;
    if (!offerId) {
      throw new SellbotError(
        "OFFER_ID_MISSING",
        "status.json non contiene ebay.offer_id. Usa prima 'sellbot publish <folder>'."
      );
    }

    if (status.state !== "published") {
      logger.warn(
        `[${listing.slug}] status.state=${status.state}. Procedo comunque con revise perché offer_id è presente.`
      );
    }

    const { draft, photoFiles } = await readListingDraftInputs(listing);

    const resolvedShippingProfile = deriveDraftShippingProfile(draft);
    const summary = buildListingReviewSummary(config, {
      draft,
      photoCount: photoFiles.length,
      resolvedShippingProfile,
      priceLabel: "Nuovo prezzo target"
    });

    logger.info(`Riepilogo revisione per '${listing.slug}':\n${summary}`);

    if (!options.yes) {
      const confirmed = await confirm("Confermare revisione inserzione su eBay?");
      if (!confirmed) {
        logger.warn("Revisione annullata dall'utente");
        return;
      }
    }

    const { ebayBuild } = await syncListingBuildFromDraft(listing, config);
    const publishConfig = requirePublishConfiguration(config, {
      fulfillmentProfile: ebayBuild.shipping_profile
    });
    const runtime = await createSellApiRuntime(config);
    await validatePoliciesAndLocation(runtime.accountClient, runtime.accessToken, publishConfig);
    logFulfillmentResolution(listing.slug, publishConfig);

    await syncInventoryItemFromBuild({
      inventoryClient: runtime.inventoryClient,
      mediaClient: runtime.mediaClient,
      accessToken: runtime.accessToken,
      listingDir: listing.dir,
      ebayBuild
    });

    const currentOffer = await runtime.inventoryClient.getOffer(runtime.accessToken, offerId, ebayBuild.locale);
    const updatePayload = buildUpdateOfferPayload(currentOffer, ebayBuild, publishConfig);

    await runtime.inventoryClient.updateOffer(runtime.accessToken, offerId, updatePayload, ebayBuild.locale);

    status.state = "published";
    status.published_at = status.published_at ?? new Date().toISOString();
    status.last_error = null;
    status.ebay.sku = ebayBuild.sku;
    status.ebay.offer_id = offerId;
    status.ebay.listing_id = currentOffer.listing?.listingId ?? status.ebay.listing_id;
    status.ebay.url = status.ebay.listing_id
      ? deriveListingUrl(config.ebayEnv, updatePayload.marketplaceId, status.ebay.listing_id)
      : status.ebay.url;

    await writeStatus(listing.statusPath, status);

    logger.info(
      `[${listing.slug}] Revisione completata. offer_id=${offerId}${
        status.ebay.listing_id ? ` listing_id=${status.ebay.listing_id}` : ""
      }`
    );
  } catch (error) {
    await persistListingFailure(listing.statusPath, status, previouslyPublished, error);
    throw error;
  }
};
