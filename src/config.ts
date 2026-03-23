import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { SellbotError } from "./errors.js";
import { defaultEbayBaseUrls, type EbayEnvironment } from "./ebay/urls.js";

const emptyToUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());
const moneyAmountSchema = z.object({
  value: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/)
});
const shippingProfileConfigSchema = z.object({
  label: z.string().min(1).optional(),
  carrierCode: z.string().min(1).optional(),
  serviceCode: z.string().min(1).optional(),
  pricingMode: z.enum(["separate_charge", "included_in_item_price"]).optional(),
  buyerCharge: moneyAmountSchema.optional(),
  estimatedCarrierCost: moneyAmountSchema.optional(),
  notes: z.string().min(1).optional()
});

const envSchema = z.object({
  EBAY_ENV: z.enum(["sandbox", "prod"]).default("sandbox"),
  EBAY_CLIENT_ID: optionalString(),
  EBAY_CLIENT_SECRET: optionalString(),
  EBAY_RUNAME: optionalString(),
  EBAY_CALLBACK_URL: optionalUrl(),
  // Backward compatibility (deprecated):
  // previous versions used EBAY_REDIRECT_URI as callback URL.
  EBAY_REDIRECT_URI: optionalString(),
  EBAY_SCOPES: optionalString(),
  EBAY_MARKETPLACE_ID: z.string().min(1).default("EBAY_IT"),
  SELLBOT_PORT: z.coerce.number().int().positive().default(3000),
  EBAY_AUTH_BASE_URL: optionalUrl(),
  EBAY_API_BASE_URL: optionalUrl(),
  EBAY_MEDIA_BASE_URL: optionalUrl(),
  SELLBOT_ENV_FILE: optionalString(),
  SELLBOT_CONFIG_FILE: optionalString(),
  SELLBOT_NOTIFICATION_ENDPOINT_URL: optionalUrl(),
  SELLBOT_NOTIFICATION_VERIFICATION_TOKEN: optionalString()
});

