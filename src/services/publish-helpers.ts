import path from "node:path";
import type { PublishConfiguration } from "../config.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayInventoryClient } from "../ebay/inventory.js";
import { EbayMediaClient } from "../ebay/media.js";
import { logger } from "../logger.js";
import type { EbayBuild } from "../types.js";

export const validatePoliciesAndLocation = async (
  accountClient: EbayAccountClient,
  accessToken: string,
  publishConfig: PublishConfiguration
): Promise<void> => {
  // Check read-only resources before performing any write operation.
  await accountClient.getFulfillmentPolicy(accessToken, publishConfig.policies.fulfillmentPolicyId);
  await accountClient.getPaymentPolicy(accessToken, publishConfig.policies.paymentPolicyId);
  await accountClient.getReturnPolicy(accessToken, publishConfig.policies.returnPolicyId);
  await accountClient.getInventoryLocation(accessToken, publishConfig.merchantLocationKey);
};

const uploadListingImages = async (
  mediaClient: EbayMediaClient,
  accessToken: string,
  listingDir: string,
  imageFiles: string[]
): Promise<string[]> => {
  const uploadedImageUrls: string[] = [];

  for (const imageFile of imageFiles) {
    const absolutePath = path.isAbsolute(imageFile) ? imageFile : path.join(listingDir, imageFile);
    const imageUrl = await mediaClient.uploadImage(accessToken, absolutePath);
    uploadedImageUrls.push(imageUrl);
    logger.info(`Immagine caricata: ${path.basename(absolutePath)}`);
  }

  return uploadedImageUrls;
};

interface SyncInventoryItemFromBuildOptions {
  inventoryClient: EbayInventoryClient;
  mediaClient: EbayMediaClient;
  accessToken: string;
  listingDir: string;
  ebayBuild: EbayBuild;
}

export const syncInventoryItemFromBuild = async (
  options: SyncInventoryItemFromBuildOptions
): Promise<string[]> => {
  const uploadedImageUrls = await uploadListingImages(
    options.mediaClient,
    options.accessToken,
    options.listingDir,
    options.ebayBuild.product.image_files
  );

  await options.inventoryClient.upsertInventoryItem(
    options.accessToken,
    options.ebayBuild.sku,
    {
      availability: {
        shipToLocationAvailability: {
          quantity: options.ebayBuild.quantity
        }
      },
      condition: options.ebayBuild.condition,
      product: {
        title: options.ebayBuild.product.title,
        description: options.ebayBuild.product.description,
        imageUrls: uploadedImageUrls,
        aspects: options.ebayBuild.product.aspects
      }
    },
    options.ebayBuild.locale
  );

  return uploadedImageUrls;
};
