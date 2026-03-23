import { loadRuntimeConfig } from "../config.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayMetadataClient } from "../ebay/metadata.js";
import { logger } from "../logger.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";

export const runCategoryConditions = async (categoryId: string): Promise<void> => {
  const config = await loadRuntimeConfig();
  const oauthClient = createAppOAuthClient(config);
  const accessToken = await oauthClient.createApplicationToken();
  const metadataClient = new EbayMetadataClient({ apiBaseUrl: config.ebayApiBaseUrl });
  const marketplaceId = toRestMarketplaceId(config.ebayMarketplaceId);

  const policies = await metadataClient.getItemConditionPolicies(accessToken.access_token, marketplaceId, [
    categoryId
  ]);

  const policy = policies[0];
  if (!policy) {
    logger.warn(`Nessuna condition policy trovata per category_id=${categoryId} marketplace=${marketplaceId}`);
    return;
  }

  logger.info(
    `Condition policy per category_id=${policy.categoryId} marketplace=${marketplaceId} required=${policy.itemConditionRequired}`
  );

  for (const condition of policy.itemConditions) {
    logger.info(`- ${condition.conditionId}: ${condition.conditionDescription}`);
  }
};
