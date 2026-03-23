import type { PublishConfiguration, RuntimeConfig } from "../config.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayInventoryClient } from "../ebay/inventory.js";
import { EbayMediaClient } from "../ebay/media.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import { logger } from "../logger.js";
import { describeShippingEconomics, shippingEconomicsLines } from "../shipping/economics.js";
import { getValidUserAccessToken } from "../token/token-store.js";
import type { Draft } from "../types.js";
import { descriptionPreview } from "../utils/description-preview.js";

export interface SellApiRuntime {
  accessToken: string;
  accountClient: EbayAccountClient;
  inventoryClient: EbayInventoryClient;
  mediaClient: EbayMediaClient;
}

export interface ListingReviewSummaryInput {
  draft: Draft;
  photoCount: number;
  resolvedShippingProfile?: string;
  priceLabel: string;
}

export const createSellApiRuntime = async (config: RuntimeConfig): Promise<SellApiRuntime> => {
  const oauthClient = createUserOAuthClient(config);
  const accessToken = await getValidUserAccessToken(config, oauthClient);

  return {
    accessToken,
    accountClient: new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl }),
    inventoryClient: new EbayInventoryClient({ apiBaseUrl: config.ebayApiBaseUrl }),
    mediaClient: new EbayMediaClient({ mediaBaseUrl: config.ebayMediaBaseUrl })
  };
};

export const buildListingReviewSummary = (
  config: RuntimeConfig,
  input: ListingReviewSummaryInput
): string => {
  const shippingEconomics = describeShippingEconomics(config, input.resolvedShippingProfile, {
    value: input.draft.price.target,
    currency: input.draft.price.currency
  });

  return [
    `Titolo: ${input.draft.title}`,
    `${input.priceLabel}: ${input.draft.price.target.toFixed(2)} ${input.draft.price.currency}`,
    `Shipping profile: ${input.resolvedShippingProfile ?? "default"}`,
    `Foto: ${input.photoCount}`,
    ...shippingEconomicsLines(shippingEconomics),
    `Descrizione (prime 3 righe):\n${descriptionPreview(input.draft.description)}`
  ].join("\n");
};

export const logFulfillmentResolution = (slug: string, publishConfig: PublishConfiguration): void => {
  if (!publishConfig.fulfillmentProfile) {
    return;
  }

  logger.info(
    `[${slug}] shipping_profile=${publishConfig.fulfillmentProfile} -> fulfillmentPolicyId=${publishConfig.policies.fulfillmentPolicyId}`
  );
};
