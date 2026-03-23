import { loadRuntimeConfig, missingPublishConfigItems, requirePublishConfiguration, type RuntimeConfig } from "../config.js";
import { EbayMetadataClient } from "../ebay/metadata.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayTaxonomyClient } from "../ebay/taxonomy.js";
import { SellbotError } from "../errors.js";
import { getToSellRoot, listPhotoFiles, readDraft, resolveListing, type ListingPaths } from "../fs/listings.js";
import { syncListingBuildFromDraft } from "./build-listing.js";
import { describeShippingEconomics, shippingEconomicsLines } from "../shipping/economics.js";
import { createSellApiRuntime } from "./sell-workflow.js";
import { conditionIdByInventoryEnum } from "../utils/condition-ids.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";
import type { EbayBuild } from "../types.js";

export interface PublishPreflightCheckResult {
  name: string;
  level: "OK" | "WARN" | "KO";
  detail?: string;
}

export interface PublishPreflightResult {
  listing: ListingPaths;
  ebayBuild: EbayBuild;
  checks: PublishPreflightCheckResult[];
}

const normalizeAspectName = (value: string): string => value.trim().toLowerCase();

export const runPublishPreflightChecks = async (
  folder: string,
  configOverride?: RuntimeConfig
): Promise<PublishPreflightResult> => {
  const config = configOverride ?? (await loadRuntimeConfig());
  const listing = await resolveListing(getToSellRoot(config.cwd), folder);
  const checks: PublishPreflightCheckResult[] = [];
  const draft = await readDraft(listing.draftPath);

  if (!draft) {
    throw new SellbotError("DRAFT_MISSING", `draft.json mancante in ${listing.dir}`);
  }

  const photoFiles = await listPhotoFiles(listing.photosDir);
  checks.push({
    name: "Foto presenti",
    level: photoFiles.length > 0 ? "OK" : "KO",
    detail: photoFiles.length > 0 ? `${photoFiles.length} file` : "nessuna immagine trovata"
  });

  if (config.ebayEnv === "sandbox" && !draft.category_id) {
    checks.push({
      name: "Sandbox taxonomy warning",
      level: "WARN",
      detail:
        "getCategorySuggestions in sandbox e' documentato da eBay come non pienamente supportato. Meglio fissare draft.category_id prima del publish."
    });
  }

  const { ebayBuild } = await syncListingBuildFromDraft(listing, config);
  const missingConfig = missingPublishConfigItems(config, {
    fulfillmentProfile: ebayBuild.shipping_profile
  });
  checks.push({
    name: "Config publish",
    level: missingConfig.length === 0 ? "OK" : "KO",
    detail:
      missingConfig.length === 0
        ? ebayBuild.shipping_profile
          ? `shipping_profile=${ebayBuild.shipping_profile}`
          : undefined
        : missingConfig.join(", ")
  });

  const shippingEconomics = describeShippingEconomics(config, ebayBuild.shipping_profile, {
    value: Number.parseFloat(ebayBuild.pricing_summary.price.value),
    currency: ebayBuild.pricing_summary.price.currency
  });
  checks.push({
    name: "Shipping economics",
    level:
      shippingEconomics === null
        ? "WARN"
        : shippingEconomics.warnings.length > 0
          ? "WARN"
          : "OK",
    detail: shippingEconomicsLines(shippingEconomics).join(" | ")
  });

  const appClient = createAppOAuthClient(config);
  const appToken = await appClient.createApplicationToken();
  const taxonomyClient = new EbayTaxonomyClient({ apiBaseUrl: config.ebayApiBaseUrl });
  const metadataClient = new EbayMetadataClient({ apiBaseUrl: config.ebayApiBaseUrl });
  const marketplaceId = toRestMarketplaceId(config.ebayMarketplaceId);
  const treeId = await taxonomyClient.getDefaultCategoryTreeId(appToken.access_token, marketplaceId);

  const conditionPolicies = await metadataClient.getItemConditionPolicies(appToken.access_token, marketplaceId, [
    ebayBuild.category_id
  ]);
  const policy = conditionPolicies[0];
  const expectedConditionId = conditionIdByInventoryEnum[ebayBuild.condition];
  const conditionAllowed = Boolean(
    expectedConditionId &&
      policy?.itemConditions.some((condition) => condition.conditionId === expectedConditionId)
  );

  checks.push({
    name: "Condizione ammessa per categoria",
    level: conditionAllowed ? "OK" : "KO",
    detail: conditionAllowed
      ? `${ebayBuild.condition} consentita in category_id=${ebayBuild.category_id}`
      : `${ebayBuild.condition} non consentita in category_id=${ebayBuild.category_id}`
  });

  const aspects = await taxonomyClient.getItemAspectsForCategory(
    appToken.access_token,
    treeId,
    ebayBuild.category_id
  );
  const aspectByName = new Map(
    aspects.map((aspect) => [normalizeAspectName(aspect.localizedAspectName), aspect])
  );
  const providedAspects = Object.entries(ebayBuild.product.aspects);

  const missingRequired = aspects
    .filter((aspect) => aspect.aspectConstraint?.aspectRequired)
    .map((aspect) => aspect.localizedAspectName)
    .filter((aspectName) => !ebayBuild.product.aspects[aspectName]);

  checks.push({
    name: "Required aspects",
    level: missingRequired.length === 0 ? "OK" : "WARN",
    detail: missingRequired.length === 0 ? undefined : missingRequired.join(", ")
  });

  const overlongAspectValues: string[] = [];
  for (const [aspectName, values] of providedAspects) {
    const metadata = aspectByName.get(normalizeAspectName(aspectName));
    const maxLength = metadata?.aspectConstraint?.aspectMaxLength;
    if (!maxLength) {
      continue;
    }

    for (const value of values) {
      if (value.length > maxLength) {
        overlongAspectValues.push(`${aspectName} (${value.length}>${maxLength})`);
      }
    }
  }

  checks.push({
    name: "Aspect value lengths",
    level: overlongAspectValues.length === 0 ? "OK" : "KO",
    detail: overlongAspectValues.length === 0 ? undefined : overlongAspectValues.join(", ")
  });

  if (missingConfig.length === 0) {
    const publishConfig = requirePublishConfiguration(config, {
      fulfillmentProfile: ebayBuild.shipping_profile
    });
    try {
      const runtime = await createSellApiRuntime(config);
      await Promise.all([
        runtime.accountClient.getFulfillmentPolicy(runtime.accessToken, publishConfig.policies.fulfillmentPolicyId),
        runtime.accountClient.getPaymentPolicy(runtime.accessToken, publishConfig.policies.paymentPolicyId),
        runtime.accountClient.getReturnPolicy(runtime.accessToken, publishConfig.policies.returnPolicyId),
        runtime.accountClient.getInventoryLocation(runtime.accessToken, publishConfig.merchantLocationKey)
      ]);
      checks.push({ name: "Policy e location accessibili", level: "OK" });
    } catch (error) {
      checks.push({
        name: "Policy e location accessibili",
        level: "KO",
        detail: (error as Error).message
      });
    }
  }

  return {
    listing,
    ebayBuild,
    checks
  };
};
