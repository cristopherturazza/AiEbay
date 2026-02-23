import { loadRuntimeConfig, requirePublishConfiguration } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayInventoryClient } from "../ebay/inventory.js";
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

interface PublishOptions {
  yes?: boolean;
}

const descriptionPreview = (description: string): string => {
  return description
    .split(/\r?\n/)
    .slice(0, 3)
    .join("\n");
};

export const runPublish = async (folder: string, options: PublishOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);

  const status = await readStatusOrEmpty(listing.statusPath);
  const previouslyPublished = status.state === "published" || Boolean(status.ebay.listing_id);

  try {
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
      `Prezzo target: ${draft.price.target.toFixed(2)} ${draft.price.currency}`,
      `Foto: ${photoFiles.length}`,
      `Descrizione (prime 3 righe):\n${descriptionPreview(draft.description)}`
    ].join("\n");

    logger.info(`Riepilogo pubblicazione per '${listing.slug}':\n${summary}`);

    if (!options.yes) {
      const confirmed = await confirm("Confermare pubblicazione su eBay?");
      if (!confirmed) {
        logger.warn("Pubblicazione annullata dall'utente");
        return;
      }
    }

    const { ebayBuild } = await syncListingBuildFromDraft(listing, config);

    const publishConfig = requirePublishConfiguration(config);
    const oauthClient = createUserOAuthClient(config);

    const accessToken = await getValidUserAccessToken(config, oauthClient);

    const mediaClient = new EbayMediaClient({ mediaBaseUrl: config.ebayMediaBaseUrl });
    const inventoryClient = new EbayInventoryClient({ apiBaseUrl: config.ebayApiBaseUrl });
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });

    await validatePoliciesAndLocation(accountClient, accessToken, publishConfig);

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

    const offerId = await inventoryClient.createOffer(
      accessToken,
      {
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
      },
      ebayBuild.locale
    );

    const published = await inventoryClient.publishOffer(accessToken, offerId);

    status.state = "published";
    status.published_at = new Date().toISOString();
    status.last_error = null;
    status.ebay.sku = ebayBuild.sku;
    status.ebay.offer_id = offerId;
    status.ebay.listing_id = published.listingId ?? null;
    status.ebay.url = null;

    await writeStatus(listing.statusPath, status);

    logger.info(
      `[${listing.slug}] Pubblicata con successo. offer_id=${offerId}${
        published.listingId ? ` listing_id=${published.listingId}` : ""
      }`
    );
  } catch (error) {
    status.state = previouslyPublished ? "published" : "error";
    status.last_error = toStatusError(error);
    await writeStatus(listing.statusPath, status);
    throw error;
  }
};
