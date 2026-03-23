import { describe, expect, it } from "vitest";
import { toInventoryMarketplaceId, toRestMarketplaceId } from "../src/utils/marketplace.js";

describe("marketplace helpers", () => {
  it("maps inventory marketplace IDs to REST format", () => {
    expect(toRestMarketplaceId("eBay_IT")).toBe("EBAY_IT");
    expect(toRestMarketplaceId("EBAY_IT")).toBe("EBAY_IT");
  });

  it("maps REST marketplace IDs to inventory format", () => {
    expect(toInventoryMarketplaceId("EBAY_IT")).toBe("eBay_IT");
    expect(toInventoryMarketplaceId("eBay_IT")).toBe("eBay_IT");
  });
});
