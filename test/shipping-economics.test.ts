import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { describeShippingEconomics } from "../src/shipping/economics.js";

const makeConfig = (overrides?: Partial<RuntimeConfig>): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("sandbox");

  return {
    cwd: "/tmp/sellbot",
    ebayEnv: "sandbox",
    ebayClientId: undefined,
    ebayClientSecret: undefined,
    ebayRuname: undefined,
    ebayCallbackUrl: undefined,
    ebayScopes: [],
    ebayMarketplaceId: "EBAY_IT",
    sellbotPort: 3000,
    ebayAuthBaseUrl: defaults.authBaseUrl,
    ebayApiBaseUrl: defaults.apiBaseUrl,
    ebayMediaBaseUrl: defaults.mediaBaseUrl,
    locale: "it-IT",
    merchantLocationKey: "LOC-1",
    policies: {
      fulfillmentPolicyId: "FULFILLMENT-DEFAULT",
      fulfillmentPolicyIdByProfile: {
        book: "FULFILLMENT-BOOK"
      },
      paymentPolicyId: "PAYMENT-1",
      returnPolicyId: "RETURN-1"
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "gemma4:e4b",
      visionKeepAlive: "60s",
      visionTimeoutMs: 120_000
    },
    ...overrides
  };
};

describe("shipping economics", () => {
  it("computes buyer total and net proceeds when shipping is charged separately", () => {
    const config = makeConfig({
      shippingProfiles: {
        book: {
          carrierCode: "POST_ITALIANO",
          serviceCode: "IT_Posta1",
          pricingMode: "separate_charge",
          buyerCharge: {
            value: 4.9,
            currency: "EUR"
          },
          estimatedCarrierCost: {
            value: 4.9,
            currency: "EUR"
          }
        }
      }
    });

    const summary = describeShippingEconomics(config, "book", {
      value: 12,
      currency: "EUR"
    });

    expect(summary).not.toBeNull();
    expect(summary?.buyerTotal).toEqual({ value: 16.9, currency: "EUR" });
    expect(summary?.netProceedsBeforeFees).toEqual({ value: 12, currency: "EUR" });
    expect(summary?.shippingDelta).toEqual({ value: 0, currency: "EUR" });
    expect(summary?.warnings).toEqual([]);
  });

  it("shows shipping absorption in the listing price when configured", () => {
    const config = makeConfig({
      shippingProfiles: {
        default: {
          pricingMode: "included_in_item_price",
          estimatedCarrierCost: {
            value: 1.45,
            currency: "EUR"
          }
        }
      }
    });

    const summary = describeShippingEconomics(config, undefined, {
      value: 10,
      currency: "EUR"
    });

    expect(summary).not.toBeNull();
    expect(summary?.buyerTotal).toEqual({ value: 10, currency: "EUR" });
    expect(summary?.netProceedsBeforeFees).toEqual({ value: 8.55, currency: "EUR" });
    expect(summary?.shippingDelta).toEqual({ value: -1.45, currency: "EUR" });
    expect(summary?.warnings).toEqual([]);
  });

  it("warns when shipping amounts are not configured", () => {
    const config = makeConfig({
      shippingProfiles: {
        book: {
          carrierCode: "POST_ITALIANO",
          serviceCode: "IT_Posta1",
          pricingMode: "separate_charge"
        }
      }
    });

    const summary = describeShippingEconomics(config, "book", {
      value: 12,
      currency: "EUR"
    });

    expect(summary).not.toBeNull();
    expect(summary?.warnings).toContain("buyerCharge non configurato");
    expect(summary?.warnings).toContain("estimatedCarrierCost non configurato");
  });
});
