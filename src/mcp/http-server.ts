#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadRuntimeConfig } from "../config.js";
import { logger } from "../logger.js";
import { createSellbotMcpServer } from "./server.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 1024 * 1024;

type SessionEntry = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  closing: boolean;
};

export interface McpHttpServerOptions {
  host?: string;
  port?: number;
}

export interface RunningMcpHttpServer {
  host: string;
  port: number;
  origin: string;
  mcpUrl: string;
  close: () => Promise<void>;
}

const setCommonHeaders = (res: ServerResponse): void => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
};

const sendPlain = (res: ServerResponse, statusCode: number, body: string): void => {
  setCommonHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
};

const sendJson = (res: ServerResponse, statusCode: number, payload: unknown): void => {
  setCommonHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
};

const sendJsonRpcError = (res: ServerResponse, statusCode: number, message: string): void => {
  sendJson(res, statusCode, {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  });
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Payload troppo grande (max ${MAX_BODY_BYTES} bytes)`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw);
};

const sessionIdFromHeader = (req: IncomingMessage): string | undefined => {
  const raw = req.headers["mcp-session-id"];
  if (Array.isArray(raw)) {
    return raw[0];
  }

  return raw;
};

const closeSession = async (sessionId: string, sessions: Map<string, SessionEntry>): Promise<void> => {
  const entry = sessions.get(sessionId);
  if (!entry) {
    return;
  }

  entry.closing = true;
  sessions.delete(sessionId);
  await entry.server.close();
};

const createSessionEntry = async (sessions: Map<string, SessionEntry>): Promise<SessionEntry> => {
  const server = createSellbotMcpServer();
  let entry: SessionEntry;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, entry);
    }
  });

  entry = { server, transport, closing: false };

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (!sessionId) {
      return;
    }

    sessions.delete(sessionId);
    if (entry.closing) {
      return;
    }

    entry.closing = true;
    void server.close().catch((error) => {
      logger.error(
        `Errore chiusura sessione MCP ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  };

  transport.onerror = (error) => {
    logger.error(`Errore transport MCP HTTP: ${error.message}`);
  };

  await server.connect(transport);
  return entry;
};

export const startMcpHttpServer = async (options: McpHttpServerOptions = {}): Promise<RunningMcpHttpServer> => {
  const config = await loadRuntimeConfig();
  const host = options.host?.trim() || "127.0.0.1";
  const port = options.port ?? config.sellbotPort;
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer(async (req, res) => {
    setCommonHeaders(res);

    if (!req.url) {
      sendPlain(res, 400, "Missing URL");
      return;
    }

    const requestUrl = new URL(req.url, `http://${req.headers.host ?? `${host}:${port}`}`);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === "GET" && requestUrl.pathname === HEALTH_PATH) {
      sendJson(res, 200, {
        ok: true,
        transport: "streamable-http",
        env: config.ebayEnv,
        active_sessions: sessions.size
      });
      return;
    }

    if (requestUrl.pathname !== MCP_PATH) {
      sendPlain(res, 404, "Not Found");
      return;
    }

    try {
      if (req.method === "POST") {
        const parsedBody = await readJsonBody(req);
        const sessionId = sessionIdFromHeader(req);

        let entry: SessionEntry | undefined;
        if (sessionId) {
          entry = sessions.get(sessionId);
          if (!entry) {
            sendJsonRpcError(res, 404, "Sessione MCP non trovata");
            return;
          }
        } else if (isInitializeRequest(parsedBody)) {
          entry = await createSessionEntry(sessions);
        } else {
          sendJsonRpcError(res, 400, "Bad Request: No valid session ID provided");
          return;
        }

        await entry.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET") {
        const sessionId = sessionIdFromHeader(req);
        if (!sessionId) {
          sendJsonRpcError(res, 400, "Missing MCP session ID");
          return;
        }

        const entry = sessions.get(sessionId);
        if (!entry) {
          sendJsonRpcError(res, 404, "Sessione MCP non trovata");
          return;
        }

        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        const sessionId = sessionIdFromHeader(req);
        if (!sessionId) {
          sendJsonRpcError(res, 400, "Missing MCP session ID");
          return;
        }

        const entry = sessions.get(sessionId);
        if (!entry) {
          sendJsonRpcError(res, 404, "Sessione MCP non trovata");
          return;
        }

        await entry.transport.handleRequest(req, res);
        return;
      }

      sendPlain(res, 405, "Method Not Allowed");
    } catch (error) {
      logger.error(`Errore MCP HTTP: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, "Internal server error");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off("listening", onListening);
      reject(error);
    };

    const onListening = (): void => {
      httpServer.off("error", onError);
      resolve();
    };

    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  const address = httpServer.address() as AddressInfo;
  const resolvedHost = address.address;
  const resolvedPort = address.port;
  const origin = `http://${resolvedHost}:${resolvedPort}`;

  return {
    host: resolvedHost,
    port: resolvedPort,
    origin,
    mcpUrl: `${origin}${MCP_PATH}`,
    close: async () => {
      await Promise.allSettled([...sessions.keys()].map((sessionId) => closeSession(sessionId, sessions)));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
};

export const runMcpHttpServer = async (options: McpHttpServerOptions = {}): Promise<void> => {
  const server = await startMcpHttpServer(options);
  logger.info(`sellbot MCP Streamable HTTP pronto su ${server.mcpUrl}`);
  logger.info(`health: ${server.origin}${HEALTH_PATH}`);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpHttpServer().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
