import {
  requireClientCredentials,
  requireOAuthConfig,
  type RuntimeConfig
} from "../config.js";
import { EbayOAuthClient } from "./oauth.js";

export const toOauthEnvironment = (ebayEnv: RuntimeConfig["ebayEnv"]): "SANDBOX" | "PRODUCTION" => {
  return ebayEnv === "sandbox" ? "SANDBOX" : "PRODUCTION";
};

export const createUserOAuthClient = (config: RuntimeConfig): EbayOAuthClient => {
  const oauthConfig = requireOAuthConfig(config);

  return new EbayOAuthClient({
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    redirectUri: oauthConfig.runame,
    scopes: config.ebayScopes,
    environment: toOauthEnvironment(config.ebayEnv)
  });
};

export const createAppOAuthClient = (config: RuntimeConfig): EbayOAuthClient => {
  const credentials = requireClientCredentials(config);

  return new EbayOAuthClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    scopes: config.ebayScopes,
    environment: toOauthEnvironment(config.ebayEnv)
  });
};
