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
  listing?: {
    listingId?: string;
  };
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
