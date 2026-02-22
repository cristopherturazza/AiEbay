import path from "node:path";
import { loadRuntimeConfig, missingPublishConfigItems, requireOAuthConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayInventoryClient } from "../ebay/inventory.js";
import { EbayMediaClient } from "../ebay/media.js";
import { EbayOAuthClient } from "../ebay/oauth.js";
import {
  emptyStatus,
  getToSellRoot,
  listPhotoFiles,
  readDraft,
  readEbayBuild,
  readStatus,
  resolveListing,
  writeStatus
} from "../fs/listings.js";
import { logger } from "../logger.js";
import { buildListing } from "../services/build-listing.js";
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

  let status;
  try {
    status = await readStatus(listing.statusPath);
  } catch {
    status = emptyStatus();
  }

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

    let ebayBuild = await readEbayBuild(listing.ebayPath);
    if (!ebayBuild) {
      logger.info("ebay.json non trovato: eseguo build automatica");
      ebayBuild = (await buildListing(listing, config)).ebayBuild;
    }

    const missingConfig = missingPublishConfigItems(config);
    if (missingConfig.length > 0) {
      throw new SellbotError(
        "PUBLISH_CONFIG_MISSING",
        `Configurazione incompleta in sellbot.config.json: ${missingConfig.join(", ")}`
      );
    }

    const oauthConfig = requireOAuthConfig(config);
    const oauthClient = new EbayOAuthClient({
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      redirectUri: oauthConfig.redirectUri,
      scopes: config.ebayScopes,
      environment: config.ebayEnv === "sandbox" ? "SANDBOX" : "PRODUCTION",
      authBaseUrl: config.ebayAuthBaseUrl,
      apiBaseUrl: config.ebayApiBaseUrl
    });

    const accessToken = await getValidUserAccessToken(config, oauthClient);

    const mediaClient = new EbayMediaClient({ mediaBaseUrl: config.ebayMediaBaseUrl });
    const inventoryClient = new EbayInventoryClient({ apiBaseUrl: config.ebayApiBaseUrl });
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });

    // Validazioni read-only immediate delle policy/location prima di creare offer.
    await accountClient.getFulfillmentPolicy(accessToken, config.policies.fulfillmentPolicyId!);
    await accountClient.getPaymentPolicy(accessToken, config.policies.paymentPolicyId!);
    await accountClient.getReturnPolicy(accessToken, config.policies.returnPolicyId!);
    await accountClient.getInventoryLocation(accessToken, config.merchantLocationKey!);

    const uploadedImageUrls: string[] = [];

    for (const imageFile of ebayBuild.product.image_files) {
      const absolutePath = path.isAbsolute(imageFile) ? imageFile : path.join(listing.dir, imageFile);
      const imageUrl = await mediaClient.uploadImage(accessToken, absolutePath);
      uploadedImageUrls.push(imageUrl);
      logger.info(`Immagine caricata: ${path.basename(absolutePath)}`);
    }

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
        merchantLocationKey: config.merchantLocationKey!,
        listingDescription: ebayBuild.listing_description,
        listingPolicies: {
          fulfillmentPolicyId: config.policies.fulfillmentPolicyId!,
          paymentPolicyId: config.policies.paymentPolicyId!,
          returnPolicyId: config.policies.returnPolicyId!
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
    status.state = "error";
    status.last_error = toStatusError(error);
    await writeStatus(listing.statusPath, status);
    throw error;
  }
};
