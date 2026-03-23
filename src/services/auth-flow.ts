import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { requireOAuthConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import { readToken, saveToken, tokenFilePath } from "../token/token-store.js";

const pendingAuthSchema = z.object({
  state: z.string().min(1),
  consent_url: z.string().url(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  ebay_env: z.enum(["sandbox", "prod"]),
  client_id: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1)
});

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export type PendingAuthSession = z.infer<typeof pendingAuthSchema>;

const sanitizeFileToken = (value: string | undefined): string => {
  const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized && sanitized.length > 0 ? sanitized : "default";
};

const pendingAuthFilePath = (config: RuntimeConfig): string => {
  const envToken = sanitizeFileToken(config.ebayEnv);
  const clientToken = sanitizeFileToken(config.ebayClientId);
  return path.join(os.homedir(), ".sellbot", `ebay-auth.pending.${envToken}.${clientToken}.json`);
};

const ensureSecureStorage = async (): Promise<void> => {
  const dir = path.join(os.homedir(), ".sellbot");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  try {
    await chmod(dir, 0o700);
  } catch {
    // best effort
  }
};

const savePendingAuth = async (config: RuntimeConfig, session: PendingAuthSession): Promise<void> => {
  await ensureSecureStorage();
  const filePath = pendingAuthFilePath(config);

  await writeFile(filePath, `${JSON.stringify(pendingAuthSchema.parse(session), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  try {
    await chmod(filePath, 0o600);
  } catch {
    // best effort
  }
};

export const readPendingAuth = async (config: RuntimeConfig): Promise<PendingAuthSession | null> => {
  try {
    const raw = await readFile(pendingAuthFilePath(config), "utf8");
    const parsed = pendingAuthSchema.parse(JSON.parse(raw) as unknown);

    if (Date.now() > new Date(parsed.expires_at).getTime()) {
      await clearPendingAuth(config);
      return null;
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new SellbotError("AUTH_PENDING_INVALID", `Sessione OAuth locale non valida: ${(error as Error).message}`);
  }
};

export const clearPendingAuth = async (config: RuntimeConfig): Promise<void> => {
  try {
    await rm(pendingAuthFilePath(config), { force: true });
  } catch {
    // best effort
  }
};

export interface StartUserAuthResult {
  state: string;
  consentUrl: string;
  expiresAt: string;
  sessionFilePath: string;
}

export const startUserAuth = async (config: RuntimeConfig): Promise<StartUserAuthResult> => {
  requireOAuthConfig(config);
  const oauthClient = createUserOAuthClient(config);
  const state = oauthClient.createState();
  const consentUrl = oauthClient.createConsentUrl(state);
  const now = Date.now();
  const expiresAt = new Date(now + PENDING_AUTH_TTL_MS).toISOString();

  await savePendingAuth(config, {
    state,
    consent_url: consentUrl,
    created_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    ebay_env: config.ebayEnv,
    client_id: config.ebayClientId ?? "unknown",
    scopes: config.ebayScopes
  });

  return {
    state,
    consentUrl,
    expiresAt,
    sessionFilePath: pendingAuthFilePath(config)
  };
};

export const parseAuthorizationCodeFromInput = (rawValue: string, expectedState: string): string => {
  const trimmed = rawValue.trim();

  if (!trimmed) {
    throw new SellbotError("OAUTH_CODE_MISSING", "Nessun input ricevuto");
  }

  let params: URLSearchParams | null = null;

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const parsedUrl = new URL(trimmed);
    params = parsedUrl.searchParams;
  } else if (
    trimmed.startsWith("code=") ||
    trimmed.startsWith("?code=") ||
    trimmed.includes("&code=") ||
    trimmed.startsWith("error=") ||
    trimmed.startsWith("?error=") ||
    trimmed.includes("&error=") ||
    trimmed.includes("state=")
  ) {
    params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
  }

  if (!params) {
    return trimmed;
  }

  const oauthError = params.get("error");
  if (oauthError) {
    throw new SellbotError(
      "OAUTH_DENIED",
      `${oauthError}: ${params.get("error_description") ?? "nessun dettaglio"}`
    );
  }

  const receivedState = params.get("state");
  if (receivedState && receivedState !== expectedState) {
    throw new SellbotError("OAUTH_STATE", "State OAuth non valido");
  }

  const code = params.get("code");
  if (!code) {
    throw new SellbotError("OAUTH_CODE_MISSING", "Authorization code non trovato nell'input");
  }

  return code;
};

export interface CompleteUserAuthResult {
  tokenFilePath: string;
}

export const completeUserAuth = async (
  config: RuntimeConfig,
  rawRedirectUrlOrCode: string
): Promise<CompleteUserAuthResult> => {
  const pending = await readPendingAuth(config);
  if (!pending) {
    throw new SellbotError(
      "AUTH_PENDING_MISSING",
      "Nessuna sessione OAuth pendente. Avvia prima auth_start o 'sellbot auth'."
    );
  }

  const oauthClient = createUserOAuthClient(config);
  const code = parseAuthorizationCodeFromInput(rawRedirectUrlOrCode, pending.state);
  const token = await oauthClient.exchangeAuthorizationCode(code);
  await saveToken(token, config);
  await clearPendingAuth(config);

  return {
    tokenFilePath: tokenFilePath(config)
  };
};

export interface AuthStatusResult {
  env: RuntimeConfig["ebayEnv"];
  clientId?: string;
  tokenFilePath: string;
  tokenPresent: boolean;
  tokenValid: boolean;
  tokenExpiresAt?: string;
  scopes?: string[];
  pendingAuth: PendingAuthSession | null;
  reason?: string;
}

export const getUserAuthStatus = async (config: RuntimeConfig): Promise<AuthStatusResult> => {
  const token = await readToken(config);
  const pendingAuth = await readPendingAuth(config);

  if (!token) {
    return {
      env: config.ebayEnv,
      clientId: config.ebayClientId,
      tokenFilePath: tokenFilePath(config),
      tokenPresent: false,
      tokenValid: false,
      pendingAuth,
      reason: "Token utente non trovato"
    };
  }

  const expiry = new Date(token.expires_at).getTime();
  const tokenValid = Date.now() + 60 * 1000 < expiry;

  return {
    env: config.ebayEnv,
    clientId: config.ebayClientId,
    tokenFilePath: tokenFilePath(config),
    tokenPresent: true,
    tokenValid,
    tokenExpiresAt: token.expires_at,
    scopes: token.scope?.split(/\s+/).filter(Boolean) ?? [],
    pendingAuth,
    reason: tokenValid ? undefined : "Access token scaduto; un tool protetto tentera' refresh automatico"
  };
};
