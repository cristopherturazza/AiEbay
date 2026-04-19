import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { listListingsSummary } from "../src/services/listing-snapshot.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
});

const makeConfig = (cwd: string, env: "sandbox" | "prod"): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls(env);

  return {
    cwd,
    ebayEnv: env,
    ebayClientId: "test-client",
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
    notificationEndpointUrl: undefined,
    notificationVerificationToken: undefined,
    merchantLocationKey: undefined,
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

describe("listing snapshot", () => {
  it("filtra per environment corrente senza nascondere draft locali", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-snapshot-"));
    temporaryRoots.push(root);

    const toSell = path.join(root, "ToSell");

    await mkdir(path.join(toSell, "prod-item", "photos"), { recursive: true });
    await mkdir(path.join(toSell, "sandbox-item", "photos"), { recursive: true });
    await mkdir(path.join(toSell, "draft-item", "photos"), { recursive: true });

    await writeFile(
      path.join(toSell, "prod-item", "status.json"),
      JSON.stringify({
        state: "published",
        published_at: "2026-03-16T00:00:00.000Z",
        ebay: {
          sku: "sku-prod",
          offer_id: "offer-prod",
          listing_id: "listing-prod",
          url: "https://www.ebay.it/itm/123"
        },
        last_error: null
      })
    );

    await writeFile(
      path.join(toSell, "sandbox-item", "status.json"),
      JSON.stringify({
        state: "published",
        published_at: "2026-03-16T00:00:00.000Z",
        ebay: {
          sku: "sku-sbx",
          offer_id: "offer-sbx",
          listing_id: "listing-sbx",
          url: "https://sandbox.ebay.com/itm/456"
        },
        last_error: null
      })
    );

    await writeFile(
      path.join(toSell, "draft-item", "status.json"),
      JSON.stringify({
        state: "draft",
        published_at: null,
        ebay: {
          sku: null,
          offer_id: null,
          listing_id: null,
          url: null
        },
        last_error: null
      })
    );

    const listings = await listListingsSummary(makeConfig(root, "prod"), {
      scope: "current_env"
    });

    expect(listings.map((entry) => entry.slug)).toEqual(["draft-item", "prod-item"]);
    expect(listings.find((entry) => entry.slug === "prod-item")?.published_env).toBe("prod");
    expect(listings.find((entry) => entry.slug === "draft-item")?.matches_current_env).toBe(true);
  });
});
