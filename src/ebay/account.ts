import { HttpClient } from "./http.js";

interface AccountClientOptions {
  apiBaseUrl: string;
  httpClient?: HttpClient;
}

export class EbayAccountClient {
  private readonly httpClient: HttpClient;

  constructor(private readonly options: AccountClientOptions) {
    this.httpClient = options.httpClient ?? new HttpClient();
  }

  // getFulfillmentPolicy (docs):
  // https://developer.ebay.com/api-docs/sell/account/resources/fulfillment_policy/methods/getFulfillmentPolicy
  async getFulfillmentPolicy(accessToken: string, policyId: string): Promise<unknown> {
    return this.httpClient.requestJson<unknown>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/account/v1/fulfillment_policy/${encodeURIComponent(policyId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  }

  // getPaymentPolicy (docs):
  // https://developer.ebay.com/api-docs/sell/account/resources/payment_policy/methods/getPaymentPolicy
  async getPaymentPolicy(accessToken: string, policyId: string): Promise<unknown> {
    return this.httpClient.requestJson<unknown>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/account/v1/payment_policy/${encodeURIComponent(policyId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  }

  // getReturnPolicy (docs):
  // https://developer.ebay.com/api-docs/sell/account/resources/return_policy/methods/getReturnPolicy
  async getReturnPolicy(accessToken: string, policyId: string): Promise<unknown> {
    return this.httpClient.requestJson<unknown>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/account/v1/return_policy/${encodeURIComponent(policyId)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  }

  // getInventoryLocation (docs):
  // https://developer.ebay.com/api-docs/sell/inventory/resources/location/methods/getInventoryLocation
  async getInventoryLocation(accessToken: string, merchantLocationKey: string): Promise<unknown> {
    return this.httpClient.requestJson<unknown>({
      method: "GET",
      url: `${this.options.apiBaseUrl}/sell/inventory/v1/location/${encodeURIComponent(merchantLocationKey)}`,
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
  }
}
