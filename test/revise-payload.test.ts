import { describe, expect, it } from "vitest";
import { buildUpdateOfferPayload } from "../src/commands/revise.js";
import type { OfferResponse } from "../src/ebay/inventory.js";
import type { EbayBuild } from "../src/types.js";

const makeOffer = (overrides: Partial<OfferResponse> = {}): OfferResponse =>
  ({
    offerId: "offer-1",
    sku: "sb-libro",
    marketplaceId: "EBAY_IT",
    format: "FIXED_PRICE",
    availableQuantity: 1,
    categoryId: "268",
    merchantLocationKey: "CEREA-01",
    status: "PUBLISHED",
    ...overrides
  }) as OfferResponse;

const makeBuild = (categoryId: string): EbayBuild => ({
  version: 1,
  generated_at: "2026-08-13T10:00:00.000Z",
  slug: "libro",
  sku: "sb-libro",
  marketplace_id: "EBAY_IT",
  locale: "it-IT",
  quantity: 1,
  format: "FIXED_PRICE",
  listing_duration: "GTC",
  category_id: categoryId,
  condition: "USED_GOOD",
  pricing_summary: { price: { value: "8.00", currency: "EUR" } },
  listing_description: "<div><p>Descrizione</p></div>",
  product: {
    title: "Libro",
    description: "Descrizione",
    aspects: {},
    image_files: ["photos/remote-01.jpg"]
  }
});

const publishConfig = {
  merchantLocationKey: "CEREA-01",
  policies: {
    fulfillmentPolicyId: "f-1",
    paymentPolicyId: "p-1",
    returnPolicyId: "r-1"
  }
} as unknown as Parameters<typeof buildUpdateOfferPayload>[2];

describe("buildUpdateOfferPayload", () => {
  it("uses the draft category so a wrong one can be corrected via revise", () => {
    const payload = buildUpdateOfferPayload(makeOffer({ categoryId: "268" }), makeBuild("171243"), publishConfig);

    expect(payload.categoryId).toBe("171243");
  });

  it("still sends the category when the remote offer has none", () => {
    const payload = buildUpdateOfferPayload(
      makeOffer({ categoryId: undefined }),
      makeBuild("171228"),
      publishConfig
    );

    expect(payload.categoryId).toBe("171228");
  });
});
