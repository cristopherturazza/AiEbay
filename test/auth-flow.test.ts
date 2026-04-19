import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config.js";
import { defaultEbayBaseUrls } from "../src/ebay/urls.js";
import { EbayOAuthClient } from "../src/ebay/oauth.js";
import { SellbotError } from "../src/errors.js";
import {
  completeUserAuth,
  getUserAuthStatus,
  handleUserAuthCallback,
  parseAuthorizationCodeFromInput,
  readAuthSession,
  startUserAuth
} from "../src/services/auth-flow.js";
import { readToken } from "../src/token/token-store.js";

const temporaryDirs: string[] = [];
const originalHome = process.env.HOME;

const makeConfig = (overrides?: Partial<RuntimeConfig>): RuntimeConfig => {
  const defaults = defaultEbayBaseUrls("prod");

  return {
    cwd: "/tmp/sellbot",
    ebayEnv: "prod",
    ebayClientId: "prod-client",
    ebayClientSecret: "prod-secret",
    ebayRuname: "prod-runame",
    ebayCallbackUrl: "https://sellbot.example.com/auth/ebay/callback",
    ebayScopes: [
      "https://api.ebay.com/oauth/api_scope/sell.inventory",
      "https://api.ebay.com/oauth/api_scope/sell.account.readonly"
    ],
    ebayMarketplaceId: "EBAY_IT",
    sellbotPort: 3000,
    ebayAuthBaseUrl: defaults.authBaseUrl,
    ebayApiBaseUrl: defaults.apiBaseUrl,
    ebayMediaBaseUrl: defaults.mediaBaseUrl,
    locale: "it-IT",
    policies: {},
    ollama: {
      baseUrl: "http://127.0.0.1:11434",
      visionModel: "gemma4:e4b",
      visionKeepAlive: "60s",
      visionTimeoutMs: 120_000
    },
    ...overrides
  };
};

const installTempHome = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sellbot-auth-home-"));
  temporaryDirs.push(dir);
  process.env.HOME = dir;
  return dir;
};

const mockTokenExchange = () =>
  vi.spyOn(EbayOAuthClient.prototype, "exchangeAuthorizationCode").mockResolvedValue({
    access_token: "access-token",
    token_type: "Bearer",
    expires_in: 7200,
    refresh_token: "refresh-token",
    refresh_token_expires_in: 86400,
    scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account.readonly"
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryDirs.length = 0;

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

describe.sequential("auth-flow", () => {
  it("estrae il code da un redirect URL e valida lo state", () => {
    const code = parseAuthorizationCodeFromInput(
      "https://auth2.ebay.com/oauth2/ThirdPartyAuthSucessFailure?state=abc123&code=test-code",
      "abc123"
    );

    expect(code).toBe("test-code");
  });

  it("accetta il code raw", () => {
    expect(parseAuthorizationCodeFromInput("raw-code-value", "ignored-state")).toBe("raw-code-value");
  });

  it("fallisce se lo state non combacia", () => {
    expect(() =>
      parseAuthorizationCodeFromInput("https://example.com/callback?state=wrong&code=test-code", "expected")
    ).toThrowError(SellbotError);
  });

  it("espone stato machine-friendly prima e durante il consenso", async () => {
    await installTempHome();
    const config = makeConfig();

    const initial = await getUserAuthStatus(config);
    expect(initial.state).toBe("not_authenticated");
    expect(initial.callbackMode).toBe("automatic_http");
    expect(initial.token.status).toBe("missing");
    expect(initial.pendingAuth).toBeNull();

    const started = await startUserAuth(config);
    expect(started.consentUrl).toContain("redirect_uri=prod-runame");
    expect(started.callbackMode).toBe("automatic_http");
    expect(started.callbackUrl).toBe("https://sellbot.example.com/auth/ebay/callback");
    expect(started.authSessionId).toBeTruthy();

    const pending = await getUserAuthStatus(config);
    expect(pending.state).toBe("pending_user_consent");
    expect(pending.pendingAuth?.session_id).toBe(started.authSessionId);
    expect(pending.authSession?.status).toBe("pending_user_consent");
  });

  it("completa il callback automatico con state valido e salva il token", async () => {
    await installTempHome();
    const config = makeConfig();
    const started = await startUserAuth(config);
    mockTokenExchange();

    const result = await handleUserAuthCallback(
      config,
      new URL(`${config.ebayCallbackUrl}?state=${started.state}&code=test-code`)
    );

    expect(result).toMatchObject({
      httpStatus: 200,
      responseState: "authenticated",
      authSessionId: started.authSessionId
    });

    const session = await readAuthSession(config);
    expect(session?.status).toBe("authenticated");
    expect(session?.completed_at).toBeTruthy();

    const token = await readToken(config);
    expect(token?.access_token).toBe("access-token");

    const status = await getUserAuthStatus(config);
    expect(status.state).toBe("authenticated");
    expect(status.token.status).toBe("valid");
    expect(status.pendingAuth).toBeNull();
  });

  it("rifiuta callback con state invalido senza consumare la sessione", async () => {
    await installTempHome();
    const config = makeConfig();
    await startUserAuth(config);
    const exchangeSpy = vi.spyOn(EbayOAuthClient.prototype, "exchangeAuthorizationCode");

    const result = await handleUserAuthCallback(
      config,
      new URL(`${config.ebayCallbackUrl}?state=wrong-state&code=test-code`)
    );

    expect(result.httpStatus).toBe(400);
    expect(result.responseState).toBe("invalid_state");
    expect(exchangeSpy).not.toHaveBeenCalled();

    const session = await readAuthSession(config);
    expect(session?.status).toBe("pending_user_consent");

    const status = await getUserAuthStatus(config);
    expect(status.state).toBe("pending_user_consent");
  });

  it("persiste l'errore ricevuto da eBay nel callback", async () => {
    await installTempHome();
    const config = makeConfig();
    const started = await startUserAuth(config);

    const result = await handleUserAuthCallback(
      config,
      new URL(`${config.ebayCallbackUrl}?state=${started.state}&error=access_denied&error_description=user_cancelled`)
    );

    expect(result.httpStatus).toBe(400);
    expect(result.responseState).toBe("error");

    const session = await readAuthSession(config);
    expect(session?.status).toBe("error");
    expect(session?.last_error?.code).toBe("OAUTH_DENIED");

    const status = await getUserAuthStatus(config);
    expect(status.state).toBe("error");
    expect(status.authSession?.last_error?.code).toBe("OAUTH_DENIED");
  });

  it("mantiene funzionante il fallback manuale con redirect URL o code", async () => {
    await installTempHome();
    const config = makeConfig({
      ebayCallbackUrl: undefined
    });
    const started = await startUserAuth(config);
    mockTokenExchange();

    const result = await completeUserAuth(
      config,
      `https://example.com/final?state=${started.state}&code=manual-code`
    );

    expect(result.tokenFilePath).toContain("ebay-token.prod.prod-client.json");
    expect(result.alreadyCompleted).toBe(false);
    expect(result.authSessionId).toBe(started.authSessionId);

    const status = await getUserAuthStatus(config);
    expect(status.state).toBe("authenticated");
    expect(status.callbackMode).toBe("manual");
  });
});
