import { HttpClient } from "./http.js";

interface InventoryClientOptions {
  apiBaseUrl: string;
  httpClient?: HttpClient;
}

export interface OfferListingPolicies {
  fulfillmentPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  [key: string]: unknown;
}

export interface InventoryItemPayload {
  availability: {
    shipToLocationAvailability: {
      quantity: number;
    };
  };
  condition: string;
  product: {
    title: string;
    description: string;
    imageUrls: string[];
    aspects: Record<string, string[]>;
  };
}

export interface CreateOfferPayload {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  merchantLocationKey: string;
  listingDescription: string;
  listingPolicies: OfferListingPolicies;
  listingDuration: string;
  pricingSummary: {
    price: {
      value: string;
      currency: string;
    };
  };
}

interface CreateOfferResponse {
  offerId: string;
}

interface PublishOfferResponse {
  listingId?: string;
}

export interface OfferListingDetails {
  listingId?: string;
  listingOnHold?: boolean;
  listingStatus?: string;
  soldQuantity?: number;
}

export interface OfferResponse {
  offerId: string;
  sku?: string;
  marketplaceId?: string;
  format?: "FIXED_PRICE" | "AUCTION";
  availableQuantity?: number;
  categoryId?: string;
  merchantLocationKey?: string;
  listingDescription?: string;
  listingPolicies?: OfferListingPolicies;
  listingDuration?: string;
  pricingSummary?: {
    price?: {
      value?: string;
      currency?: string;
    };
  };
  includeCatalogProductDetails?: boolean;
  hideBuyerDetails?: boolean;
  quantityLimitPerBuyer?: number;
  listingStartDate?: string;
  lotSize?: number;
  charity?: unknown;
  extendedProducerResponsibility?: unknown;
  tax?: unknown;
  status?: string;
  listing?: OfferListingDetails;
}

export interface UpdateOfferPayload {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE" | "AUCTION";
  availableQuantity: number;
  categoryId: string;
  merchantLocationKey: string;
  listingDescription: string;
  listingPolicies: OfferListingPolicies;
  listingDuration: string;
  pricingSummary: {
    price: {
      value: string;
      currency: string;
    };
  };
  includeCatalogProductDetails?: boolean;
  hideBuyerDetails?: boolean;
  quantityLimitPerBuyer?: number;
  listingStartDate?: string;
  lotSize?: number;
  charity?: unknown;
  extendedProducerResponsibility?: unknown;
  tax?: unknown;
}

export interface GetOffersResponse {
  href?: string;
  next?: string;
  limit?: number;
  offset?: number;
  total?: number;
  size?: number;
  offers?: OfferResponse[];
}

export interface InventoryItemResponse {
  sku?: string;
  availability?: {
    shipToLocationAvailability?: {
      quantity?: number;
    };
  };
  condition?: string;
  product?: {
    title?: string;
    description?: string;
    imageUrls?: string[];
    aspects?: Record<string, string[]>;
  };
}

export interface GetInventoryItemsResponse {
  href?: string;
  next?: string;
  limit?: number;
  offset?: number;
  total?: number;
  size?: number;
  inventoryItems?: InventoryItemResponse[];
}

export class EbayInventoryClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: InventoryClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // createOrReplaceInventoryItem (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/createOrReplaceInventoryItem
  async upsertInventoryItem(
    accessToken: string,
    sku: string,
    payload: InventoryItemPayload,
    locale: string
  ): Promise<void> {
    await this.httpClient.requestVoid({
      method: "PUT",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale,
        "Content-Type": "application/json"
      },
      json: payload
    });
  }

  // createOffer (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/createOffer
  async createOffer(accessToken: string, payload: CreateOfferPayload, locale: string): Promise<string> {
    const response = await this.httpClient.requestJson<CreateOfferResponse>({
      method: "POST",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/offer`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale,
        "Content-Type": "application/json"
      },
      json: payload
    });

    return response.offerId;
  }

  // publishOffer (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/publishOffer
  async publishOffer(accessToken: string, offerId: string, locale: string): Promise<PublishOfferResponse> {
    return this.httpClient.requestJson<PublishOfferResponse>({
      method: "POST",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale,
        "Content-Type": "application/json"
      }
    });
  }

  // getOffer (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffer
  async getOffer(accessToken: string, offerId: string, locale: string): Promise<OfferResponse> {
    return this.httpClient.requestJson<OfferResponse>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale
      }
    });
  }

  // getOffers (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/getOffers
  async getOffers(
    accessToken: string,
    options: {
      sku: string;
      marketplaceId?: string;
      format?: "FIXED_PRICE" | "AUCTION";
      limit?: number;
      offset?: number;
    },
    locale: string
  ): Promise<GetOffersResponse> {
    const url = new URL(`${this.options.apiBaseUrl}/sell/inventory/v1/offer`);
    url.searchParams.set("sku", options.sku);

    if (options.marketplaceId) {
      url.searchParams.set("marketplace_id", options.marketplaceId);
    }

    if (options.format) {
      url.searchParams.set("format", options.format);
    }

    if (options.limit !== undefined) {
      url.searchParams.set("limit", String(options.limit));
    }

    if (options.offset !== undefined) {
      url.searchParams.set("offset", String(options.offset));
    }

    return this.httpClient.requestJson<GetOffersResponse>({
      method: "GET",
      url: url.toString(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale
      }
    });
  }

  // getInventoryItems (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/getInventoryItems
  async getInventoryItems(
    accessToken: string,
    options: {
      limit?: number;
      offset?: number;
    },
    locale: string
  ): Promise<GetInventoryItemsResponse> {
    const url = new URL(`${this.options.apiBaseUrl}/sell/inventory/v1/inventory_item`);

    if (options.limit !== undefined) {
      url.searchParams.set("limit", String(options.limit));
    }

    if (options.offset !== undefined) {
      url.searchParams.set("offset", String(options.offset));
    }

    return this.httpClient.requestJson<GetInventoryItemsResponse>({
      method: "GET",
      url: url.toString(),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale
      }
    });
  }

  // updateOffer (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/offer/methods/updateOffer
  async updateOffer(
    accessToken: string,
    offerId: string,
    payload: UpdateOfferPayload,
    locale: string
  ): Promise<void> {
    await this.httpClient.requestVoid({
      method: "PUT",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Accept-Language": locale,
        "Content-Language": locale,
        "Content-Type": "application/json"
      },
      json: payload
    });
  }
}
