import type { RuntimeConfig } from "../config.js";
import { missingPublishConfigItems } from "../config.js";
import { EbayAccountClient } from "../ebay/account.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import { getValidUserAccessToken } from "../token/token-store.js";

export interface ConfigCheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const runCheck = async (name: string, operation: () => Promise<unknown>): Promise<ConfigCheckResult> => {
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

export const runConfigChecks = async (config: RuntimeConfig): Promise<ConfigCheckResult[]> => {
  const checks: ConfigCheckResult[] = [];
  const missing = missingPublishConfigItems(config);
  checks.push({
    name: "Policy IDs + merchantLocationKey presenti",
    ok: missing.length === 0,
    detail: missing.length === 0 ? undefined : `mancanti: ${missing.join(", ")}`
  });

  let accessToken: string | null = null;
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

  if (accessToken && missing.length === 0) {
    const accountClient = new EbayAccountClient({ apiBaseUrl: config.ebayApiBaseUrl });
    const paymentPolicyId = config.policies.paymentPolicyId!;
    const returnPolicyId = config.policies.returnPolicyId!;
    const merchantLocationKey = config.merchantLocationKey!;
    const configuredFulfillmentPolicies = [
      config.policies.fulfillmentPolicyId
        ? { label: "default", policyId: config.policies.fulfillmentPolicyId }
        : null,
      ...Object.entries(config.policies.fulfillmentPolicyIdByProfile ?? {}).map(([profile, policyId]) => ({
        label: profile,
        policyId
      }))
    ].filter((entry): entry is { label: string; policyId: string } => entry !== null);

    const baseChecks: Array<Promise<ConfigCheckResult>> = [
      runCheck("Payment policy accessibile", async () =>
        accountClient.getPaymentPolicy(accessToken, paymentPolicyId)
      ),
      runCheck("Return policy accessibile", async () =>
        accountClient.getReturnPolicy(accessToken, returnPolicyId)
      ),
      runCheck("merchantLocationKey accessibile", async () =>
        accountClient.getInventoryLocation(accessToken, merchantLocationKey)
      )
    ];

    const fulfillmentChecks: Array<Promise<ConfigCheckResult>> = configuredFulfillmentPolicies.map(
      ({ label, policyId }) =>
        runCheck(`Fulfillment policy accessibile (${label})`, async () =>
          accountClient.getFulfillmentPolicy(accessToken, policyId)
        )
    );

    checks.push(...(await Promise.all([...baseChecks, ...fulfillmentChecks])));
  }

  return checks;
};
