import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { z } from "zod";
import type { RuntimeConfig } from "../config.js";
import { requireOAuthConfig } from "../config.js";
import { SellbotError, isSellbotError } from "../errors.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import { readToken, saveToken, tokenFilePath } from "../token/token-store.js";

const authCallbackModeSchema = z.enum(["automatic_http", "manual"]);
const authSessionStatusSchema = z.enum(["pending_user_consent", "authenticated", "expired", "error"]);
const authErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  at: z.string().datetime()
});

const authSessionSchema = z.object({
  session_id: z.string().min(1),
  oauth_state: z.string().min(1),
  consent_url: z.string().url(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),
  callback_received_at: z.string().datetime().optional(),
  status: authSessionStatusSchema,
  callback_mode: authCallbackModeSchema,
  callback_url: z.string().url().optional(),
  ebay_env: z.enum(["sandbox", "prod"]),
  client_id: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  token_file_path: z.string().min(1).optional(),
  last_error: authErrorSchema.optional()
});

const legacyPendingAuthSchema = z.object({
  state: z.string().min(1),
  consent_url: z.string().url(),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  ebay_env: z.enum(["sandbox", "prod"]),
  client_id: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1)
});

const tokenRefreshErrorSchema = z.object({
  code: z.string().min(1).optional(),
  message: z.string().min(1),
  at: z.string().datetime().optional()
});

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export type AuthCallbackMode = z.infer<typeof authCallbackModeSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
export type PendingAuthSession = AuthSession;
export type AuthMachineState =
  | "not_configured"
  | "not_authenticated"
  | "pending_user_consent"
  | "authenticated"
  | "expired"
  | "error";

export type OAuthCallbackResponseState =
  | "authenticated"
  | "already_authenticated"
  | "invalid_state"
  | "expired"
  | "error"
  | "not_found";

const sanitizeFileToken = (value: string | undefined): string => {
  const sanitized = value?.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sanitized && sanitized.length > 0 ? sanitized : "default";
};

const authSessionFilePath = (config: RuntimeConfig): string => {
  const envToken = sanitizeFileToken(config.ebayEnv);
  const clientToken = sanitizeFileToken(config.ebayClientId);
  return path.join(os.homedir(), ".sellbot", `ebay-auth.pending.${envToken}.${clientToken}.json`);
};

const nowIso = (): string => new Date().toISOString();

