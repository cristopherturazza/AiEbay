import path from "node:path";
import type { PublishConfiguration } from "../config.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayMediaClient } from "../ebay/media.js";
import { logger } from "../logger.js";

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

export const uploadListingImages = async (
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
