import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { tokenFilePath } from "../src/token/token-store.js";

const makeConfig = (env: "sandbox" | "prod", clientId: string): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls(env);

  return {
    cwd: "/tmp/sellbot",
    ebayEnv: env,
    ebayClientId: clientId,
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

describe("token store path", () => {
  it("namespaces token files by environment and client id", () => {
    const sandboxPath = tokenFilePath(makeConfig("sandbox", "sandbox-client"));
    const prodPath = tokenFilePath(makeConfig("prod", "prod-client"));

    expect(sandboxPath).toContain("ebay-token.sandbox.sandbox-client.json");
    expect(prodPath).toContain("ebay-token.prod.prod-client.json");
    expect(sandboxPath).not.toBe(prodPath);
  });
});
