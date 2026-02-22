import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { SellbotError } from "./errors.js";
import { defaultEbayBaseUrls, type EbayEnvironment } from "./ebay/urls.js";

dotenv.config();

const envSchema = z.object({
  EBAY_ENV: z.enum(["sandbox", "prod"]).default("sandbox"),
  EBAY_CLIENT_ID: z.string().min(1).optional(),
  EBAY_CLIENT_SECRET: z.string().min(1).optional(),
  EBAY_REDIRECT_URI: z.string().min(1).optional(),
  EBAY_SCOPES: z.string().optional(),
  EBAY_MARKETPLACE_ID: z.string().min(1).default("eBay_IT"),
  SELLBOT_PORT: z.coerce.number().int().positive().default(3000),
  EBAY_AUTH_BASE_URL: z.string().url().optional(),
  EBAY_API_BASE_URL: z.string().url().optional(),
  EBAY_MEDIA_BASE_URL: z.string().url().optional()
});

const projectConfigSchema = z.object({
  marketplaceId: z.string().min(1).optional(),
  locale: z.string().min(2).optional(),
  merchantLocationKey: z.string().min(1).optional(),
  policies: z
    .object({
      fulfillmentPolicyId: z.string().min(1).optional(),
      paymentPolicyId: z.string().min(1).optional(),
      returnPolicyId: z.string().min(1).optional()
    })
    .optional()
});

export interface RuntimeConfig {
  cwd: string;
  ebayEnv: EbayEnvironment;
  ebayClientId?: string;
  ebayClientSecret?: string;
  ebayRedirectUri?: string;
  ebayScopes: string[];
  ebayMarketplaceId: string;
  sellbotPort: number;
  ebayAuthBaseUrl: string;
  ebayApiBaseUrl: string;
  ebayMediaBaseUrl: string;
  locale: string;
  merchantLocationKey?: string;
  policies: {
    fulfillmentPolicyId?: string;
    paymentPolicyId?: string;
    returnPolicyId?: string;
  };
}

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly"
];

const parseScopes = (rawScopes: string | undefined): string[] => {
  if (!rawScopes) {
    return [...DEFAULT_SCOPES];
  }

  return rawScopes
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
};

const readProjectConfig = async (cwd: string): Promise<z.infer<typeof projectConfigSchema>> => {
  const configPath = path.resolve(cwd, "sellbot.config.json");

  try {
    const raw = await readFile(configPath, "utf8");
    const json = JSON.parse(raw) as unknown;
    return projectConfigSchema.parse(json);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new SellbotError("CONFIG_INVALID", `sellbot.config.json non valido: ${(error as Error).message}`);
  }
};

export const loadRuntimeConfig = async (cwd = process.cwd()): Promise<RuntimeConfig> => {
  const env = envSchema.parse(process.env);
  const projectConfig = await readProjectConfig(cwd);
  const defaults = defaultEbayBaseUrls(env.EBAY_ENV);

  return {
    cwd,
    ebayEnv: env.EBAY_ENV,
    ebayClientId: env.EBAY_CLIENT_ID,
    ebayClientSecret: env.EBAY_CLIENT_SECRET,
    ebayRedirectUri: env.EBAY_REDIRECT_URI,
    ebayScopes: parseScopes(env.EBAY_SCOPES),
    ebayMarketplaceId: projectConfig.marketplaceId ?? env.EBAY_MARKETPLACE_ID,
    sellbotPort: env.SELLBOT_PORT,
    ebayAuthBaseUrl: env.EBAY_AUTH_BASE_URL ?? defaults.authBaseUrl,
    ebayApiBaseUrl: env.EBAY_API_BASE_URL ?? defaults.apiBaseUrl,
    ebayMediaBaseUrl: env.EBAY_MEDIA_BASE_URL ?? defaults.mediaBaseUrl,
    locale: projectConfig.locale ?? "it-IT",
    merchantLocationKey: projectConfig.merchantLocationKey,
    policies: {
      fulfillmentPolicyId: projectConfig.policies?.fulfillmentPolicyId,
      paymentPolicyId: projectConfig.policies?.paymentPolicyId,
      returnPolicyId: projectConfig.policies?.returnPolicyId
    }
  };
};

export const requireOAuthConfig = (config: RuntimeConfig): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} => {
  if (!config.ebayClientId) {
    throw new SellbotError("ENV_MISSING", "EBAY_CLIENT_ID mancante nel file .env");
  }

  if (!config.ebayClientSecret) {
    throw new SellbotError("ENV_MISSING", "EBAY_CLIENT_SECRET mancante nel file .env");
  }

  if (!config.ebayRedirectUri) {
    throw new SellbotError("ENV_MISSING", "EBAY_REDIRECT_URI mancante nel file .env");
  }

  return {
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret,
    redirectUri: config.ebayRedirectUri
  };
};

export const requireClientCredentials = (config: RuntimeConfig): {
  clientId: string;
  clientSecret: string;
} => {
  if (!config.ebayClientId) {
    throw new SellbotError("ENV_MISSING", "EBAY_CLIENT_ID mancante nel file .env");
  }

  if (!config.ebayClientSecret) {
    throw new SellbotError("ENV_MISSING", "EBAY_CLIENT_SECRET mancante nel file .env");
  }

  return {
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret
  };
};

export const missingPublishConfigItems = (config: RuntimeConfig): string[] => {
  const missing: string[] = [];

  if (!config.policies.fulfillmentPolicyId) {
    missing.push("policies.fulfillmentPolicyId");
  }
  if (!config.policies.paymentPolicyId) {
    missing.push("policies.paymentPolicyId");
  }
  if (!config.policies.returnPolicyId) {
    missing.push("policies.returnPolicyId");
  }
  if (!config.merchantLocationKey) {
    missing.push("merchantLocationKey");
  }

  return missing;
};
