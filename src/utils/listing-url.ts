import type { EbayEnvironment } from "../ebay/urls.js";
import { toRestMarketplaceId } from "./marketplace.js";

const productionHostByMarketplace: Record<string, string> = {
  EBAY_IT: "https://www.ebay.it",
  EBAY_DE: "https://www.ebay.de",
  EBAY_FR: "https://www.ebay.fr",
  EBAY_ES: "https://www.ebay.es",
  EBAY_GB: "https://www.ebay.co.uk",
  EBAY_US: "https://www.ebay.com"
};

export const deriveListingUrl = (
  ebayEnv: EbayEnvironment,
  marketplaceId: string,
  listingId: string
): string => {
  if (ebayEnv === "sandbox") {
    return `https://sandbox.ebay.com/itm/${encodeURIComponent(listingId)}`;
  }

  const normalizedMarketplaceId = toRestMarketplaceId(marketplaceId);
  const host = productionHostByMarketplace[normalizedMarketplaceId] ?? "https://www.ebay.com";

  return `${host}/itm/${encodeURIComponent(listingId)}`;
};
