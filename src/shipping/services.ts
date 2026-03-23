import type { ShippingService } from "../ebay/metadata.js";

export interface ShippingServiceFilters {
  carrier?: string;
  service?: string;
  category?: string;
  domestic?: boolean;
  international?: boolean;
  sellingFlowOnly?: boolean;
  limit?: number;
}

const normalizeToken = (value: string | undefined): string | undefined => {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
};

const matchesExact = (candidate: string | undefined, filterValue: string | undefined): boolean => {
  if (!filterValue) {
    return true;
  }

  return normalizeToken(candidate) === normalizeToken(filterValue);
};

export const filterShippingServices = (
  services: ShippingService[],
  filters: ShippingServiceFilters
): ShippingService[] => {
  const filtered = services.filter((service) => {
    if (filters.sellingFlowOnly && !service.validForSellingFlow) {
      return false;
    }

    if (filters.domestic && service.internationalService) {
      return false;
    }

    if (filters.international && !service.internationalService) {
      return false;
    }

    if (!matchesExact(service.shippingCarrier, filters.carrier)) {
      return false;
    }

    if (!matchesExact(service.shippingService, filters.service)) {
      return false;
    }

    if (!matchesExact(service.shippingCategory, filters.category)) {
      return false;
    }

    return true;
  });

  if (!filters.limit || filters.limit <= 0) {
    return filtered;
  }

  return filtered.slice(0, filters.limit);
};

const formatEta = (service: ShippingService): string | undefined => {
  if (service.minShippingTime === undefined && service.maxShippingTime === undefined) {
    return undefined;
  }

  if (service.minShippingTime !== undefined && service.maxShippingTime !== undefined) {
    return `${service.minShippingTime}-${service.maxShippingTime}d`;
  }

  return `${service.minShippingTime ?? service.maxShippingTime}d`;
};

const formatLocations = (service: ShippingService): string | undefined => {
  const values = service.shipToLocations
    .map((location) => location.shippingLocation ?? location.description)
    .filter((value): value is string => Boolean(value));

  return values.length > 0 ? values.join(",") : undefined;
};

const formatCostTypes = (service: ShippingService): string | undefined => {
  return service.shippingCostTypes.length > 0 ? service.shippingCostTypes.join(",") : undefined;
};

export const summarizeShippingService = (service: ShippingService): string => {
  const parts = [
    service.shippingCarrier ?? "UNKNOWN_CARRIER",
    service.shippingService ?? "UNKNOWN_SERVICE",
    service.description ? `desc=${service.description}` : undefined,
    service.internationalService ? "international" : "domestic",
    service.shippingCategory ? `category=${service.shippingCategory}` : undefined,
    formatCostTypes(service) ? `cost=${formatCostTypes(service)}` : undefined,
    formatEta(service) ? `eta=${formatEta(service)}` : undefined,
    formatLocations(service) ? `to=${formatLocations(service)}` : undefined,
    `selling=${service.validForSellingFlow ? "yes" : "no"}`
  ].filter((value): value is string => Boolean(value));

  return parts.join(" | ");
};
