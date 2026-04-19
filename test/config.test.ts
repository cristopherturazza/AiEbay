import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRuntimeConfig,
  missingPublishConfigItems,
  requirePublishConfiguration,
  resolveFulfillmentPolicyId,
  resolveShippingProfileConfig,
  type RuntimeConfig
} from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";

const temporaryRoots: string[] = [];
const ENV_KEYS = [
  "EBAY_ENV",
  "SELLBOT_ENV_FILE",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_RUNAME",
  "EBAY_CALLBACK_URL",
  "EBAY_SCOPES",
  "EBAY_MARKETPLACE_ID",
  "SELLBOT_CONFIG_FILE",
  "SELLBOT_PORT",
  "SELLBOT_NOTIFICATION_ENDPOINT_URL",
  "SELLBOT_NOTIFICATION_VERIFICATION_TOKEN"
] as const;

const environmentSnapshot = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

afterEach(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;

  for (const key of ENV_KEYS) {
    const value = environmentSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }
});

const makeConfig = (overrides?: Partial<RuntimeConfig>): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("sandbox");

  return {
    cwd: "/tmp/sellbot",
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
    merchantLocationKey: "LOC-1",
    policies: {
      fulfillmentPolicyId: "FULFILLMENT-DEFAULT",
      fulfillmentPolicyIdByProfile: {
        book: "FULFILLMENT-BOOK"
      },
      paymentPolicyId: "PAYMENT-1",
      returnPolicyId: "RETURN-1"
    },
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "gemma4:e4b",
      visionKeepAlive: "60s",
      visionTimeoutMs: 120_000
    },
    ...overrides
  };
};

describe.sequential("publish policy resolution", () => {
  it("resolves profile-specific fulfillment policy", () => {
    const config = makeConfig();

    expect(resolveFulfillmentPolicyId(config, { fulfillmentProfile: "book" })).toBe("FULFILLMENT-BOOK");
    expect(resolveFulfillmentPolicyId(config, { fulfillmentProfile: "BOOK" })).toBe("FULFILLMENT-BOOK");
  });

  it("falls back to default fulfillment policy when profile is unknown", () => {
    const config = makeConfig();

    expect(resolveFulfillmentPolicyId(config, { fulfillmentProfile: "fragile" })).toBe(
      "FULFILLMENT-DEFAULT"
    );
  });

  it("resolves shipping profile config by normalized profile key with default fallback", () => {
    const config = makeConfig({
      shippingProfiles: {
        default: {
          label: "Spedizione base",
          pricingMode: "included_in_item_price"
        },
        book: {
          label: "Libro standard Italia",
          carrierCode: "POST_ITALIANO",
          serviceCode: "IT_Posta1",
          pricingMode: "separate_charge"
        }
      }
    });

    expect(resolveShippingProfileConfig(config, "BOOK")?.serviceCode).toBe("IT_Posta1");
    expect(resolveShippingProfileConfig(config, "fragile")?.label).toBe("Spedizione base");
    expect(resolveShippingProfileConfig(config)?.label).toBe("Spedizione base");
  });

  it("requires default fulfillment policy when no listing profile is provided", () => {
    const config = makeConfig({
      policies: {
        fulfillmentPolicyId: undefined,
        fulfillmentPolicyIdByProfile: {
          book: "FULFILLMENT-BOOK"
        },
        paymentPolicyId: "PAYMENT-1",
        returnPolicyId: "RETURN-1"
      }
    });

    expect(missingPublishConfigItems(config)).toContain("policies.fulfillmentPolicyId");
  });

  it("accepts profile-only fulfillment setup when listing provides a matching profile", () => {
    const config = makeConfig({
      policies: {
        fulfillmentPolicyId: undefined,
        fulfillmentPolicyIdByProfile: {
          book: "FULFILLMENT-BOOK"
        },
        paymentPolicyId: "PAYMENT-1",
        returnPolicyId: "RETURN-1"
      }
    });

    expect(missingPublishConfigItems(config, { fulfillmentProfile: "book" })).toEqual([]);
    expect(
      requirePublishConfiguration(config, {
        fulfillmentProfile: "book"
      }).policies.fulfillmentPolicyId
    ).toBe("FULFILLMENT-BOOK");
  });

  it("loads base .env then overlays the environment-specific file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-config-test-"));
    temporaryRoots.push(root);

    await writeFile(
      path.join(root, ".env"),
      ["EBAY_ENV=prod", "SELLBOT_PORT=3000", "EBAY_MARKETPLACE_ID=EBAY_IT"].join("\n")
    );
    await writeFile(
      path.join(root, ".env.prod"),
      [
        "EBAY_CLIENT_ID=prod-client",
        "EBAY_CLIENT_SECRET=prod-secret",
        "EBAY_RUNAME=prod-runame",
        "SELLBOT_CONFIG_FILE=sellbot.config.prod.json"
      ].join("\n")
    );

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    const config = await loadRuntimeConfig(root);

    expect(config.ebayEnv).toBe("prod");
    expect(config.ebayClientId).toBe("prod-client");
    expect(config.ebayClientSecret).toBe("prod-secret");
    expect(config.ebayRuname).toBe("prod-runame");
    expect(config.sellbotPort).toBe(3000);
  });

  it("applies SELLBOT_ENV_FILE as the last file overlay before shell variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-config-test-"));
    temporaryRoots.push(root);

    await writeFile(path.join(root, ".env"), "EBAY_ENV=sandbox\n");
    await writeFile(path.join(root, ".env.sandbox"), "EBAY_CLIENT_ID=sandbox-client\n");
    await writeFile(
      path.join(root, ".env.override"),
      ["EBAY_CLIENT_ID=override-client", "EBAY_RUNAME=override-runame"].join("\n")
    );

    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
    process.env.SELLBOT_ENV_FILE = ".env.override";
    process.env.EBAY_CLIENT_SECRET = "shell-secret";

    const config = await loadRuntimeConfig(root);

    expect(config.ebayEnv).toBe("sandbox");
    expect(config.ebayClientId).toBe("override-client");
    expect(config.ebayRuname).toBe("override-runame");
    expect(config.ebayClientSecret).toBe("shell-secret");
  });
});
