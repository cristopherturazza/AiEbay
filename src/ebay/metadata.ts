import { HttpClient } from "./http.js";

interface MetadataClientOptions {
  apiBaseUrl: string;
  httpClient?: HttpClient;
}

interface ItemConditionPolicyResponse {
  itemConditionPolicies?: Array<{
    categoryId: string;
    itemConditionRequired?: boolean;
    itemConditions?: Array<{
      conditionId: string;
      conditionDescription: string;
    }>;
  }>;
}

interface ShippingServicesResponse {
  shippingServices?: Array<{
    description?: string;
    internationalService?: boolean;
    shippingCarrier?: string;
    shippingService?: string;
    maxShippingTime?: number;
    minShippingTime?: number;
    shippingCategory?: string;
    validForSellingFlow?: boolean;
    shippingCostTypes?: string[];
    packageLimits?: {
      maxWeight?: number;
      minWeight?: number;
      weightUnit?: string;
      maxLength?: number;
      maxWidth?: number;
      maxHeight?: number;
      dimensionUnit?: string;
    };
    shipToLocations?: Array<{
      description?: string;
      shippingLocation?: string;
    }>;
  }>;
}

export interface ItemConditionPolicy {
  categoryId: string;
  itemConditionRequired: boolean;
  itemConditions: Array<{
    conditionId: string;
    conditionDescription: string;
  }>;
}

export interface ShippingService {
  description?: string;
  internationalService: boolean;
  shippingCarrier?: string;
  shippingService?: string;
  maxShippingTime?: number;
  minShippingTime?: number;
  shippingCategory?: string;
  validForSellingFlow: boolean;
  shippingCostTypes: string[];
  packageLimits?: {
    maxWeight?: number;
    minWeight?: number;
    weightUnit?: string;
    maxLength?: number;
    maxWidth?: number;
    maxHeight?: number;
    dimensionUnit?: string;
  };
  shipToLocations: Array<{
    description?: string;
    shippingLocation?: string;
  }>;
}

export class EbayMetadataClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: MetadataClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // getItemConditionPolicies (docs):
  // https://developer.ebay.com/api-docs/sell/metadata/resources/marketplace/methods/getItemConditionPolicies
  async getItemConditionPolicies(
    accessToken: string,
    marketplaceId: string,
    categoryIds: string[]
  ): Promise<ItemConditionPolicy[]> {
    const filter = `categoryIds:{${categoryIds.join("|")}}`;
    const params = new URLSearchParams({ filter });
    const response = await this.httpClient.requestJson<ItemConditionPolicyResponse>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/metadata/v1/marketplace/${encodeURIComponent(
        marketplaceId
      )}/get_item_condition_policies?${params.toString()}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    return (response.itemConditionPolicies ?? []).map((policy) => ({
      categoryId: policy.categoryId,
      itemConditionRequired: Boolean(policy.itemConditionRequired),
      itemConditions: policy.itemConditions ?? []
    }));
  }

  // getShippingServices (docs):
  // https://developer.ebay.com/api-docs/sell/metadata/resources/shipping:marketplace/methods/getShippingServices
  async getShippingServices(
    accessToken: string,
    marketplaceId: string,
    options?: {
      acceptLanguage?: string;
    }
  ): Promise<ShippingService[]> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`
    };

    if (options?.acceptLanguage) {
      headers["Accept-Language"] = options.acceptLanguage;
    }

    const response = await this.httpClient.requestJson<ShippingServicesResponse>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/metadata/v1/shipping/marketplace/${encodeURIComponent(
        marketplaceId
      )}/get_shipping_services`,
      headers
    });

    return (response.shippingServices ?? []).map((service) => ({
      description: service.description,
      internationalService: Boolean(service.internationalService),
      shippingCarrier: service.shippingCarrier,
      shippingService: service.shippingService,
      maxShippingTime: service.maxShippingTime,
      minShippingTime: service.minShippingTime,
      shippingCategory: service.shippingCategory,
      validForSellingFlow: Boolean(service.validForSellingFlow),
      shippingCostTypes: service.shippingCostTypes ?? [],
      packageLimits: service.packageLimits,
      shipToLocations: service.shipToLocations ?? []
    }));
  }
}
