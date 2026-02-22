import { randomBytes } from "node:crypto";
import { z } from "zod";
import EbayAuthToken from "ebay-oauth-nodejs-client";
import { SellbotError } from "../errors.js";

interface OAuthClientOptions {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  scopes: string[];
  authBaseUrl?: string;
  apiBaseUrl?: string;
  environment?: "SANDBOX" | "PRODUCTION";
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

const oauthSuccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.coerce.number().int().positive().optional(),
  scope: z.string().optional()
});

const oauthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional()
});

const APP_SCOPE = "https://api.ebay.com/oauth/api_scope";

const inferEnvironment = (options: OAuthClientOptions): "SANDBOX" | "PRODUCTION" => {
  if (options.environment) {
    return options.environment;
  }

  const authBase = options.authBaseUrl?.toLowerCase() ?? "";
  const apiBase = options.apiBaseUrl?.toLowerCase() ?? "";

  if (authBase.includes("sandbox") || apiBase.includes("sandbox")) {
    return "SANDBOX";
  }

  return "PRODUCTION";
};

export class EbayOAuthClient {
  private readonly environment: "SANDBOX" | "PRODUCTION";
  private readonly sdkClient: EbayAuthToken;

  constructor(private readonly options: OAuthClientOptions) {
    this.environment = inferEnvironment(options);
    this.sdkClient = new EbayAuthToken({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri: options.redirectUri,
      env: this.environment
    });
  }

  createState(): string {
    return randomBytes(16).toString("hex");
  }

  // eBay official Node OAuth SDK:
  // https://developer.ebay.com/develop/sdks-and-widgets
  // eBay OAuth authorize endpoint (docs):
  // https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant-request.html
  createConsentUrl(state: string): string {
    if (!this.options.redirectUri) {
      throw new Error("redirectUri mancante per il flusso authorization code");
    }

    return this.sdkClient.generateUserAuthorizationUrl(this.environment, this.options.scopes, { state });
  }

  // eBay token exchange (docs):
  // https://developer.ebay.com/api-docs/static/oauth-authorization-code-grant-request.html
  async exchangeAuthorizationCode(code: string): Promise<TokenResponse> {
    if (!this.options.redirectUri) {
      throw new Error("redirectUri mancante per il flusso authorization code");
    }

    const rawResponse = await this.sdkClient.exchangeCodeForAccessToken(this.environment, code);
    return this.parseTokenResponse(rawResponse);
  }

  // eBay refresh token grant (docs):
  // https://developer.ebay.com/api-docs/static/oauth-refresh-token-request.html
  async refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
    const rawResponse = await this.sdkClient.getAccessToken(this.environment, refreshToken, this.options.scopes);
    return this.parseTokenResponse(rawResponse);
  }

  // eBay client credentials grant for Taxonomy read calls.
  async createApplicationToken(): Promise<TokenResponse> {
    const rawResponse = await this.sdkClient.getApplicationToken(this.environment, APP_SCOPE);
    return this.parseTokenResponse(rawResponse);
  }

  private parseTokenResponse(rawResponse: string): TokenResponse {
    let parsed: unknown;

    try {
      parsed = JSON.parse(rawResponse) as unknown;
    } catch (error) {
      throw new SellbotError(
        "OAUTH_SDK_RESPONSE_INVALID",
        `Risposta OAuth non parsabile dalla SDK ufficiale: ${(error as Error).message}`
      );
    }

    const maybeError = oauthErrorSchema.safeParse(parsed);
    if (maybeError.success) {
      throw new SellbotError(
        "OAUTH_ERROR",
        `${maybeError.data.error}${maybeError.data.error_description ? `: ${maybeError.data.error_description}` : ""}`
      );
    }

    try {
      return oauthSuccessSchema.parse(parsed);
    } catch (error) {
      throw new SellbotError(
        "OAUTH_SDK_RESPONSE_INVALID",
        `Token OAuth non valido nella risposta SDK: ${(error as Error).message}`
      );
    }
  }
}
