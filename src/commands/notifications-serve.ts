import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { loadRuntimeConfig, requireNotificationConfig } from "../config.js";
import { SellbotError } from "../errors.js";
import { logger } from "../logger.js";
import {
  computeChallengeResponse,
  parseNotificationEndpointUrl,
  summarizeNotificationPayload
} from "../notifications/ebay-account-deletion.js";

interface NotificationsServeOptions {
  host?: string;
  port?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

const parseListenPort = (value: string | undefined): number => {
  if (!value) {
    return 8080;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new SellbotError("NOTIFICATION_PORT_INVALID", `Porta non valida: ${value}`);
  }

  return parsed;
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new SellbotError(
        "NOTIFICATION_BODY_TOO_LARGE",
        `Body notifica oltre limite ${MAX_BODY_BYTES} bytes`
      );
    }

    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8").trim();
  if (!rawBody) {
    return null;
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new SellbotError(
      "NOTIFICATION_BODY_INVALID",
      `Body JSON non valido: ${(error as Error).message}`
    );
  }
};

export const runNotificationsServe = async (options: NotificationsServeOptions): Promise<void> => {
  const config = await loadRuntimeConfig();
  const notificationConfig = requireNotificationConfig(config);
  const endpointUrl = parseNotificationEndpointUrl(notificationConfig.endpointUrl);
  const listenHost = options.host?.trim() || "127.0.0.1";
  const listenPort = parseListenPort(options.port);
  const endpointPath = endpointUrl.pathname || "/";

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const incomingUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

        if (incomingUrl.pathname !== endpointPath) {
          response.statusCode = 404;
          response.end("Not Found");
          return;
        }

        if (request.method === "GET") {
          const challengeCode = incomingUrl.searchParams.get("challenge_code");
          if (!challengeCode) {
            response.statusCode = 400;
            response.end("Missing challenge_code");
            return;
          }

          const challengeResponse = computeChallengeResponse(
            challengeCode,
            notificationConfig.verificationToken,
            endpointUrl.toString()
          );

          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ challengeResponse }));
          logger.info(`Challenge eBay servito per path=${endpointPath}`);
          return;
        }

        if (request.method === "POST") {
          const payload = await readJsonBody(request);
          const summary = summarizeNotificationPayload(payload);

          response.statusCode = 204;
          response.end();
          logger.info(
            `Notifica eBay ricevuta topic=${summary.topic ?? "unknown"} notificationId=${summary.notificationId ?? "unknown"} publishDate=${summary.publishDate ?? "unknown"}`
          );
          return;
        }

        response.statusCode = 405;
        response.setHeader("Allow", "GET, POST");
        response.end("Method Not Allowed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        response.statusCode = 400;
        response.end(message);
        logger.warn(`Errore endpoint notifiche eBay: ${message}`);
      }
    });

    server.on("error", (error) => reject(error));
    server.listen(listenPort, listenHost, () => {
      const address = server.address() as AddressInfo | null;
      logger.info(
        `Endpoint notifiche eBay in ascolto su http://${listenHost}:${address?.port ?? listenPort}${endpointPath}`
      );
      logger.info(`Endpoint pubblico configurato: ${endpointUrl.toString()}`);
      logger.info("Pronto per tunnel pubblico HTTPS e validazione eBay");
      resolve();
    });
  });

  await new Promise<void>(() => {
    // Keep the process alive until terminated by the operator.
  });
};
