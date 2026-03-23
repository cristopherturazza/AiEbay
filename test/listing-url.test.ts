import { describe, expect, it } from "vitest";
import { deriveListingUrl } from "../src/utils/listing-url.js";

describe("deriveListingUrl", () => {
  it("builds sandbox item URLs", () => {
    expect(deriveListingUrl("sandbox", "EBAY_IT", "123")).toBe("https://sandbox.ebay.com/itm/123");
  });

  it("builds production item URLs for known marketplaces", () => {
    expect(deriveListingUrl("prod", "EBAY_IT", "123")).toBe("https://www.ebay.it/itm/123");
    expect(deriveListingUrl("prod", "eBay_GB", "123")).toBe("https://www.ebay.co.uk/itm/123");
  });

  it("falls back to ebay.com for unknown production marketplaces", () => {
    expect(deriveListingUrl("prod", "EBAY_MOTORS", "123")).toBe("https://www.ebay.com/itm/123");
  });
});
