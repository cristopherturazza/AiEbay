import { loadRuntimeConfig, requirePublishConfiguration } from "../config.js";
import { EbayApiError } from "../ebay/http.js";
import {
  type CreateOfferPayload,
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
import { deriveDraftShippingProfile } from "../shipping/book-logistics.js";

interface PublishOptions {
  yes?: boolean;
}

interface EbayErrorParameter {
  name?: string;
  value?: string;
}

interface EbayErrorEntry {
  errorId?: number;
  parameters?: EbayErrorParameter[];
}

interface EbayErrorResponse {
  errors?: EbayErrorEntry[];
}

const getDuplicateOfferId = (error: unknown): string | null => {
  if (!(error instanceof EbayApiError)) {
    return null;
  }

  let parsed: EbayErrorResponse;
  try {
    parsed = JSON.parse(error.responseSnippet) as EbayErrorResponse;
  } catch {
    return null;
  }

  for (const entry of parsed.errors ?? []) {
    if (entry.errorId !== 25002) {
      continue;
    }

    for (const parameter of entry.parameters ?? []) {
      if (parameter.name === "offerId" && parameter.value) {
        return parameter.value;
      }
    }
  }

  return null;
};

export const runPublish = async (folder: string, options: PublishOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);

  const status = await readStatusOrEmpty(listing.statusPath);
  const previouslyPublished = hasPublishedListing(status);

  try {
    const { draft, photoFiles } = await readListingDraftInputs(listing);

    const resolvedShippingProfile = deriveDraftShippingProfile(draft);
    const summary = buildListingReviewSummary(config, {
      draft,
      photoCount: photoFiles.length,
      resolvedShippingProfile,
      priceLabel: "Prezzo target"
    });

    logger.info(`Riepilogo pubblicazione per '${listing.slug}':\n${summary}`);

    if (!options.yes) {
      const confirmed = await confirm("Confermare pubblicazione su eBay?");
      if (!confirmed) {
        logger.warn("Pubblicazione annullata dall'utente");
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

    const offerPayload: CreateOfferPayload = {
      sku: ebayBuild.sku,
      marketplaceId: ebayBuild.marketplace_id,
      format: ebayBuild.format,
      availableQuantity: ebayBuild.quantity,
      categoryId: ebayBuild.category_id,
      merchantLocationKey: publishConfig.merchantLocationKey,
      listingDescription: ebayBuild.listing_description,
      listingPolicies: {
        fulfillmentPolicyId: publishConfig.policies.fulfillmentPolicyId,
        paymentPolicyId: publishConfig.policies.paymentPolicyId,
        returnPolicyId: publishConfig.policies.returnPolicyId
      },
      listingDuration: ebayBuild.listing_duration,
      pricingSummary: ebayBuild.pricing_summary
    };

    const updateOfferPayload: UpdateOfferPayload = offerPayload;

    let offerId: string;
    try {
      offerId = await runtime.inventoryClient.createOffer(runtime.accessToken, offerPayload, ebayBuild.locale);
    } catch (error) {
      const duplicateOfferId = getDuplicateOfferId(error);
      if (!duplicateOfferId) {
        throw error;
      }

      offerId = duplicateOfferId;
      logger.warn(`[${listing.slug}] Offerta gia' esistente, riuso offer_id=${offerId}`);
      await runtime.inventoryClient.updateOffer(runtime.accessToken, offerId, updateOfferPayload, ebayBuild.locale);
      logger.info(`[${listing.slug}] Offerta esistente riallineata ai dati correnti`);
    }

    status.ebay.offer_id = offerId;

    const published = await runtime.inventoryClient.publishOffer(runtime.accessToken, offerId, ebayBuild.locale);

    status.state = "published";
    status.published_at = new Date().toISOString();
    status.last_error = null;
    status.ebay.sku = ebayBuild.sku;
    status.ebay.listing_id = published.listingId ?? null;
    status.ebay.url = published.listingId
      ? deriveListingUrl(config.ebayEnv, ebayBuild.marketplace_id, published.listingId)
      : null;

    await writeStatus(listing.statusPath, status);

    logger.info(
      `[${listing.slug}] Pubblicata con successo. offer_id=${offerId}${
        published.listingId ? ` listing_id=${published.listingId}` : ""
      }`
    );
  } catch (error) {
    await persistListingFailure(listing.statusPath, status, previouslyPublished, error);
    throw error;
  }
};