const normalizePathname = (pathname: string): string => {
  if (!pathname || pathname === "/") {
    return "/";
  }

  return pathname.endsWith("/") ? pathname.slice(0, -1) || "/" : pathname;
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

const saveAuthSession = async (config: RuntimeConfig, session: AuthSession): Promise<void> => {
  await ensureSecureStorage();
  const filePath = authSessionFilePath(config);

  await writeFile(filePath, `${JSON.stringify(authSessionSchema.parse(session), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });

  try {
    await chmod(filePath, 0o600);
  } catch {
    // best effort
  }
};

const authError = (code: string, message: string) => ({
  code,
  message,
  at: nowIso()
});

const patchAuthSession = (session: AuthSession, patch: Partial<AuthSession>): AuthSession =>
  authSessionSchema.parse({
    ...session,
    ...patch,
    updated_at: nowIso()
  });

const resolveLegacySession = (
  config: RuntimeConfig,
  legacy: z.infer<typeof legacyPendingAuthSchema>
): AuthSession => {
  const callback = resolveAuthCallbackMode(config);
  const status =
    Date.now() > new Date(legacy.expires_at).getTime() ? ("expired" as const) : ("pending_user_consent" as const);

  return authSessionSchema.parse({
    session_id: randomUUID(),
    oauth_state: legacy.state,
    consent_url: legacy.consent_url,
    created_at: legacy.created_at,
    updated_at: nowIso(),
    expires_at: legacy.expires_at,
    status,
    callback_mode: callback.mode,
    callback_url: callback.callbackUrl,
    ebay_env: legacy.ebay_env,
    client_id: legacy.client_id,
    scopes: legacy.scopes,
    token_file_path: tokenFilePath(config),
    last_error:
      status === "expired"
        ? authError("AUTH_SESSION_EXPIRED", "Sessione OAuth scaduta prima del completamento")
        : undefined
  });
};

const readStoredAuthSession = async (config: RuntimeConfig): Promise<AuthSession | null> => {
  try {
    const raw = await readFile(authSessionFilePath(config), "utf8");
    const json = JSON.parse(raw) as unknown;

    const current = authSessionSchema.safeParse(json);
    if (current.success) {
      return current.data;
    }

    const legacy = legacyPendingAuthSchema.safeParse(json);
    if (legacy.success) {
      const migrated = resolveLegacySession(config, legacy.data);
      await saveAuthSession(config, migrated);
      return migrated;
    }

    throw new Error(current.error.message);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw new SellbotError("AUTH_PENDING_INVALID", `Sessione OAuth locale non valida: ${(error as Error).message}`);
  }
};

const expireSessionIfNeeded = async (config: RuntimeConfig, session: AuthSession): Promise<AuthSession> => {
  if (session.status !== "pending_user_consent") {
    return session;
  }

  if (Date.now() <= new Date(session.expires_at).getTime()) {
    return session;
  }

  const expired = patchAuthSession(session, {
    status: "expired",
    last_error: authError("AUTH_SESSION_EXPIRED", "Sessione OAuth scaduta prima del completamento")
  });
  await saveAuthSession(config, expired);
  return expired;
};

const missingOAuthConfiguration = (config: RuntimeConfig): string[] => {
  const missing: string[] = [];

  if (!config.ebayClientId) {
    missing.push("EBAY_CLIENT_ID");
  }
  if (!config.ebayClientSecret) {
    missing.push("EBAY_CLIENT_SECRET");
  }
  if (!config.ebayRuname) {
    missing.push("EBAY_RUNAME");
  }

  return missing;
};

const sessionStateMatches = (session: AuthSession, state: string | null): boolean => {
  return Boolean(state) && state === session.oauth_state;
};

const oauthErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const oauthErrorCode = (error: unknown): string => {
  if (isSellbotError(error)) {
    return error.code;
  }

  return "OAUTH_ERROR";
};

const markSessionError = async (
  config: RuntimeConfig,
  session: AuthSession,
  code: string,
  message: string,
  patch?: Partial<AuthSession>
): Promise<AuthSession> => {
  const updated = patchAuthSession(session, {
    status: "error",
    ...patch,
    last_error: authError(code, message)
  });
  await saveAuthSession(config, updated);
  return updated;
};

const markSessionAuthenticated = async (
  config: RuntimeConfig,
  session: AuthSession,
  patch?: Partial<AuthSession>
): Promise<AuthSession> => {
  const updated = patchAuthSession(session, {
    status: "authenticated",
    completed_at: nowIso(),
    token_file_path: tokenFilePath(config),
    last_error: undefined,
    ...patch
  });
  await saveAuthSession(config, updated);
  return updated;
};

const buildStartResult = (
  session: AuthSession,
  config: RuntimeConfig,
  reused: boolean
): StartUserAuthResult => ({
  state: session.oauth_state,
  consentUrl: session.consent_url,
  expiresAt: session.expires_at,
  sessionFilePath: authSessionFilePath(config),
  authSessionId: session.session_id,
  callbackMode: session.callback_mode,
  callbackUrl: session.callback_url,
  legacyCompleteSupported: true,
  reused
});

export const resolveAuthCallbackMode = (
  config: RuntimeConfig
): { mode: AuthCallbackMode; callbackUrl?: string; callbackPath?: string } => {
  if (!config.ebayCallbackUrl) {
    return {
      mode: "manual"
    };
  }

  const callbackUrl = new URL(config.ebayCallbackUrl);
  return {
    mode: "automatic_http",
    callbackUrl: callbackUrl.toString(),
    callbackPath: normalizePathname(callbackUrl.pathname || "/")
  };
};

export const getConfiguredAuthCallbackPath = (config: RuntimeConfig): string | null => {
  return resolveAuthCallbackMode(config).callbackPath ?? null;
};

export const readAuthSession = async (config: RuntimeConfig): Promise<AuthSession | null> => {
  const session = await readStoredAuthSession(config);
  if (!session) {
    return null;
  }

  return expireSessionIfNeeded(config, session);
};

export const readPendingAuth = async (config: RuntimeConfig): Promise<PendingAuthSession | null> => {
  const session = await readAuthSession(config);
  return session?.status === "pending_user_consent" ? session : null;
};

export const clearPendingAuth = async (config: RuntimeConfig): Promise<void> => {
  try {
    await rm(authSessionFilePath(config), { force: true });
  } catch {
    // best effort
  }
};

export interface StartUserAuthResult {
  state: string;
  consentUrl: string;
  expiresAt: string;
  sessionFilePath: string;
  authSessionId: string;
  callbackMode: AuthCallbackMode;
  callbackUrl?: string;
  legacyCompleteSupported: boolean;
  reused: boolean;
}

export const startUserAuth = async (config: RuntimeConfig): Promise<StartUserAuthResult> => {
  requireOAuthConfig(config);
  const existing = await readAuthSession(config);
  const callback = resolveAuthCallbackMode(config);

  if (
    existing &&
    existing.status === "pending_user_consent" &&
    existing.callback_mode === callback.mode &&
    existing.callback_url === callback.callbackUrl
  ) {
    return buildStartResult(existing, config, true);
  }

  const oauthClient = createUserOAuthClient(config);
  const state = oauthClient.createState();
  const consentUrl = oauthClient.createConsentUrl(state);
  const now = Date.now();
  const expiresAt = new Date(now + PENDING_AUTH_TTL_MS).toISOString();

  const session = authSessionSchema.parse({
    session_id: randomUUID(),
    oauth_state: state,
    consent_url: consentUrl,
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    status: "pending_user_consent",
    callback_mode: callback.mode,
    callback_url: callback.callbackUrl,
    ebay_env: config.ebayEnv,
    client_id: config.ebayClientId ?? "unknown",
    scopes: config.ebayScopes,
    token_file_path: tokenFilePath(config)
  });

  await saveAuthSession(config, session);
  return buildStartResult(session, config, false);
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

  const receivedState = params.get("state");
  if (receivedState && receivedState !== expectedState) {
    throw new SellbotError("OAUTH_STATE", "State OAuth non valido");
  }

  const oauthError = params.get("error");
  if (oauthError) {
    throw new SellbotError(
      "OAUTH_DENIED",
      `${oauthError}: ${params.get("error_description") ?? "nessun dettaglio"}`
    );
  }

  const code = params.get("code");
  if (!code) {
    throw new SellbotError("OAUTH_CODE_MISSING", "Authorization code non trovato nell'input");
  }

  return code;
};

export interface CompleteUserAuthResult {
  tokenFilePath: string;
  authSessionId: string;
  completedAt?: string;
  alreadyCompleted: boolean;
  completionMode: "manual";
}

export const completeUserAuth = async (
  config: RuntimeConfig,
  rawRedirectUrlOrCode: string
): Promise<CompleteUserAuthResult> => {
  const session = await readAuthSession(config);
  if (!session) {
    throw new SellbotError(
      "AUTH_PENDING_MISSING",
      "Nessuna sessione OAuth pendente. Avvia prima auth_start o 'sellbot auth'."
    );
  }

  if (session.status === "authenticated") {
    return {
      tokenFilePath: tokenFilePath(config),
      authSessionId: session.session_id,
      completedAt: session.completed_at,
      alreadyCompleted: true,
      completionMode: "manual"
    };
  }

  if (session.status === "expired") {
    throw new SellbotError("AUTH_SESSION_EXPIRED", "Sessione OAuth scaduta. Avvia di nuovo sellbot_auth_start.");
  }

  if (session.status === "error") {
    throw new SellbotError(
      session.last_error?.code ?? "AUTH_SESSION_ERROR",
      session.last_error?.message ?? "Sessione OAuth in errore. Avvia di nuovo sellbot_auth_start."
    );
  }

  let code: string;
  try {
    code = parseAuthorizationCodeFromInput(rawRedirectUrlOrCode, session.oauth_state);
  } catch (error) {
    if (isSellbotError(error) && error.code === "OAUTH_DENIED") {
      await markSessionError(config, session, error.code, error.message);
    }
    throw error;
  }

  const oauthClient = createUserOAuthClient(config);

  try {
    const token = await oauthClient.exchangeAuthorizationCode(code);
    await saveToken(token, config);
  } catch (error) {
    await markSessionError(config, session, oauthErrorCode(error), oauthErrorMessage(error));
    throw error;
  }

  const completed = await markSessionAuthenticated(config, session);
  return {
    tokenFilePath: tokenFilePath(config),
    authSessionId: completed.session_id,
    completedAt: completed.completed_at,
    alreadyCompleted: false,
    completionMode: "manual"
  };
};

export interface HandleUserAuthCallbackResult {
  httpStatus: number;
  responseState: OAuthCallbackResponseState;
  authSessionId?: string;
}

export const handleUserAuthCallback = async (
  config: RuntimeConfig,
  callbackUrl: URL
): Promise<HandleUserAuthCallbackResult> => {
  const session = await readAuthSession(config);
  if (!session) {
    return {
      httpStatus: 410,
      responseState: "not_found"
    };
  }

  const receivedState = callbackUrl.searchParams.get("state");
  if (!sessionStateMatches(session, receivedState)) {
    return {
      httpStatus: 400,
      responseState: "invalid_state",
      authSessionId: session.session_id
    };
  }

  if (session.status === "authenticated") {
    return {
      httpStatus: 200,
      responseState: "already_authenticated",
      authSessionId: session.session_id
    };
  }

  if (session.status === "expired") {
    return {
      httpStatus: 410,
      responseState: "expired",
      authSessionId: session.session_id
    };
  }

  if (session.status === "error") {
    return {
      httpStatus: 409,
      responseState: "error",
      authSessionId: session.session_id
    };
  }

  const oauthErrorParam = callbackUrl.searchParams.get("error");
  if (oauthErrorParam) {
    await markSessionError(
      config,
      session,
      "OAUTH_DENIED",
      `${oauthErrorParam}: ${callbackUrl.searchParams.get("error_description") ?? "nessun dettaglio"}`,
      {
        callback_received_at: nowIso()
      }
    );

    return {
      httpStatus: 400,
      responseState: "error",
      authSessionId: session.session_id
    };
  }

  const code = callbackUrl.searchParams.get("code");
  if (!code) {
    await markSessionError(config, session, "OAUTH_CODE_MISSING", "Authorization code non presente nel callback", {
      callback_received_at: nowIso()
    });

    return {
      httpStatus: 400,
      responseState: "error",
      authSessionId: session.session_id
    };
  }

  const oauthClient = createUserOAuthClient(config);
  try {
    const token = await oauthClient.exchangeAuthorizationCode(code);
    await saveToken(token, config);
    const completed = await markSessionAuthenticated(config, session, {
      callback_received_at: nowIso()
    });

    return {
      httpStatus: 200,
      responseState: "authenticated",
      authSessionId: completed.session_id
    };
  } catch (error) {
    await markSessionError(config, session, oauthErrorCode(error), oauthErrorMessage(error), {
      callback_received_at: nowIso()
    });

    return {
      httpStatus: 500,
      responseState: "error",
      authSessionId: session.session_id
    };
  }
};

export interface AuthStatusResult {
  state: AuthMachineState;
  env: RuntimeConfig["ebayEnv"];
  clientId?: string;
  tokenFilePath: string;
  tokenPresent: boolean;
  tokenValid: boolean;
  tokenExpiresAt?: string;
  scopes?: string[];
  pendingAuth: PendingAuthSession | null;
  authSession: AuthSession | null;
  reason?: string;
  callbackMode: AuthCallbackMode;
  callbackUrl?: string;
  manualCompletionSupported: boolean;
  configured: boolean;
  missingConfiguration: string[];
  token: {
    filePath: string;
    present: boolean;
    status: "missing" | "valid" | "refresh_required" | "refresh_failed";
    expiresAt?: string;
    refreshTokenPresent: boolean;
    refreshTokenExpiresAt?: string;
    scopes: string[];
    lastRefreshError?: z.infer<typeof tokenRefreshErrorSchema>;
  };
}

export const getUserAuthStatus = async (config: RuntimeConfig): Promise<AuthStatusResult> => {
  const callback = resolveAuthCallbackMode(config);
  const authSession = await readAuthSession(config);
  const pendingAuth = authSession?.status === "pending_user_consent" ? authSession : null;
  const token = await readToken(config);
  const missingConfiguration = missingOAuthConfiguration(config);
  const tokenScopes = token?.scope?.split(/\s+/).filter(Boolean) ?? [];
  const tokenRefreshError = token?.last_refresh_error_message
    ? tokenRefreshErrorSchema.parse({
        code: token.last_refresh_error_code,
        message: token.last_refresh_error_message,
        at: token.last_refresh_attempt_at
      })
    : undefined;
  const tokenValid = token ? Date.now() + 60 * 1000 < new Date(token.expires_at).getTime() : false;
  const tokenStatus: AuthStatusResult["token"]["status"] = !token
    ? "missing"
    : tokenValid
      ? "valid"
      : tokenRefreshError
        ? "refresh_failed"
        : "refresh_required";

  let state: AuthMachineState;
  let reason: string | undefined;

  if (missingConfiguration.length > 0) {
    state = "not_configured";
    reason = `Configurazione OAuth incompleta: ${missingConfiguration.join(", ")}`;
  } else if (tokenStatus === "valid") {
    state = "authenticated";
  } else if (pendingAuth) {
    state = "pending_user_consent";
    reason = "Attesa completamento consenso utente via browser";
  } else if (tokenStatus === "refresh_failed" || authSession?.status === "error") {
    state = "error";
    reason = tokenRefreshError?.message ?? authSession?.last_error?.message;
  } else if (tokenStatus === "refresh_required" || authSession?.status === "expired") {
    state = "expired";
    reason =
      tokenStatus === "refresh_required"
        ? token?.refresh_token
          ? "Access token scaduto; al prossimo tool protetto verra' tentato il refresh"
          : "Access token scaduto e refresh token assente; serve una nuova autorizzazione"
        : authSession?.last_error?.message;
  } else {
    state = "not_authenticated";
    reason = "Token utente non trovato";
  }

  return {
    state,
    env: config.ebayEnv,
    clientId: config.ebayClientId,
    tokenFilePath: tokenFilePath(config),
    tokenPresent: Boolean(token),
    tokenValid,
    tokenExpiresAt: token?.expires_at,
    scopes: tokenScopes,
    pendingAuth,
    authSession,
    reason,
    callbackMode: callback.mode,
    callbackUrl: callback.callbackUrl,
    manualCompletionSupported: true,
    configured: missingConfiguration.length === 0,
    missingConfiguration,
    token: {
      filePath: tokenFilePath(config),
      present: Boolean(token),
      status: tokenStatus,
      expiresAt: token?.expires_at,
      refreshTokenPresent: Boolean(token?.refresh_token),
      refreshTokenExpiresAt: token?.refresh_token_expires_at,
      scopes: tokenScopes,
      lastRefreshError: tokenRefreshError
    }
  };
};
