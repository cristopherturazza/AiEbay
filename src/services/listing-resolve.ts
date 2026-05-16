import type { RuntimeConfig } from "../config.js";
import { listListingsSummary, type ListingSummary } from "./listing-snapshot.js";

export interface ResolveListingOptions {
  listing_id?: string;
  ebay_url?: string;
  query?: string;
  limit?: number;
}

export type ResolveListingMatchReason =
  | "listing_id"
  | "ebay_url"
  | "slug_exact"
  | "slug_substring"
  | "title_substring";

export interface ResolveListingMatch {
  reason: ResolveListingMatchReason;
  listing: ListingSummary;
}

export interface ResolveListingResult {
  query: {
    listing_id: string | null;
    ebay_url: string | null;
    query: string | null;
  };
  matches: ResolveListingMatch[];
  total: number;
  ambiguous: boolean;
  not_found: boolean;
}

const LISTING_ID_FROM_URL = /\/itm\/(?:[^/?#]+-)?(\d{6,})/;

export const extractListingIdFromEbayUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const match = url.pathname.match(LISTING_ID_FROM_URL);
  if (match?.[1]) {
    return match[1];
  }

  const itemParam = url.searchParams.get("item");
  if (itemParam && /^\d{6,}$/.test(itemParam.trim())) {
    return itemParam.trim();
  }

  return null;
};

const normalizeListingId = (raw: string | undefined): string | null => {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  return /^\d{6,}$/.test(trimmed) ? trimmed : null;
};

const draftTitleForListing = (summary: ListingSummary, draftTitle: string | undefined): string => {
  return draftTitle ?? summary.slug;
};

export const resolveListings = async (
  config: RuntimeConfig,
  options: ResolveListingOptions
): Promise<ResolveListingResult> => {
  const listingIdFromInput = normalizeListingId(options.listing_id);
  const listingIdFromUrl = options.ebay_url ? extractListingIdFromEbayUrl(options.ebay_url) : null;
  const queryRaw = options.query?.trim() ?? "";
  const limit = options.limit && options.limit > 0 ? options.limit : 20;

  if (!listingIdFromInput && !listingIdFromUrl && !queryRaw) {
    return {
      query: {
        listing_id: options.listing_id?.trim() ?? null,
        ebay_url: options.ebay_url?.trim() ?? null,
        query: null
      },
      matches: [],
      total: 0,
      ambiguous: false,
      not_found: true
    };
  }

  // Always use scope=all: listing_id and URLs are env-agnostic, and queries should
  // surface results from both envs (the caller can filter further if needed).
  const summaries = await listListingsSummary(config, { scope: "all" });

  const matches: ResolveListingMatch[] = [];
  const seen = new Set<string>();

  const pushMatch = (reason: ResolveListingMatchReason, summary: ListingSummary): void => {
    if (seen.has(summary.slug)) {
      return;
    }
    matches.push({ reason, listing: summary });
    seen.add(summary.slug);
  };

  if (listingIdFromUrl) {
    for (const summary of summaries) {
      if (summary.listing_id === listingIdFromUrl) {
        pushMatch("ebay_url", summary);
      }
    }
  }

  if (listingIdFromInput) {
    for (const summary of summaries) {
      if (summary.listing_id === listingIdFromInput) {
        pushMatch("listing_id", summary);
      }
    }
  }

  if (queryRaw) {
    const needle = queryRaw.toLowerCase();
    for (const summary of summaries) {
      if (summary.slug.toLowerCase() === needle) {
        pushMatch("slug_exact", summary);
      }
    }
    for (const summary of summaries) {
      if (summary.slug.toLowerCase().includes(needle)) {
        pushMatch("slug_substring", summary);
      }
    }
  }

  const limited = matches.slice(0, limit);

  return {
    query: {
      listing_id: listingIdFromInput ?? listingIdFromUrl ?? null,
      ebay_url: options.ebay_url?.trim() ?? null,
      query: queryRaw || null
    },
    matches: limited,
    total: matches.length,
    ambiguous: matches.length > 1,
    not_found: matches.length === 0
  };
};
