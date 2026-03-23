import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { resolveListing } from "../src/fs/listings.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { syncListingBuildFromDraft } from "../src/services/build-listing.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

const makeConfig = (cwd: string): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("sandbox");

  return {
    cwd,
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
    merchantLocationKey: undefined,
    policies: {}
  };
};

describe("build listing sync", () => {
  it("normalizes legacy marketplace ids stored in ebay.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-build-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "legacy-marketplace");
    const photosDir = path.join(listingDir, "photos");

    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "main.png"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Legacy marketplace test",
          description: "Test listing",
          shipping_profile: "book",
          condition: "New",
          price: {
            target: 10,
            currency: "EUR"
          },
          category_hint: "test",
          category_id: "12345",
          item_specifics: {}
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(listingDir, "ebay.json"),
      JSON.stringify(
        {
          version: 1,
          generated_at: "2026-01-01T00:00:00.000Z",
          slug: "legacy-marketplace",
          sku: "sb-legacy-marketplace",
          marketplace_id: "eBay_IT",
          locale: "it-IT",
          quantity: 1,
          format: "FIXED_PRICE",
          listing_duration: "GTC",
          category_id: "12345",
          condition: "NEW",
          pricing_summary: {
            price: {
              value: "10.00",
              currency: "EUR"
            }
          },
          listing_description: "Old description",
          product: {
            title: "Old title",
            description: "Old description",
            aspects: {},
            image_files: ["photos/main.png"]
          }
        },
        null,
        2
      )
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "legacy-marketplace");
    const result = await syncListingBuildFromDraft(listing, makeConfig(root));

    expect(result.ebayBuild.marketplace_id).toBe("EBAY_IT");
    expect(result.ebayBuild.shipping_profile).toBe("book");
    expect(result.ebayBuild.listing_description).toBe("<div><p>Test listing</p></div>");
    expect(result.ebayBuild.product.description).toBe("Test listing");
  });

  it("infers book_heavy when draft shipping data exceeds the standard profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-build-test-"));
    temporaryRoots.push(root);

    const listingDir = path.join(root, "ToSell", "heavy-book");
    const photosDir = path.join(listingDir, "photos");

    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "main.png"), "x");
    await writeFile(
      path.join(listingDir, "draft.json"),
      JSON.stringify(
        {
          title: "Volume corposo",
          description: "Libro spesso",
          shipping: {
            thickness_cm: 3.2,
            pages: 620,
            binding: "paperback"
          },
          condition: "Used",
          price: {
            target: 15,
            currency: "EUR"
          },
          category_hint: "libri saggistica",
          category_id: "12345",
          item_specifics: {
            Author: "Autore Test",
            Pages: "620"
          }
        },
        null,
        2
      )
    );

    const listing = await resolveListing(path.join(root, "ToSell"), "heavy-book");
    const result = await syncListingBuildFromDraft(listing, makeConfig(root));

    expect(result.ebayBuild.shipping_profile).toBe("book_heavy");
  });
});
