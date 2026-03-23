const INVENTORY_PREFIX = "eBay_";
const REST_PREFIX = "EBAY_";

export const toInventoryMarketplaceId = (marketplaceId: string): string => {
  if (marketplaceId.startsWith(REST_PREFIX)) {
    return `${INVENTORY_PREFIX}${marketplaceId.slice(REST_PREFIX.length)}`;
  }

  return marketplaceId;
};

export const toRestMarketplaceId = (marketplaceId: string): string => {
  if (marketplaceId.startsWith(INVENTORY_PREFIX)) {
    return `${REST_PREFIX}${marketplaceId.slice(INVENTORY_PREFIX.length)}`;
  }

  return marketplaceId;
};
