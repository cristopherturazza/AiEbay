import type { RuntimeConfig } from "../config.js";
import type {
  EbayInventoryClient,
  GetOffersResponse,
  InventoryItemResponse,
  OfferResponse
} from "../ebay/inventory.js";
import { createSellApiRuntime } from "./sell-workflow.js";
import { deriveListingUrl } from "../utils/listing-url.js";

const INVENTORY_PAGE_SIZE = 100;
const OFFERS_PAGE_SIZE = 25;
const OFFER_FETCH_CONCURRENCY = 5;
const DEFAULT_REMOTE_LISTINGS_LIMIT = 100;
const MAX_REMOTE_LISTINGS_LIMIT = 500;

export interface RemoteListingSummary {
  offer_id: string;
  sku: string | null;
  title: string | null;
  marketplace_id: string | null;
  format: string | null;
  status: string | null;
  listing_id: string | null;
  listing_status: string | null;
  listing_on_hold: boolean;
  sold_quantity: number | null;
  available_quantity: number | null;
  category_id: string | null;
  merchant_location_key: string | null;
  price: {
    value: string | null;
    currency: string | null;
  };
  url: string | null;
}

export interface ListRemoteListingsOptions {
  activeOnly?: boolean;
  limit?: number;
}

export interface ListRemoteListingsResult {
  current_env: RuntimeConfig["ebayEnv"];
  marketplace_id: string;
  total: number;
  filters: {
    active_only: boolean;
    limit: number;
  };
  scan: {
    inventory_items_scanned: number;
    inventory_items_total: number | null;
    inventory_pages: number;
    offers_considered: number;
    truncated: boolean;
  };
  listings: RemoteListingSummary[];
}

interface RemoteListingsRuntime {
  accessToken: string;
  inventoryClient: EbayInventoryClient;
}

interface OfferWithInventoryItem {
  inventoryItem: InventoryItemResponse;
  offer: OfferResponse;
}

const clampLimit = (value: number | undefined): number => {
  if (value === undefined) {
    return DEFAULT_REMOTE_LISTINGS_LIMIT;
  }

  return Math.max(1, Math.min(MAX_REMOTE_LISTINGS_LIMIT, Math.trunc(value)));
};

const listOffersForSku = async (
  inventoryClient: EbayInventoryClient,
  accessToken: string,
  config: RuntimeConfig,
  sku: string
): Promise<OfferResponse[]> => {
  const offers: OfferResponse[] = [];
  let offset = 0;

  while (true) {
    const page = await inventoryClient.getOffers(
      accessToken,
      {
        sku,
        marketplaceId: config.ebayMarketplaceId,
        limit: OFFERS_PAGE_SIZE,
        offset
      },
      config.locale
    );

    const currentOffers = page.offers ?? [];
    offers.push(...currentOffers);

    if (currentOffers.length === 0) {
      break;
    }

    if (!page.next && (page.total === undefined || offset + currentOffers.length >= page.total)) {
      break;
    }

    offset += currentOffers.length;
  }

  return offers;
};

const mapWithConcurrency = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await mapper(values[currentIndex]);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, values.length) }, () => worker());
  await Promise.all(workers);
  return results;
};

const normalizeRemoteListing = (
  config: RuntimeConfig,
  inventoryItem: InventoryItemResponse,
  offer: OfferResponse
): RemoteListingSummary => {
  const marketplaceId = offer.marketplaceId ?? config.ebayMarketplaceId;
  const listingId = offer.listing?.listingId ?? null;

  return {
    offer_id: offer.offerId,
    sku: offer.sku ?? inventoryItem.sku ?? null,
    title: inventoryItem.product?.title ?? null,
    marketplace_id: marketplaceId ?? null,
    format: offer.format ?? null,
    status: offer.status ?? null,
    listing_id: listingId,
    listing_status: offer.listing?.listingStatus ?? null,
    listing_on_hold: offer.listing?.listingOnHold ?? false,
    sold_quantity: offer.listing?.soldQuantity ?? null,
    available_quantity:
      offer.availableQuantity ??
      inventoryItem.availability?.shipToLocationAvailability?.quantity ??
      null,
    category_id: offer.categoryId ?? null,
    merchant_location_key: offer.merchantLocationKey ?? null,
    price: {
      value: offer.pricingSummary?.price?.value ?? null,
      currency: offer.pricingSummary?.price?.currency ?? null
    },
    url: listingId ? deriveListingUrl(config.ebayEnv, marketplaceId, listingId) : null
  };
};

