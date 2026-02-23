import { loadRuntimeConfig, requirePublishConfiguration } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayAccountClient } from "../ebay/account.js";
import {
  EbayInventoryClient,
  type OfferResponse,
  type UpdateOfferPayload
} from "../ebay/inventory.js";
import { EbayMediaClient } from "../ebay/media.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import {
  getToSellRoot,
  listPhotoFiles,
  readDraft,
  readStatusOrEmpty,
  resolveListing,
  writeStatus
} from "../fs/listings.js";
import { logger } from "../logger.js";
import { syncListingBuildFromDraft } from "../services/build-listing.js";
import { uploadListingImages, validatePoliciesAndLocation } from "../services/publish-helpers.js";
import { getValidUserAccessToken } from "../token/token-store.js";
import { confirm } from "../utils/confirm.js";
import { toStatusError } from "../utils/status-error.js";

interface ReviseOptions {
  yes?: boolean;
}

const descriptionPreview = (description: string): string => {
  return description
    .split(/\r?\n/)
    .slice(0, 3)
    .join("\n");
};

const buildUpdateOfferPayload = (
  currentOffer: OfferResponse,
  listingBuild: Awaited<ReturnType<typeof syncListingBuildFromDraft>>["ebayBuild"],
  publishConfig: ReturnType<typeof requirePublishConfiguration>
): UpdateOfferPayload => {
  const payload: UpdateOfferPayload = {
    sku: currentOffer.sku ?? listingBuild.sku,
    marketplaceId: currentOffer.marketplaceId ?? listingBuild.marketplace_id,
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
  const previouslyPublished = status.state === "published" || Boolean(status.ebay.listing_id);

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

    const draft = await readDraft(listing.draftPath);
    if (!draft) {
      throw new SellbotError("DRAFT_MISSING", `draft.json mancante in ${listing.dir}`);
    }

    const photoFiles = await listPhotoFiles(listing.photosDir);
    if (photoFiles.length === 0) {
      throw new SellbotError("PHOTOS_MISSING", `Nessuna immagine trovata in ${listing.photosDir}`);
    }

    const summary = [
      `Titolo: ${draft.title}`,
      `Nuovo prezzo target: ${draft.price.target.toFixed(2)} ${draft.price.currency}`,
      `Foto: ${photoFiles.length}`,
      `Descrizione (prime 3 righe):\n${descriptionPreview(draft.description)}`
    ].join("\n");

    logger.info(`Riepilogo revisione per '${listing.slug}':\n${summary}`);

    if (!options.yes) {
      const confirmed = await confirm("Confermare revisione inserzione su eBay?");
      if (!confirmed) {
        logger.warn("Revisione annullata dall'utente");
        return;
      }
    }

    const publishConfig = requirePublishConfiguration(config);
    const oauthClient = createUserOAuthClient(config);
    const accessToken = await getValidUserAccessToken(config, oauthClient);

    const inventoryClient = new EbayInventoryClient({ apiBaseUrl: config.ebayApiBaseUrl });
    const mediaClient = new EbayMediaClient({ mediaBaseUrl: config.ebayMediaBaseUrl });
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });

    await validatePoliciesAndLocation(accountClient, accessToken, publishConfig);

    const { ebayBuild } = await syncListingBuildFromDraft(listing, config);

    const uploadedImageUrls = await uploadListingImages(
      mediaClient,
      accessToken,
      listing.dir,
      ebayBuild.product.image_files
    );

    await inventoryClient.upsertInventoryItem(
      accessToken,
      ebayBuild.sku,
      {
        availability: {
          shipToLocationAvailability: {
            quantity: ebayBuild.quantity
          }
        },
        condition: ebayBuild.condition,
        product: {
          title: ebayBuild.product.title,
          description: ebayBuild.product.description,
          imageUrls: uploadedImageUrls,
          aspects: ebayBuild.product.aspects
        }
      },
      ebayBuild.locale
    );

    const currentOffer = await inventoryClient.getOffer(accessToken, offerId);
    const updatePayload = buildUpdateOfferPayload(currentOffer, ebayBuild, publishConfig);

    await inventoryClient.updateOffer(accessToken, offerId, updatePayload, ebayBuild.locale);

    status.state = "published";
    status.published_at = status.published_at ?? new Date().toISOString();
    status.last_error = null;
    status.ebay.sku = ebayBuild.sku;
    status.ebay.offer_id = offerId;
    status.ebay.listing_id = currentOffer.listing?.listingId ?? status.ebay.listing_id;

    await writeStatus(listing.statusPath, status);

    logger.info(
      `[${listing.slug}] Revisione completata. offer_id=${offerId}${
        status.ebay.listing_id ? ` listing_id=${status.ebay.listing_id}` : ""
      }`
    );
  } catch (error) {
    status.state = previouslyPublished ? "published" : "error";
    status.last_error = toStatusError(error);
    await writeStatus(listing.statusPath, status);
    throw error;
  }
};
