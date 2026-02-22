import { loadRuntimeConfig, missingPublishConfigItems, requireOAuthConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayAccountClient } from "../ebay/account.js";
import { EbayOAuthClient } from "../ebay/oauth.js";
import { logger } from "../logger.js";
import { getValidUserAccessToken } from "../token/token-store.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const printCheck = (check: CheckResult): void => {
  const symbol = check.ok ? "OK" : "KO";
  if (check.detail) {
    logger.info(`[${symbol}] ${check.name} - ${check.detail}`);
    return;
  }

  logger.info(`[${symbol}] ${check.name}`);
};

export const runConfigTest = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  const checks: CheckResult[] = [];

  const missing = missingPublishConfigItems(config);
  checks.push({
    name: "Policy IDs + merchantLocationKey presenti",
    ok: missing.length === 0,
    detail: missing.length === 0 ? undefined : `mancanti: ${missing.join(", ")}`
  });

  let accessToken: string | null = null;

  try {
    const oauthConfig = requireOAuthConfig(config);
    const oauthClient = new EbayOAuthClient({
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      redirectUri: oauthConfig.redirectUri,
      scopes: config.ebayScopes,
      environment: config.ebayEnv === "sandbox" ? "SANDBOX" : "PRODUCTION",
      authBaseUrl: config.ebayAuthBaseUrl,
      apiBaseUrl: config.ebayApiBaseUrl
    });

    accessToken = await getValidUserAccessToken(config, oauthClient);
    checks.push({ name: "Token valido (o refresh riuscito)", ok: true });
  } catch (error) {
    checks.push({
      name: "Token valido (o refresh riuscito)",
      ok: false,
      detail: (error as Error).message
    });
  }

  if (accessToken && missing.length === 0) {
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });

    const policyChecks: Array<Promise<CheckResult>> = [
      accountClient
        .getFulfillmentPolicy(accessToken, config.policies.fulfillmentPolicyId!)
        .then(() => ({ name: "Fulfillment policy accessibile", ok: true }))
        .catch((error) => ({
          name: "Fulfillment policy accessibile",
          ok: false,
          detail: (error as Error).message
        })),
      accountClient
        .getPaymentPolicy(accessToken, config.policies.paymentPolicyId!)
        .then(() => ({ name: "Payment policy accessibile", ok: true }))
        .catch((error) => ({
          name: "Payment policy accessibile",
          ok: false,
          detail: (error as Error).message
        })),
      accountClient
        .getReturnPolicy(accessToken, config.policies.returnPolicyId!)
        .then(() => ({ name: "Return policy accessibile", ok: true }))
        .catch((error) => ({
          name: "Return policy accessibile",
          ok: false,
          detail: (error as Error).message
        })),
      accountClient
        .getInventoryLocation(accessToken, config.merchantLocationKey!)
        .then(() => ({ name: "merchantLocationKey accessibile", ok: true }))
        .catch((error) => ({
          name: "merchantLocationKey accessibile",
          ok: false,
          detail: (error as Error).message
        }))
    ];

    checks.push(...(await Promise.all(policyChecks)));
  }

  logger.info("Checklist config:test");
  for (const check of checks) {
    printCheck(check);
  }

  if (checks.some((check) => !check.ok)) {
    throw new SellbotError("CONFIG_TEST_FAILED", "Una o più verifiche config:test sono KO");
  }
};
