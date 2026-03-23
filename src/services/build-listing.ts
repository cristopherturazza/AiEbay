import path from "node:path";
import { type RuntimeConfig } from "../config.js";
import { readEbayBuild, writeEbayBuild, type ListingPaths } from "../fs/listings.js";
import { createAppOAuthClient } from "../ebay/oauth-client-factory.js";
import { EbayTaxonomyClient } from "../ebay/taxonomy.js";
import type { EbayBuild } from "../types.js";
import { mapDraftConditionToInventoryCondition } from "../utils/conditions.js";
import { renderEbayListingDescription } from "../utils/ebay-description.js";
import { toRestMarketplaceId } from "../utils/marketplace.js";
import { makeSku } from "../utils/sku.js";
import { deriveDraftShippingProfile } from "../shipping/book-logistics.js";
import { readListingDraftInputs } from "./listing-inputs.js";

export interface BuildListingResult {
  listing: ListingPaths;
  ebayBuild: EbayBuild;
  photoFiles: string[];
}

export const normalizeAspects = (input: Record<string, string>): Record<string, string[]> => {
  const output: Record<string, string[]> = {};

  for (const [key, value] of Object.entries(input)) {
    const aspectKey = key.trim();
    const aspectValue = value.trim();

    if (!aspectKey || !aspectValue) {
      continue;
    }

    output[aspectKey] = [aspectValue];
  }

  return output;
};

const relativeImageFiles = (photoFiles: string[]): string[] => {
  return photoFiles.map((fileName) => path.join("photos", fileName));
};

const normalizeShippingProfile = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
};

const resolveCategoryId = async (
  config: RuntimeConfig,
  categoryHint: string,
  explicitCategoryId?: string
): Promise<string> => {
  if (explicitCategoryId) {
    return explicitCategoryId;
  }

  const oauthClient = createAppOAuthClient(config);

  const appToken = await oauthClient.createApplicationToken();
  const taxonomyClient = new EbayTaxonomyClient({ apiBaseUrl: config.ebayApiBaseUrl });

  // Sandbox limitation documented by eBay: category suggestions may be less reliable.
  // https://developer.ebay.com/api-docs/commerce/taxonomy/resources/category_tree/methods/getCategorySuggestions
  return taxonomyClient.resolveCategoryId(
    appToken.access_token,
    toRestMarketplaceId(config.ebayMarketplaceId),
    categoryHint
  );
};

export const buildListing = async (
  listing: ListingPaths,
  config: RuntimeConfig
): Promise<BuildListingResult> => {
  const { draft, photoFiles } = await readListingDraftInputs(listing);

  const categoryId = await resolveCategoryId(config, draft.category_hint, draft.category_id);
  const sku = makeSku(listing.slug);

  const ebayBuild: EbayBuild = {
    version: 1,
    generated_at: new Date().toISOString(),
    slug: listing.slug,
    sku,
    shipping_profile: normalizeShippingProfile(deriveDraftShippingProfile(draft)),
    marketplace_id: toRestMarketplaceId(config.ebayMarketplaceId),
    locale: config.locale,
    quantity: 1,
    format: "FIXED_PRICE",
    listing_duration: "GTC",
    category_id: categoryId,
    condition: mapDraftConditionToInventoryCondition(draft.condition),
    pricing_summary: {
      price: {
        value: draft.price.target.toFixed(2),
        currency: draft.price.currency
      }
    },
    listing_description: renderEbayListingDescription(draft.description),
    product: {
      title: draft.title,
      description: draft.description,
      aspects: normalizeAspects(draft.item_specifics),
      image_files: relativeImageFiles(photoFiles)
    }
  };

  await writeEbayBuild(listing.ebayPath, ebayBuild);

  return {
    listing,
    ebayBuild,
    photoFiles
  };
};

// Keeps previously computed immutable metadata (SKU/category/quantity) when possible,
// while refreshing mutable fields (description, aspects, price, photos) from draft/filesystem.
export const syncListingBuildFromDraft = async (
  listing: ListingPaths,
  config: RuntimeConfig
): Promise<BuildListingResult> => {
  const { draft, photoFiles } = await readListingDraftInputs(listing);
  const existingBuild = await readEbayBuild(listing.ebayPath);

  if (!existingBuild) {
    return buildListing(listing, config);
  }

  let categoryId = draft.category_id ?? existingBuild.category_id;
  if (!categoryId) {
    categoryId = await resolveCategoryId(config, draft.category_hint, undefined);
  }

  const ebayBuild: EbayBuild = {
    ...existingBuild,
    generated_at: new Date().toISOString(),
    slug: listing.slug,
    sku: existingBuild.sku || makeSku(listing.slug),
    shipping_profile:
      normalizeShippingProfile(deriveDraftShippingProfile(draft)) ??
      normalizeShippingProfile(existingBuild.shipping_profile),
    marketplace_id: toRestMarketplaceId(existingBuild.marketplace_id || config.ebayMarketplaceId),
    locale: existingBuild.locale || config.locale,
    quantity: existingBuild.quantity > 0 ? existingBuild.quantity : 1,
    format: "FIXED_PRICE",
    listing_duration: existingBuild.listing_duration || "GTC",
    category_id: categoryId,
    condition: mapDraftConditionToInventoryCondition(draft.condition),
    pricing_summary: {
      price: {
        value: draft.price.target.toFixed(2),
        currency: draft.price.currency
      }
    },
    listing_description: renderEbayListingDescription(draft.description),
    product: {
      ...existingBuild.product,
      title: draft.title,
      description: draft.description,
      aspects: normalizeAspects(draft.item_specifics),
      image_files: relativeImageFiles(photoFiles)
    }
  };

  await writeEbayBuild(listing.ebayPath, ebayBuild);

  return {
    listing,
    ebayBuild,
    photoFiles
  };
};
