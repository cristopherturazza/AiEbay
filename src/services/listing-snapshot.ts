import {
  getToSellRoot,
  listListingFolders,
  listPhotoFiles,
  readDraft,
  readEbayBuild,
  readEnrichmentReport,
  readIntakeReport,
  readNotes,
  readStatusOrEmpty,
  resolveListing
} from "../fs/listings.js";
import type { RuntimeConfig } from "../config.js";

export type ListingPublishedEnv = RuntimeConfig["ebayEnv"] | null;

export interface ListingSummary {
  slug: string;
  dir: string;
  state: string;
  published_at: string | null;
  photo_count: number;
  has_draft: boolean;
  has_enrichment: boolean;
  has_intake: boolean;
  has_ebay_build: boolean;
  offer_id: string | null;
  listing_id: string | null;
  url: string | null;
  published_env: ListingPublishedEnv;
  matches_current_env: boolean;
}

export interface ListingSnapshot {
  summary: ListingSummary;
  photos: string[];
  notes: string;
  draft: Awaited<ReturnType<typeof readDraft>>;
  enrichment: Awaited<ReturnType<typeof readEnrichmentReport>>;
  intake: Awaited<ReturnType<typeof readIntakeReport>>;
  ebay_build: Awaited<ReturnType<typeof readEbayBuild>>;
  status: Awaited<ReturnType<typeof readStatusOrEmpty>>;
}

export interface ListListingsSummaryOptions {
  scope?: "all" | "current_env";
  state?: string;
  publishedOnly?: boolean;
}

const derivePublishedEnv = (url: string | null): ListingPublishedEnv => {
  if (!url) {
    return null;
  }

  if (/^https:\/\/sandbox\.ebay\.com\//i.test(url)) {
    return "sandbox";
  }

  if (/^https:\/\/(?:www\.)?ebay\./i.test(url)) {
    return "prod";
  }

  return null;
};

export const summarizeListing = async (config: RuntimeConfig, slugOrPath: string): Promise<ListingSummary> => {
  const listing = await resolveListing(getToSellRoot(config.cwd), slugOrPath);
  const [status, photoFiles, draft, enrichment, intake, ebayBuild] = await Promise.all([
    readStatusOrEmpty(listing.statusPath),
    listPhotoFiles(listing.photosDir),
    readDraft(listing.draftPath),
    readEnrichmentReport(listing.enrichmentPath),
    readIntakeReport(listing.intakePath),
    readEbayBuild(listing.ebayPath)
  ]);

  const published_env = derivePublishedEnv(status.ebay.url);

  return {
    slug: listing.slug,
    dir: listing.dir,
    state: status.state,
    published_at: status.published_at,
    photo_count: photoFiles.length,
    has_draft: Boolean(draft),
    has_enrichment: Boolean(enrichment),
    has_intake: Boolean(intake),
    has_ebay_build: Boolean(ebayBuild),
    offer_id: status.ebay.offer_id,
    listing_id: status.ebay.listing_id,
    url: status.ebay.url,
    published_env,
    matches_current_env: published_env === null || published_env === config.ebayEnv
  };
};

export const listListingsSummary = async (
  config: RuntimeConfig,
  options: ListListingsSummaryOptions = {}
): Promise<ListingSummary[]> => {
  const listings = await listListingFolders(getToSellRoot(config.cwd));
  const summaries = await Promise.all(listings.map((listing) => summarizeListing(config, listing.dir)));

  return summaries.filter((summary) => {
    if ((options.scope ?? "current_env") === "current_env" && !summary.matches_current_env) {
      return false;
    }

    if (options.publishedOnly && summary.state !== "published") {
      return false;
    }

    if (options.state && summary.state !== options.state) {
      return false;
    }

    return true;
  });
};

export const getListingSnapshot = async (
  config: RuntimeConfig,
  slugOrPath: string
): Promise<ListingSnapshot> => {
  const listing = await resolveListing(getToSellRoot(config.cwd), slugOrPath);
  const [summary, photos, notes, draft, enrichment, intake, ebayBuild, status] = await Promise.all([
    summarizeListing(config, slugOrPath),
    listPhotoFiles(listing.photosDir),
    readNotes(listing.notesPath),
    readDraft(listing.draftPath),
    readEnrichmentReport(listing.enrichmentPath),
    readIntakeReport(listing.intakePath),
    readEbayBuild(listing.ebayPath),
    readStatusOrEmpty(listing.statusPath)
  ]);

  return {
    summary,
    photos,
    notes,
    draft,
    enrichment,
    intake,
    ebay_build: ebayBuild,
    status
  };
};
