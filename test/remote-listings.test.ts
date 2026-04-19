import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { HttpClient } from "../src/ebay/http.js";
import { EbayInventoryClient } from "../src/ebay/inventory.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { listRemoteListings } from "../src/services/remote-listings.js";

const makeConfig = (env: "sandbox" | "prod" = "prod"): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls(env);

  return {
    cwd: "/tmp/sellbot",
    ebayEnv: env,
    ebayClientId: "client-id",
    ebayClientSecret: "client-secret",
    ebayRuname: "runame",
    ebayCallbackUrl: undefined,
    ebayScopes: [],
    ebayMarketplaceId: "EBAY_IT",
    sellbotPort: 3000,
    ebayAuthBaseUrl: defaults.authBaseUrl,
    ebayApiBaseUrl: defaults.apiBaseUrl,
    ebayMediaBaseUrl: defaults.mediaBaseUrl,
    locale: "it-IT",
    merchantLocationKey: undefined,
    notificationEndpointUrl: undefined,
    notificationVerificationToken: undefined,
    shippingProfiles: undefined,
    policies: {},
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "gemma4:e4b",
      visionKeepAlive: "60s",
      visionTimeoutMs: 120_000
    }
  };
};

describe("remote listings", () => {
  it("returns only active published remote listings by default", async () => {
    const config = makeConfig("prod");
    const httpClient = new HttpClient(async (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        return new Response(
          JSON.stringify({
            total: 2,
            limit: 100,
            offset: 0,
            inventoryItems: [
              {
                sku: "SKU-1",
                availability: {
                  shipToLocationAvailability: {
                    quantity: 3
                  }
                },
                product: {
                  title: "Libro Uno"
                }
              },
              {
                sku: "SKU-2",
                availability: {
                  shipToLocationAvailability: {
                    quantity: 1
                  }
                },
                product: {
                  title: "Libro Due"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/sell/inventory/v1/offer" && url.searchParams.get("sku") === "SKU-1") {
        return new Response(
          JSON.stringify({
            total: 1,
            limit: 25,
            offset: 0,
            offers: [
              {
                offerId: "offer-1",
                sku: "SKU-1",
                marketplaceId: "EBAY_IT",
                format: "FIXED_PRICE",
                categoryId: "123",
                merchantLocationKey: "LOC-1",
                availableQuantity: 3,
                status: "PUBLISHED",
                pricingSummary: {
                  price: {
                    value: "19.90",
                    currency: "EUR"
                  }
                },
                listing: {
                  listingId: "listing-1",
                  listingStatus: "ACTIVE",
                  soldQuantity: 1
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/sell/inventory/v1/offer" && url.searchParams.get("sku") === "SKU-2") {
        return new Response(
          JSON.stringify({
            total: 1,
            limit: 25,
            offset: 0,
            offers: [
              {
                offerId: "offer-2",
                sku: "SKU-2",
                marketplaceId: "EBAY_IT",
                format: "FIXED_PRICE",
                availableQuantity: 1,
                status: "PUBLISHED",
                listing: {
                  listingId: "listing-2",
                  listingStatus: "ENDED",
                  soldQuantity: 0
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const inventoryClient = new EbayInventoryClient({
      apiBaseUrl: config.ebayApiBaseUrl,
      httpClient
    });

    const result = await listRemoteListings(
      config,
      {},
      {
        accessToken: "token",
        inventoryClient
      }
    );

    expect(result.total).toBe(1);
    expect(result.filters.active_only).toBe(true);
    expect(result.scan.inventory_items_scanned).toBe(2);
    expect(result.scan.offers_considered).toBe(2);
    expect(result.scan.truncated).toBe(false);
    expect(result.listings).toEqual([
      {
        offer_id: "offer-1",
        sku: "SKU-1",
        title: "Libro Uno",
        marketplace_id: "EBAY_IT",
        format: "FIXED_PRICE",
        status: "PUBLISHED",
        listing_id: "listing-1",
        listing_status: "ACTIVE",
        listing_on_hold: false,
        sold_quantity: 1,
        available_quantity: 3,
        category_id: "123",
        merchant_location_key: "LOC-1",
        price: {
          value: "19.90",
          currency: "EUR"
        },
        url: "https://www.ebay.it/itm/listing-1"
      }
    ]);
  });

  it("supports limit truncation when more remote offers are available", async () => {
    const config = makeConfig("prod");
    const httpClient = new HttpClient(async (input) => {
      const url = new URL(String(input));

      if (url.pathname === "/sell/inventory/v1/inventory_item") {
        return new Response(
          JSON.stringify({
            total: 1,
            limit: 100,
            offset: 0,
            inventoryItems: [
              {
                sku: "SKU-1",
                product: {
                  title: "Libro Uno"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.pathname === "/sell/inventory/v1/offer" && url.searchParams.get("sku") === "SKU-1") {
        return new Response(
          JSON.stringify({
            total: 2,
            limit: 25,
            offset: 0,
            offers: [
              {
                offerId: "offer-1",
                sku: "SKU-1",
                marketplaceId: "EBAY_IT",
                status: "PUBLISHED",
                listing: {
                  listingId: "listing-1",
                  listingStatus: "ACTIVE"
                }
              },
              {
                offerId: "offer-2",
                sku: "SKU-1",
                marketplaceId: "EBAY_IT",
                status: "PUBLISHED",
                listing: {
                  listingId: "listing-2",
                  listingStatus: "ACTIVE"
                }
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`Unexpected request: ${url.toString()}`);
    });

    const inventoryClient = new EbayInventoryClient({
      apiBaseUrl: config.ebayApiBaseUrl,
      httpClient
    });

    const result = await listRemoteListings(
      config,
      {
        limit: 1
      },
      {
        accessToken: "token",
        inventoryClient
      }
    );

    expect(result.total).toBe(1);
    expect(result.scan.truncated).toBe(true);
    expect(result.listings[0]?.offer_id).toBe("offer-1");
  });
});
