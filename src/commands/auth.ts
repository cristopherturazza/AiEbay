import { createServer } from "node:http";
import { URL } from "node:url";
import { loadRuntimeConfig, requireOAuthConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import { createUserOAuthClient } from "../ebay/oauth-client-factory.js";
import { saveToken } from "../token/token-store.js";
import { openInBrowser } from "../utils/browser.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const assertLocalRedirectUri = (redirectUri: string): URL => {
  const parsed = new URL(redirectUri);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);

  if (!localHosts.has(parsed.hostname)) {
    throw new SellbotError(
      "REDIRECT_NOT_LOCAL",
      `EBAY_REDIRECT_URI deve puntare a localhost per il callback locale. Valore ricevuto: ${redirectUri}`
    );
  }

  return parsed;
};

export const runAuth = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  const oauthConfig = requireOAuthConfig(config);
  const redirectUrl = assertLocalRedirectUri(oauthConfig.redirectUri);

  const oauthClient = createUserOAuthClient(config);

  const state = oauthClient.createState();
  const consentUrl = oauthClient.createConsentUrl(state);

  const listenPort = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : config.sellbotPort;
  const callbackPath = redirectUrl.pathname || "/";

  const code = await new Promise<string>((resolve, reject) => {
    let timeoutId: NodeJS.Timeout;
    let settled = false;
    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      handler();
    };

    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (requestUrl.pathname !== callbackPath) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");
      if (error) {
        res.statusCode = 400;
        res.end(`OAuth error: ${error}`);
        server.close();
        finish(() => reject(new SellbotError("OAUTH_DENIED", `${error}: ${errorDescription ?? "nessun dettaglio"}`)));
        return;
      }

      const receivedState = requestUrl.searchParams.get("state");
      if (receivedState !== state) {
        res.statusCode = 400;
        res.end("Invalid state");
        server.close();
        finish(() => reject(new SellbotError("OAUTH_STATE", "State OAuth non valido")));
        return;
      }

      const receivedCode = requestUrl.searchParams.get("code");
      if (!receivedCode) {
        res.statusCode = 400;
        res.end("Missing code");
        server.close();
        finish(() => reject(new SellbotError("OAUTH_CODE_MISSING", "Authorization code non presente nel callback")));
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<h2>sellbot auth completata</h2><p>Puoi chiudere questa finestra.</p>");
      server.close();
      finish(() => resolve(receivedCode));
    });

    server.listen(listenPort, redirectUrl.hostname, async () => {
      logger.info(`Server callback attivo su ${redirectUrl.hostname}:${listenPort}${callbackPath}`);

      try {
        await openInBrowser(consentUrl);
        logger.info("Browser aperto sulla pagina di autorizzazione eBay");
      } catch (error) {
        logger.warn(
          `Impossibile aprire il browser automaticamente: ${(error as Error).message}. Apri manualmente: ${consentUrl}`
        );
      }
    });

    timeoutId = setTimeout(() => {
      server.close();
      finish(() => reject(new SellbotError("OAUTH_TIMEOUT", "Timeout callback OAuth (5 minuti)")));
    }, CALLBACK_TIMEOUT_MS);
  });

  const token = await oauthClient.exchangeAuthorizationCode(code);
  await saveToken(token);

  logger.info("Autenticazione completata: token salvato in ~/.sellbot/ebay-token.json");
};
