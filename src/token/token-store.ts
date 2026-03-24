import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { SellbotError } from "../errors.js";
import type { RuntimeConfig } from "../config.js";
import { EbayOAuthClient, type TokenResponse } from "../ebay/oauth.js";

const tokenFileSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  expires_at: z.string().datetime(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  refresh_token_expires_at: z.string().datetime().optional(),
  scope: z.string().optional(),
  obtained_at: z.string().datetime(),
  last_refresh_attempt_at: z.string().datetime().optional(),
  last_refresh_error_code: z.string().min(1).optional(),
  last_refresh_error_message: z.string().min(1).optional()
});

export type TokenFile = z.infer<typeof tokenFileSchema>;

const sanitizeFileToken = (value: string | undefined): string => {
  const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized && sanitized.length > 0 ? sanitized : "default";
};

export const tokenFilePath = (config?: RuntimeConfig): string => {
  if (!config) {
    return path.join(os.homedir(), ".sellbot", "ebay-token.json");
  }

  const envToken = sanitizeFileToken(config.ebayEnv);
  const clientToken = sanitizeFileToken(config.ebayClientId);
  return path.join(os.homedir(), ".sellbot", `ebay-token.${envToken}.${clientToken}.json`);
};

const toTokenFile = (token: TokenResponse): TokenFile => {
  const now = Date.now();
  const expiresAt = new Date(now + token.expires_in * 1000).toISOString();

  return {
    access_token: token.access_token,
    token_type: token.token_type,
    expires_in: token.expires_in,
    expires_at: expiresAt,
    refresh_token: token.refresh_token,
    refresh_token_expires_in: token.refresh_token_expires_in,
    refresh_token_expires_at:
      token.refresh_token_expires_in !== undefined
        ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
        : undefined,
    scope: token.scope,
    obtained_at: new Date(now).toISOString()
  };
};

const ensureSecureStorage = async (): Promise<void> => {
  const dir = path.dirname(tokenFilePath());
  await mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    await chmod(dir, 0o700);
  } catch {
    // best effort
  }
};

const writeTokenFile = async (stored: TokenFile, config?: RuntimeConfig): Promise<void> => {
  const filePath = tokenFilePath(config);

  await writeFile(filePath, `${JSON.stringify(tokenFileSchema.parse(stored), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  try {
    await chmod(filePath, 0o600);
  } catch {
    // best effort
  }
};

export const saveToken = async (token: TokenResponse, config?: RuntimeConfig): Promise<TokenFile> => {
  await ensureSecureStorage();
  const stored = tokenFileSchema.parse({
    ...toTokenFile(token),
    last_refresh_attempt_at: undefined,
    last_refresh_error_code: undefined,
    last_refresh_error_message: undefined
  });
  await writeTokenFile(stored, config);

  return stored;
};

export const readToken = async (config?: RuntimeConfig): Promise<TokenFile | null> => {
  const filePath = tokenFilePath(config);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return tokenFileSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new SellbotError("TOKEN_INVALID", `Token locale non valido: ${(error as Error).message}`);
  }
};

export const markTokenRefreshFailure = async (
  config: RuntimeConfig,
  error: { code?: string; message: string }
): Promise<void> => {
  const token = await readToken(config);
  if (!token) {
    return;
  }

  await ensureSecureStorage();
  await writeTokenFile(
    {
      ...token,
      last_refresh_attempt_at: new Date().toISOString(),
      last_refresh_error_code: error.code,
      last_refresh_error_message: error.message
    },
    config
  );
};

const tokenExpired = (token: TokenFile, bufferSeconds = 60): boolean => {
  const expiry = new Date(token.expires_at).getTime();
  return Date.now() + bufferSeconds * 1000 >= expiry;
};

const assertScopes = (token: TokenFile, requiredScopes: string[]): void => {
  if (requiredScopes.length === 0 || !token.scope) {
    return;
  }

  const tokenScopes = new Set(token.scope.split(/\s+/).filter(Boolean));
  const missingScopes = requiredScopes.filter((scope) => !tokenScopes.has(scope));

  if (missingScopes.length > 0) {
    throw new SellbotError(
      "TOKEN_SCOPE_MISSING",
      `Il token non contiene scope richiesti: ${missingScopes.join(", ")}. Eseguire nuovamente 'sellbot auth'.`
    );
  }
};

export const getValidUserAccessToken = async (
  config: RuntimeConfig,
  oauthClient: EbayOAuthClient
): Promise<string> => {
  const token = await readToken(config);
  if (!token) {
    throw new SellbotError("TOKEN_MISSING", `Token non trovato: ${tokenFilePath(config)}. Esegui prima 'sellbot auth'.`);
  }

  if (!tokenExpired(token)) {
    assertScopes(token, config.ebayScopes);
    return token.access_token;
  }

  if (!token.refresh_token) {
    throw new SellbotError("TOKEN_EXPIRED", "Access token scaduto e refresh token assente. Eseguire di nuovo 'sellbot auth'.");
  }

  let refreshed: TokenResponse;
  try {
    refreshed = await oauthClient.refreshAccessToken(token.refresh_token);
  } catch (error) {
    await markTokenRefreshFailure(config, {
      code: error instanceof SellbotError ? error.code : "TOKEN_REFRESH_FAILED",
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  // Manteniamo il refresh token precedente se la response non ne restituisce uno nuovo.
  if (!refreshed.refresh_token) {
    refreshed.refresh_token = token.refresh_token;
    refreshed.refresh_token_expires_in = token.refresh_token_expires_in;
  }

  const stored = await saveToken(refreshed, config);
  assertScopes(stored, config.ebayScopes);

  return stored.access_token;
};
