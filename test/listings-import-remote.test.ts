import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { HttpClient } from "../src/ebay/http.js";
import { EbayInventoryClient } from "../src/ebay/inventory.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import {
  deriveSlugFromRemote,
  importRemoteListings,
  looksLikeSameListing,
  upgradeEbayImageUrl
} from "../src/services/listings-import-remote.js";

const makeConfig = (cwd: string): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("prod");

  return {
    cwd,
    ebayEnv: "prod",
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

const INVENTORY_ITEMS = [
  {
    sku: "sb-winston-graham-ross-poldark",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: "USED_VERY_GOOD",
    product: {
      title: "Ross Poldark",
      description: "<p>Romanzo storico in ottime condizioni.</p>",
      imageUrls: ["https://i.ebayimg.com/images/g/aaa/s-l1600.jpg", "https://i.ebayimg.com/images/g/bbb/s-l1600.jpg"],
      aspects: { Author: ["Winston Graham"], Language: ["Italiano"], Empty: [] }
    }
  },
  {
    sku: "sb-anthony-robbins-soldi-domina-il-gioco-live",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: "LIKE_NEW",
    product: {
      title: "Soldi. Domina il gioco",
      description: "Libro usato",
      imageUrls: ["https://i.ebayimg.com/00/s/MTI4MFg5NjA=/z/robbins/$_1.JPG?set_id=8800005007"]
    }
  },
  {
    sku: "sb-bianca-marconero-lady-pride-and-mister-prejudic",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    condition: "USED_GOOD",
    product: { title: "Lady Pride and Mister Prejudice", description: "Romanzo", imageUrls: [] }
  }
];

const OFFERS: Record<string, unknown> = {
  "sb-winston-graham-ross-poldark": {
    offerId: "173756261011",
    sku: "sb-winston-graham-ross-poldark",
    marketplaceId: "EBAY_IT",
    format: "FIXED_PRICE",
    categoryId: "171228",
    availableQuantity: 1,
    status: "PUBLISHED",
    pricingSummary: { price: { value: "7.0", currency: "EUR" } },
    listing: { listingId: "236834635605", listingStatus: "ACTIVE", soldQuantity: 0 }
  },
  "sb-anthony-robbins-soldi-domina-il-gioco-live": {
    offerId: "133267615011",
    sku: "sb-anthony-robbins-soldi-domina-il-gioco-live",
    marketplaceId: "EBAY_IT",
    format: "FIXED_PRICE",
    categoryId: "171243",
    availableQuantity: 1,
    status: "UNPUBLISHED",
    pricingSummary: { price: { value: "9.9", currency: "EUR" } },
    listing: { listingId: "236692443289", listingStatus: "ENDED", soldQuantity: 0 }
  },
  "sb-bianca-marconero-lady-pride-and-mister-prejudic": {
    offerId: "173756031011",
    sku: "sb-bianca-marconero-lady-pride-and-mister-prejudic",
    marketplaceId: "EBAY_IT",
    format: "FIXED_PRICE",
    categoryId: "171228",
    availableQuantity: 1,
    status: "PUBLISHED",
    pricingSummary: { price: { value: "10.0", currency: "EUR" } },
    listing: { listingId: "236834634574", listingStatus: "ACTIVE", soldQuantity: 0 }
  }
};

const makeRuntime = () => {
  const httpClient = new HttpClient(async (input) => {
    const url = new URL(String(input));

    if (url.pathname === "/sell/inventory/v1/inventory_item") {
      return new Response(
        JSON.stringify({ total: INVENTORY_ITEMS.length, limit: 100, offset: 0, inventoryItems: INVENTORY_ITEMS }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/sell/inventory/v1/offer") {
      const sku = url.searchParams.get("sku") ?? "";
      const offer = OFFERS[sku];
      return new Response(JSON.stringify({ total: offer ? 1 : 0, limit: 25, offset: 0, offers: offer ? [offer] : [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    throw new Error(`Unexpected request: ${url.toString()}`);
  });

  return {
    accessToken: "token",
    inventoryClient: new EbayInventoryClient({ apiBaseUrl: defaultEbayBaseUrls("prod").apiBaseUrl, httpClient })
  };
};

const seedListing = async (
  root: string,
  slug: string,
  status: Record<string, unknown>
): Promise<void> => {
  const dir = path.join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "status.json"), JSON.stringify(status, null, 2), "utf8");
};

const emptyEbayStatus = {
  state: "ready",
  published_at: null,
  ebay: { sku: null, offer_id: null, listing_id: null, url: null },
  last_error: null
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deriveSlugFromRemote", () => {
  it("strips the sb- prefix generated by makeSku", () => {
    expect(deriveSlugFromRemote("sb-winston-graham-ross-poldark", "Ross Poldark")).toBe(
      "winston-graham-ross-poldark"
    );
  });

  it("falls back to the title when the sku has no sellbot prefix", () => {
    expect(deriveSlugFromRemote("LEGACY_SKU_9", null)).toBe("legacy-sku-9");
    expect(deriveSlugFromRemote(null, "Zia Mame")).toBe("zia-mame");
  });
});

describe("looksLikeSameListing", () => {
  it("matches slugs differing only by sku truncation and word order", () => {
    expect(
      looksLikeSameListing(
        "bianca-marconero-lady-pride-and-mister-prejudic",
        "lady-pride-and-mister-prejudice-bianca-marconero"
      )
    ).toBe(true);
  });

  it("does not match unrelated books", () => {
    expect(looksLikeSameListing("winston-graham-ross-poldark", "eckhart-tolle-il-potere-di-adesso")).toBe(false);
  });
});

describe("upgradeEbayImageUrl", () => {
  it("promotes EPS thumbnails to the full size variant", () => {
    expect(
      upgradeEbayImageUrl("https://i.ebayimg.com/00/s/MTI4MFg5NjA=/z/eTwAAeSw5p9qHapC/$_1.JPG?set_id=8800005007")
    ).toBe("https://i.ebayimg.com/00/s/MTI4MFg5NjA=/z/eTwAAeSw5p9qHapC/$_57.JPG?set_id=8800005007");
  });

  it("promotes the modern s-l form and leaves foreign hosts untouched", () => {
    expect(upgradeEbayImageUrl("https://i.ebayimg.com/images/g/abc/s-l225.jpg")).toBe(
      "https://i.ebayimg.com/images/g/abc/s-l1600.jpg"
    );
    expect(upgradeEbayImageUrl("https://example.com/photo/$_1.JPG")).toBe("https://example.com/photo/$_1.JPG");
  });
});

describe("importRemoteListings", () => {
  it("rebuilds missing folders, refreshes linked ones and flags duplicates", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sellbot-import-"));
    const root = path.join(cwd, "ToSell");

    await seedListing(root, "anthony-robbins-soldi-domina-il-gioco-live", {
      state: "published",
      published_at: "2026-03-16T17:59:29.779Z",
      ebay: {
        sku: "sb-anthony-robbins-soldi-domina-il-gioco-live",
        offer_id: "133267615011",
        listing_id: "236692443289",
        url: "https://www.ebay.it/itm/236692443289"
      },
      last_error: null
    });
    await seedListing(root, "lady-pride-and-mister-prejudice-bianca-marconero", emptyEbayStatus);

    vi.stubGlobal("fetch", async () =>
      new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } })
    );

    const result = await importRemoteListings(makeConfig(cwd), {}, makeRuntime());

    expect(result.remote_total).toBe(3);
    expect(result.imported.map((entry) => entry.slug).sort()).toEqual([
      "bianca-marconero-lady-pride-and-mister-prejudic",
      "winston-graham-ross-poldark"
    ]);

    const poldark = result.imported.find((entry) => entry.slug === "winston-graham-ross-poldark");
    expect(poldark?.photos_downloaded).toBe(2);
    expect(poldark?.photos_failed).toBe(0);

    const draft = JSON.parse(await readFile(path.join(root, "winston-graham-ross-poldark", "draft.json"), "utf8"));
    expect(draft.title).toBe("Ross Poldark");
    expect(draft.description).toBe("<p>Romanzo storico in ottime condizioni.</p>");
    expect(draft.condition).toBe("USED_VERY_GOOD");
    expect(draft.price).toEqual({ target: 7, currency: "EUR" });
    expect(draft.category_id).toBe("171228");
    expect(draft.item_specifics).toEqual({ Author: "Winston Graham", Language: "Italiano" });

    const status = JSON.parse(await readFile(path.join(root, "winston-graham-ross-poldark", "status.json"), "utf8"));
    expect(status.state).toBe("published");
    expect(status.ebay.listing_id).toBe("236834635605");
    expect(status.ebay.listing_status).toBe("ACTIVE");
    expect(status.ebay.url).toBe("https://www.ebay.it/itm/236834635605");

    const photos = await readdir(path.join(root, "winston-graham-ross-poldark", "photos"));
    expect(photos.sort()).toEqual(["remote-01.jpg", "remote-02.jpg"]);

    expect(result.refreshed).toHaveLength(1);
    expect(result.refreshed[0].slug).toBe("anthony-robbins-soldi-domina-il-gioco-live");
    expect(result.refreshed[0].listing_status).toBe("ENDED");
    expect(result.refreshed[0].changes.join(" ")).toContain("ENDED");

    const refreshedStatus = JSON.parse(
      await readFile(path.join(root, "anthony-robbins-soldi-domina-il-gioco-live", "status.json"), "utf8")
    );
    expect(refreshedStatus.ebay.listing_status).toBe("ENDED");
    expect(refreshedStatus.published_at).toBe("2026-03-16T17:59:29.779Z");

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]).toMatchObject({
      imported_slug: "bianca-marconero-lady-pride-and-mister-prejudic",
      local_slug: "lady-pride-and-mister-prejudice-bianca-marconero"
    });
  });

  it("never overwrites a folder whose slug is already taken", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sellbot-import-"));
    const root = path.join(cwd, "ToSell");

    await seedListing(root, "winston-graham-ross-poldark", emptyEbayStatus);
    await writeFile(path.join(root, "winston-graham-ross-poldark", "draft.json"), '{"keep":"me"}', "utf8");

    vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1]), { status: 200 }));

    const result = await importRemoteListings(makeConfig(cwd), {}, makeRuntime());

    expect(result.skipped.map((entry) => entry.slug)).toContain("winston-graham-ross-poldark");
    expect(result.skipped.find((entry) => entry.slug === "winston-graham-ross-poldark")?.reason).toBe("slug_taken");
    expect(await readFile(path.join(root, "winston-graham-ross-poldark", "draft.json"), "utf8")).toBe('{"keep":"me"}');
  });

  it("redownloads photos for linked folders holding only imported copies", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sellbot-import-"));
    const root = path.join(cwd, "ToSell");
    const slug = "anthony-robbins-soldi-domina-il-gioco-live";

    await seedListing(root, slug, {
      state: "published",
      published_at: "2026-03-16T17:59:29.779Z",
      ebay: {
        sku: "sb-anthony-robbins-soldi-domina-il-gioco-live",
        offer_id: "133267615011",
        listing_id: "236692443289",
        url: "https://www.ebay.it/itm/236692443289"
      },
      last_error: null
    });

    const photosDir = path.join(root, slug, "photos");
    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "remote-01.jpg"), "vecchia", "utf8");

    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      requested.push(String(input));
      return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });

    const result = await importRemoteListings(makeConfig(cwd), { redownloadPhotos: true }, makeRuntime());

    const refreshed = result.refreshed.find((entry) => entry.slug === slug);
    expect(refreshed?.photos_downloaded).toBe(1);
    expect(refreshed?.changes.join(" ")).toContain("foto reimportate");

    expect(requested).toContain("https://i.ebayimg.com/00/s/MTI4MFg5NjA=/z/robbins/$_57.JPG?set_id=8800005007");

    expect((await readdir(photosDir)).sort()).toEqual(["remote-01.jpg"]);
    expect(await readFile(path.join(photosDir, "remote-01.jpg"), "utf8")).not.toBe("vecchia");
  });

  it("skips the redownload when the folder holds hand-taken photos", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sellbot-import-"));
    const root = path.join(cwd, "ToSell");
    const slug = "anthony-robbins-soldi-domina-il-gioco-live";

    await seedListing(root, slug, {
      state: "published",
      published_at: "2026-03-16T17:59:29.779Z",
      ebay: {
        sku: "sb-anthony-robbins-soldi-domina-il-gioco-live",
        offer_id: "133267615011",
        listing_id: "236692443289",
        url: "https://www.ebay.it/itm/236692443289"
      },
      last_error: null
    });

    const photosDir = path.join(root, slug, "photos");
    await mkdir(photosDir, { recursive: true });
    await writeFile(path.join(photosDir, "IMG_3250.HEIC"), "scattata a mano", "utf8");

    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      requested.push(String(input));
      return new Response(new Uint8Array([9, 9, 9]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });

    const result = await importRemoteListings(makeConfig(cwd), { redownloadPhotos: true }, makeRuntime());

    const refreshed = result.refreshed.find((entry) => entry.slug === slug);
    expect(refreshed?.photos_downloaded).toBe(0);
    expect(refreshed?.changes.join(" ")).toContain("redownload saltato");

    expect(requested.some((url) => url.includes("robbins"))).toBe(false);
    expect((await readdir(photosDir)).sort()).toEqual(["IMG_3250.HEIC"]);
    expect(await readFile(path.join(photosDir, "IMG_3250.HEIC"), "utf8")).toBe("scattata a mano");
  });

  it("writes nothing in dry run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "sellbot-import-"));
    const root = path.join(cwd, "ToSell");
    await mkdir(root, { recursive: true });

    const result = await importRemoteListings(makeConfig(cwd), { dryRun: true }, makeRuntime());

    expect(result.dry_run).toBe(true);
    expect(result.imported).toHaveLength(3);
    expect(await readdir(root)).toEqual([]);
  });
});
