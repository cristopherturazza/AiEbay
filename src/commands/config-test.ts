import { loadRuntimeConfig, missingPublishConfigItems, requirePublishConfiguration } from "../config.js";
import { SellbotError } from "../errors.js";
import { EbayAccountClient } from "../ebay/account.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
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

const runCheck = async (name: string, operation: () => Promise<unknown>): Promise<CheckResult> => {
  try {
    await operation();
    return { name, ok: true };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: (error as Error).message
    };
  }
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
  let publishConfig: ReturnType<typeof requirePublishConfiguration> | null = null;

  try {
    const oauthClient = createUserOAuthClient(config);

    accessToken = await getValidUserAccessToken(config, oauthClient);
    checks.push({ name: "Token valido (o refresh riuscito)", ok: true });
  } catch (error) {
    checks.push({
      name: "Token valido (o refresh riuscito)",
      ok: false,
      detail: (error as Error).message
    });
  }

  if (missing.length === 0) {
    publishConfig = requirePublishConfiguration(config);
  }

  if (accessToken && publishConfig) {
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });

    const policyChecks: Array<Promise<CheckResult>> = [
      runCheck("Fulfillment policy accessibile", async () =>
        accountClient.getFulfillmentPolicy(accessToken, publishConfig.policies.fulfillmentPolicyId)
      ),
      runCheck("Payment policy accessibile", async () =>
        accountClient.getPaymentPolicy(accessToken, publishConfig.policies.paymentPolicyId)
      ),
      runCheck("Return policy accessibile", async () =>
        accountClient.getReturnPolicy(accessToken, publishConfig.policies.returnPolicyId)
      ),
      runCheck("merchantLocationKey accessibile", async () =>
        accountClient.getInventoryLocation(accessToken, publishConfig.merchantLocationKey)
      )
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
