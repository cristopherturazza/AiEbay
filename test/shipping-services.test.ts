import { describe, expect, it } from "vitest";
import type { ShippingService } from "../src/ebay/metadata.js";
import { filterShippingServices, summarizeShippingService } from "../src/shipping/services.js";

const services: ShippingService[] = [
  {
    description: "Posta 1 standard",
    internationalService: false,
    shippingCarrier: "POST_ITALIANO",
    shippingService: "IT_Posta1",
    maxShippingTime: 5,
    minShippingTime: 2,
    shippingCategory: "ECONOMY",
    validForSellingFlow: true,
    shippingCostTypes: ["FLAT"],
    shipToLocations: [{ shippingLocation: "IT" }]
  },
  {
    description: "Posta internazionale",
    internationalService: true,
    shippingCarrier: "POST_ITALIANO",
    shippingService: "INTL_POSTA",
    shippingCategory: "ECONOMY",
    validForSellingFlow: false,
    shippingCostTypes: ["FLAT"],
    shipToLocations: [{ shippingLocation: "WORLDWIDE" }]
  },
  {
    description: "Corriere espresso",
    internationalService: false,
    shippingCarrier: "DHL",
    shippingService: "IT_DHL",
    shippingCategory: "EXPEDITED",
    validForSellingFlow: true,
    shippingCostTypes: ["FLAT"],
    shipToLocations: [{ shippingLocation: "IT" }]
  }
];

describe("shipping services filters", () => {
  it("keeps only valid domestic Poste services by default-like filters", () => {
    const filtered = filterShippingServices(services, {
      carrier: "post_italiano",
      domestic: true,
      sellingFlowOnly: true
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.shippingService).toBe("IT_Posta1");
  });

  it("supports filtering by exact service and category", () => {
    const filtered = filterShippingServices(services, {
      service: "it_dhl",
      category: "expedited"
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.shippingCarrier).toBe("DHL");
  });

  it("produces a compact human summary", () => {
    expect(summarizeShippingService(services[0]!)).toContain("POST_ITALIANO");
    expect(summarizeShippingService(services[0]!)).toContain("IT_Posta1");
    expect(summarizeShippingService(services[0]!)).toContain("selling=yes");
  });
});