const isActiveRemoteOffer = (offer: OfferResponse): boolean => {
  return offer.status === "PUBLISHED" && offer.listing?.listingStatus === "ACTIVE";
};

export const listRemoteListings = async (
  config: RuntimeConfig,
  options: ListRemoteListingsOptions = {},
  runtime?: RemoteListingsRuntime
): Promise<ListRemoteListingsResult> => {
  const activeOnly = options.activeOnly ?? true;
  const limit = clampLimit(options.limit);
  const api = runtime ?? (await createSellApiRuntime(config));
  const listings: RemoteListingSummary[] = [];

  let inventoryOffset = 0;
  let inventoryItemsScanned = 0;
  let inventoryItemsTotal: number | null = null;
  let inventoryPages = 0;
  let offersConsidered = 0;
  let exhaustedInventory = false;
  let truncated = false;

  while (listings.length < limit && !exhaustedInventory) {
    const page = await api.inventoryClient.getInventoryItems(
      api.accessToken,
      {
        limit: INVENTORY_PAGE_SIZE,
        offset: inventoryOffset
      },
      config.locale
    );

    inventoryPages += 1;
    inventoryItemsTotal = page.total ?? inventoryItemsTotal;
    const rawInventoryItems = page.inventoryItems ?? [];

    const inventoryItems = rawInventoryItems.filter((item): item is InventoryItemResponse & { sku: string } => Boolean(item.sku));

    if (rawInventoryItems.length === 0) {
      break;
    }

    inventoryItemsScanned += rawInventoryItems.length;
    const pageHasMoreInventory =
      Boolean(page.next) || (page.total !== undefined && inventoryOffset + rawInventoryItems.length < page.total);

    const offersByInventoryItem = await mapWithConcurrency(
      inventoryItems,
      OFFER_FETCH_CONCURRENCY,
      async (inventoryItem): Promise<OfferWithInventoryItem[]> => {
        const offers = await listOffersForSku(api.inventoryClient, api.accessToken, config, inventoryItem.sku);
        return offers.map((offer) => ({ inventoryItem, offer }));
      }
    );

    for (let groupIndex = 0; groupIndex < offersByInventoryItem.length; groupIndex += 1) {
      const entries = offersByInventoryItem[groupIndex];

      for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
        const entry = entries[entryIndex];
        offersConsidered += 1;

        if (activeOnly && !isActiveRemoteOffer(entry.offer)) {
          continue;
        }

        listings.push(normalizeRemoteListing(config, entry.inventoryItem, entry.offer));

        if (listings.length >= limit) {
          truncated =
            entryIndex < entries.length - 1 || groupIndex < offersByInventoryItem.length - 1 || pageHasMoreInventory;
          break;
        }
      }

      if (listings.length >= limit) {
        break;
      }
    }

    if (!page.next && (page.total === undefined || inventoryOffset + rawInventoryItems.length >= page.total)) {
      exhaustedInventory = true;
      break;
    }

    inventoryOffset += rawInventoryItems.length;
  }

  return {
    current_env: config.ebayEnv,
    marketplace_id: config.ebayMarketplaceId,
    total: listings.length,
    filters: {
      active_only: activeOnly,
      limit
    },
    scan: {
      inventory_items_scanned: inventoryItemsScanned,
      inventory_items_total: inventoryItemsTotal,
      inventory_pages: inventoryPages,
      offers_considered: offersConsidered,
      truncated
    },
    listings
  };
};
