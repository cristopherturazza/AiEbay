import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { URL } from "node:url";
import { loadRuntimeConfig, requireOAuthConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import { completeUserAuth, startUserAuth } from "../services/auth-flow.js";
import { tokenFilePath } from "../token/token-store.js";
import { openInBrowser } from "../utils/browser.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const parseCallbackUrl = (callbackUrl: string): URL => {
  try {
    return new URL(callbackUrl);
  } catch (error) {
    throw new SellbotError(
      "CALLBACK_URL_INVALID",
      `EBAY_CALLBACK_URL non valido: ${(error as Error).message}`
    );
  }
};

const canUseLocalHttpCallback = (callbackUrl: URL): boolean => {
  return callbackUrl.protocol === "http:" && LOCAL_HOSTS.has(callbackUrl.hostname);
};

const openConsentUrl = async (consentUrl: string): Promise<void> => {
  logger.info(`Apri questo URL per autorizzare sellbot: ${consentUrl}`);

  try {
    await openInBrowser(consentUrl);
    logger.info("Browser aperto sulla pagina di autorizzazione eBay");
  } catch (error) {
    logger.warn(
      `Impossibile aprire il browser automaticamente: ${(error as Error).message}. Apri manualmente: ${consentUrl}`
    );
  }
};

const readAuthorizationCodeManually = async (state: string): Promise<string> => {
  if (!input.isTTY) {
    throw new SellbotError(
      "OAUTH_CODE_MISSING",
      "Callback OAuth automatico non disponibile e stdin non interattivo"
    );
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Incolla l'URL finale di redirect (oppure solo il valore del parametro code): "
    );
    void state;
    return answer.trim();
  } finally {
    rl.close();
  }
};

const waitForLocalCallbackCode = async (
  consentUrl: string,
  state: string,
  callbackUrl: URL,
  fallbackPort: number
): Promise<string> => {
  const listenPort = callbackUrl.port ? Number.parseInt(callbackUrl.port, 10) : fallbackPort;
  const callbackPath = callbackUrl.pathname || "/";

  return new Promise<string>((resolve, reject) => {
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

      const oauthError = requestUrl.searchParams.get("error");
      const errorDescription = requestUrl.searchParams.get("error_description");
      if (oauthError) {
        res.statusCode = 400;
        res.end(`OAuth error: ${oauthError}`);
        server.close();
        finish(() =>
          reject(new SellbotError("OAUTH_DENIED", `${oauthError}: ${errorDescription ?? "nessun dettaglio"}`))
        );
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

    server.listen(listenPort, callbackUrl.hostname, async () => {
      logger.info(`Server callback attivo su ${callbackUrl.hostname}:${listenPort}${callbackPath}`);
      await openConsentUrl(consentUrl);
    });

    timeoutId = setTimeout(() => {
      server.close();
      finish(() => reject(new SellbotError("OAUTH_TIMEOUT", "Timeout callback OAuth (5 minuti)")));
    }, CALLBACK_TIMEOUT_MS);
  });
};

export const runAuth = async (): Promise<void> => {
  const config = await loadRuntimeConfig();
  const oauthConfig = requireOAuthConfig(config);
  const { state, consentUrl } = await startUserAuth(config);
  const parsedCallback = oauthConfig.callbackUrl ? parseCallbackUrl(oauthConfig.callbackUrl) : undefined;

  const code =
    parsedCallback && canUseLocalHttpCallback(parsedCallback)
      ? await waitForLocalCallbackCode(consentUrl, state, parsedCallback, config.sellbotPort)
      : await (async (): Promise<string> => {
          if (parsedCallback) {
            logger.warn(
              `EBAY_CALLBACK_URL=${parsedCallback.toString()} non e' un callback locale HTTP. Uso acquisizione manuale del code.`
            );
          } else {
            logger.info("EBAY_CALLBACK_URL non configurato: uso acquisizione manuale del code.");
          }

          await openConsentUrl(consentUrl);
          logger.info("Dopo il login eBay, copia l'URL finale di redirect e incollalo nel terminale.");
          return readAuthorizationCodeManually(state);
        })();

  await completeUserAuth(config, code);
  logger.info(`Autenticazione completata: token salvato in ${tokenFilePath(config)}`);
};