const projectConfigSchema = z.object({
  marketplaceId: z.string().min(1).optional(),
  locale: z.string().min(2).optional(),
  merchantLocationKey: z.string().min(1).optional(),
  shippingProfiles: z.record(z.string().min(1), shippingProfileConfigSchema).optional(),
  policies: z
    .object({
      fulfillmentPolicyId: z.string().min(1).optional(),
      fulfillmentPolicyIdByProfile: z.record(z.string().min(1), z.string().min(1)).optional(),
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
  ebayRuname?: string;
  ebayCallbackUrl?: string;
  ebayScopes: string[];
  ebayMarketplaceId: string;
  sellbotPort: number;
  ebayAuthBaseUrl: string;
  ebayApiBaseUrl: string;
  ebayMediaBaseUrl: string;
  locale: string;
  notificationEndpointUrl?: string;
  notificationVerificationToken?: string;
  merchantLocationKey?: string;
  shippingProfiles?: Record<string, ShippingProfileConfig>;
  policies: {
    fulfillmentPolicyId?: string;
    fulfillmentPolicyIdByProfile?: Record<string, string>;
    paymentPolicyId?: string;
    returnPolicyId?: string;
  };
}

export interface MoneyAmount {
  value: number;
  currency: string;
}

export interface ShippingProfileConfig {
  label?: string;
  carrierCode?: string;
  serviceCode?: string;
  pricingMode?: "separate_charge" | "included_in_item_price";
  buyerCharge?: MoneyAmount;
  estimatedCarrierCost?: MoneyAmount;
  notes?: string;
}

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly"
];

const ENV_DESCRIPTION = ".env / .env.<env> / SELLBOT_ENV_FILE";

const isHttpUrl = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  return /^https?:\/\//i.test(value.trim());
};

const parseScopes = (rawScopes: string | undefined): string[] => {
  if (!rawScopes) {
    return [...DEFAULT_SCOPES];
  }

  const parsed = rawScopes
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  const uniqueScopes: string[] = [];
  const seen = new Set<string>();

  for (const scope of parsed) {
    if (seen.has(scope)) {
      continue;
    }

    seen.add(scope);
    uniqueScopes.push(scope);
  }

  return uniqueScopes;
};

const toEbayEnvironment = (value: string | undefined): EbayEnvironment => {
  return value === "prod" ? "prod" : "sandbox";
};

const readEnvFile = async (filePath: string): Promise<Record<string, string>> => {
  try {
    const raw = await readFile(filePath, "utf8");
    return dotenv.parse(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new SellbotError("ENV_INVALID", `${filePath} non valido: ${(error as Error).message}`);
  }
};

const loadMergedEnv = async (cwd: string): Promise<NodeJS.ProcessEnv> => {
  const baseEnvPath = path.resolve(cwd, ".env");
  const baseEnv = await readEnvFile(baseEnvPath);

  const preliminaryEnv = {
    ...baseEnv,
    ...process.env
  };
  const ebayEnv = toEbayEnvironment(preliminaryEnv.EBAY_ENV);

  const environmentEnvPath = path.resolve(cwd, `.env.${ebayEnv}`);
  const environmentEnv = await readEnvFile(environmentEnvPath);

  const customEnvFile = process.env.SELLBOT_ENV_FILE ?? environmentEnv.SELLBOT_ENV_FILE ?? baseEnv.SELLBOT_ENV_FILE;
  const customEnv = customEnvFile ? await readEnvFile(path.resolve(cwd, customEnvFile)) : {};

  return {
    ...baseEnv,
    ...environmentEnv,
    ...customEnv,
    ...process.env
  };
};

const normalizeFulfillmentProfileKey = (value: string): string => value.trim().toLowerCase();

const normalizeMoneyAmount = (value: z.infer<typeof moneyAmountSchema> | undefined): MoneyAmount | undefined => {
  if (!value) {
    return undefined;
  }

  return {
    value: Number(value.value.toFixed(2)),
    currency: value.currency.trim().toUpperCase()
  };
};

const normalizeProfilePolicyMap = (
  value: Record<string, string> | undefined
): Record<string, string> | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = Object.entries(value).reduce<Record<string, string>>((acc, [profile, policyId]) => {
    const normalizedProfile = normalizeFulfillmentProfileKey(profile);
    const normalizedPolicyId = policyId.trim();
    if (!normalizedProfile || !normalizedPolicyId) {
      return acc;
    }

    acc[normalizedProfile] = normalizedPolicyId;
    return acc;
  }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeShippingProfiles = (
  value: Record<string, z.infer<typeof shippingProfileConfigSchema>> | undefined
): Record<string, ShippingProfileConfig> | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = Object.entries(value).reduce<Record<string, ShippingProfileConfig>>((acc, [profile, entry]) => {
    const normalizedProfile = normalizeFulfillmentProfileKey(profile);
    if (!normalizedProfile) {
      return acc;
    }

    const normalizedEntry: ShippingProfileConfig = {
      label: entry.label?.trim() || undefined,
      carrierCode: entry.carrierCode?.trim() || undefined,
      serviceCode: entry.serviceCode?.trim() || undefined,
      pricingMode: entry.pricingMode,
      buyerCharge: normalizeMoneyAmount(entry.buyerCharge),
      estimatedCarrierCost: normalizeMoneyAmount(entry.estimatedCarrierCost),
      notes: entry.notes?.trim() || undefined
    };

    if (
      !normalizedEntry.label &&
      !normalizedEntry.carrierCode &&
      !normalizedEntry.serviceCode &&
      !normalizedEntry.pricingMode &&
      !normalizedEntry.buyerCharge &&
      !normalizedEntry.estimatedCarrierCost &&
      !normalizedEntry.notes
    ) {
      return acc;
    }

    acc[normalizedProfile] = normalizedEntry;
    return acc;
  }, {});

  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const readProjectConfig = async (
  cwd: string,
  configuredPath?: string
): Promise<z.infer<typeof projectConfigSchema>> => {
  const configPath = configuredPath
    ? path.resolve(cwd, configuredPath)
    : path.resolve(cwd, "sellbot.config.json");

  try {
    const raw = await readFile(configPath, "utf8");
    const json = JSON.parse(raw) as unknown;
    return projectConfigSchema.parse(json);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new SellbotError("CONFIG_INVALID", `${configPath} non valido: ${(error as Error).message}`);
  }
};

export const loadRuntimeConfig = async (cwd = process.cwd()): Promise<RuntimeConfig> => {
  const loadedEnv = await loadMergedEnv(cwd);
  const env = envSchema.parse(loadedEnv);
  const projectConfig = await readProjectConfig(cwd, env.SELLBOT_CONFIG_FILE);
  const defaults = defaultEbayBaseUrls(env.EBAY_ENV);
  const deprecatedRedirect = env.EBAY_REDIRECT_URI?.trim();

  const ebayRuname = env.EBAY_RUNAME?.trim() || (isHttpUrl(deprecatedRedirect) ? undefined : deprecatedRedirect);
  const ebayCallbackUrl =
    env.EBAY_CALLBACK_URL?.trim() || (isHttpUrl(deprecatedRedirect) ? deprecatedRedirect : undefined);

  return {
    cwd,
    ebayEnv: env.EBAY_ENV,
    ebayClientId: env.EBAY_CLIENT_ID,
    ebayClientSecret: env.EBAY_CLIENT_SECRET,
    ebayRuname,
    ebayCallbackUrl,
    ebayScopes: parseScopes(env.EBAY_SCOPES),
    ebayMarketplaceId: projectConfig.marketplaceId ?? env.EBAY_MARKETPLACE_ID,
    sellbotPort: env.SELLBOT_PORT,
    ebayAuthBaseUrl: env.EBAY_AUTH_BASE_URL ?? defaults.authBaseUrl,
    ebayApiBaseUrl: env.EBAY_API_BASE_URL ?? defaults.apiBaseUrl,
    ebayMediaBaseUrl: env.EBAY_MEDIA_BASE_URL ?? defaults.mediaBaseUrl,
    locale: projectConfig.locale ?? "it-IT",
    notificationEndpointUrl: env.SELLBOT_NOTIFICATION_ENDPOINT_URL,
    notificationVerificationToken: env.SELLBOT_NOTIFICATION_VERIFICATION_TOKEN,
    merchantLocationKey: projectConfig.merchantLocationKey,
    shippingProfiles: normalizeShippingProfiles(projectConfig.shippingProfiles),
    policies: {
      fulfillmentPolicyId: projectConfig.policies?.fulfillmentPolicyId,
      fulfillmentPolicyIdByProfile: normalizeProfilePolicyMap(projectConfig.policies?.fulfillmentPolicyIdByProfile),
      paymentPolicyId: projectConfig.policies?.paymentPolicyId,
      returnPolicyId: projectConfig.policies?.returnPolicyId
    }
  };
};

export const requireNotificationConfig = (config: RuntimeConfig): {
  endpointUrl: string;
  verificationToken: string;
} => {
  if (!config.notificationEndpointUrl) {
    throw new SellbotError(
      "ENV_MISSING",
      `SELLBOT_NOTIFICATION_ENDPOINT_URL mancante nella configurazione env (${ENV_DESCRIPTION})`
    );
  }

  if (!config.notificationVerificationToken) {
    throw new SellbotError(
      "ENV_MISSING",
      `SELLBOT_NOTIFICATION_VERIFICATION_TOKEN mancante nella configurazione env (${ENV_DESCRIPTION})`
    );
  }

  return {
    endpointUrl: config.notificationEndpointUrl,
    verificationToken: config.notificationVerificationToken
  };
};

export const requireOAuthConfig = (config: RuntimeConfig): {
  clientId: string;
  clientSecret: string;
  runame: string;
  callbackUrl?: string;
} => {
  if (!config.ebayClientId) {
    throw new SellbotError("ENV_MISSING", `EBAY_CLIENT_ID mancante nella configurazione env (${ENV_DESCRIPTION})`);
  }

  if (!config.ebayClientSecret) {
    throw new SellbotError(
      "ENV_MISSING",
      `EBAY_CLIENT_SECRET mancante nella configurazione env (${ENV_DESCRIPTION})`
    );
  }

  if (!config.ebayRuname) {
    throw new SellbotError("ENV_MISSING", `EBAY_RUNAME mancante nella configurazione env (${ENV_DESCRIPTION})`);
  }

  return {
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret,
    runame: config.ebayRuname,
    callbackUrl: config.ebayCallbackUrl
  };
};

export const requireClientCredentials = (config: RuntimeConfig): {
  clientId: string;
  clientSecret: string;
} => {
  if (!config.ebayClientId) {
    throw new SellbotError("ENV_MISSING", `EBAY_CLIENT_ID mancante nella configurazione env (${ENV_DESCRIPTION})`);
  }

  if (!config.ebayClientSecret) {
    throw new SellbotError(
      "ENV_MISSING",
      `EBAY_CLIENT_SECRET mancante nella configurazione env (${ENV_DESCRIPTION})`
    );
  }

  return {
    clientId: config.ebayClientId,
    clientSecret: config.ebayClientSecret
  };
};

interface PublishConfigResolutionOptions {
  fulfillmentProfile?: string;
}

export const resolveFulfillmentPolicyId = (
  config: RuntimeConfig,
  options?: PublishConfigResolutionOptions
): string | undefined => {
  const normalizedProfile = options?.fulfillmentProfile
    ? normalizeFulfillmentProfileKey(options.fulfillmentProfile)
    : undefined;

  if (normalizedProfile) {
    const byProfilePolicy = config.policies.fulfillmentPolicyIdByProfile?.[normalizedProfile];
    if (byProfilePolicy) {
      return byProfilePolicy;
    }
  }

  return config.policies.fulfillmentPolicyId;
};

export const resolveShippingProfileConfig = (
  config: RuntimeConfig,
  profile?: string
): ShippingProfileConfig | undefined => {
  const normalizedProfile = profile ? normalizeFulfillmentProfileKey(profile) : undefined;

  if (normalizedProfile) {
    const directMatch = config.shippingProfiles?.[normalizedProfile];
    if (directMatch) {
      return directMatch;
    }
  }

  return config.shippingProfiles?.default;
};

export const missingPublishConfigItems = (
  config: RuntimeConfig,
  options?: PublishConfigResolutionOptions
): string[] => {
  const missing: string[] = [];

  const resolvedFulfillmentPolicyId = resolveFulfillmentPolicyId(config, options);
  const requestedFulfillmentProfile = options?.fulfillmentProfile?.trim();
  if (requestedFulfillmentProfile) {
    if (!resolvedFulfillmentPolicyId) {
      const normalizedProfile = normalizeFulfillmentProfileKey(requestedFulfillmentProfile);
      missing.push(
        `policies.fulfillmentPolicyId or policies.fulfillmentPolicyIdByProfile.${normalizedProfile}`
      );
    }
  } else if (!config.policies.fulfillmentPolicyId) {
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

export interface PublishConfiguration {
  merchantLocationKey: string;
  fulfillmentProfile?: string;
  policies: {
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
  };
}

export const requirePublishConfiguration = (
  config: RuntimeConfig,
  options?: PublishConfigResolutionOptions
): PublishConfiguration => {
  const missing = missingPublishConfigItems(config, options);

  if (missing.length > 0) {
    throw new SellbotError(
      "PUBLISH_CONFIG_MISSING",
      `Configurazione incompleta in sellbot.config.json: ${missing.join(", ")}`
    );
  }

  const fulfillmentPolicyId = resolveFulfillmentPolicyId(config, options);
  const fulfillmentProfile = options?.fulfillmentProfile?.trim() || undefined;

  return {
    merchantLocationKey: config.merchantLocationKey!,
    fulfillmentProfile,
    policies: {
      fulfillmentPolicyId: fulfillmentPolicyId!,
      paymentPolicyId: config.policies.paymentPolicyId!,
      returnPolicyId: config.policies.returnPolicyId!
    }
  };
};
