import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EbayOAuthClient } from "../src/ebay/oauth.js";
import type { RunningMcpHttpServer } from "../src/mcp/http-server.js";
import { startMcpHttpServer } from "../src/mcp/http-server.js";

const runningServers: RunningMcpHttpServer[] = [];
const temporaryRoots: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const ENV_KEYS = [
  "EBAY_ENV",
  "EBAY_CLIENT_ID",
  "EBAY_CLIENT_SECRET",
  "EBAY_RUNAME",
  "EBAY_CALLBACK_URL",
  "EBAY_SCOPES",
  "EBAY_MARKETPLACE_ID",
  "SELLBOT_PORT",
  "SELLBOT_ENV_FILE",
  "SELLBOT_CONFIG_FILE"
] as const;
const environmentSnapshot = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
  await Promise.all(runningServers.map((server) => server.close()));
  runningServers.length = 0;
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
  temporaryRoots.length = 0;
  vi.restoreAllMocks();
  process.chdir(originalCwd);

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  for (const key of ENV_KEYS) {
    const value = environmentSnapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const parseToolPayload = <T>(result: Awaited<ReturnType<Client["callTool"]>>): T => {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    const sc = result.structuredContent as { data?: unknown };
    if (sc.data !== undefined) {
      return sc.data as T;
    }
  }

  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.find((entry) => entry.type === "text");
  if (!text || typeof text.text !== "string") {
    throw new Error("Tool result senza contenuto testuale");
  }

  return JSON.parse(text.text).data as T;
};

const toolResultText = (result: Awaited<ReturnType<Client["callTool"]>>): string => {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const entry = content?.find((item) => item.type === "text");
  if (!entry || typeof entry.text !== "string") {
    throw new Error("Tool result senza contenuto testuale");
  }
  return entry.text;
};

describe.sequential("mcp http server", () => {
  it("espone health e tool list via Streamable HTTP", async () => {
    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return null;
      }

      throw error;
    });

    if (!server) {
      return;
    }

    runningServers.push(server);

    const health = await fetch(`${server.origin}/healthz`);
    const healthJson = await health.json();

    expect(health.ok).toBe(true);
    expect(healthJson).toMatchObject({
      ok: true,
      transport: "streamable-http"
    });

    const client = new Client({ name: "sellbot-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

    try {
      await client.connect(transport);
      const tools = await client.listTools();

      expect(tools.tools.some((tool) => tool.name === "sellbot_listing_patch_draft")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "sellbot_listing_prepare_for_publish")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "sellbot_remote_listings_list")).toBe(true);
      expect(transport.sessionId).toBeTruthy();

      await transport.terminateSession();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("espone anche il transport SSE legacy su /sse + /messages", async () => {
    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return null;
      }

      throw error;
    });

    if (!server) {
      return;
    }

    runningServers.push(server);

    const health = await fetch(`${server.origin}/healthz`);
    const healthJson = (await health.json()) as { transports?: string[] };
    expect(healthJson.transports).toContain("sse-legacy");

    const client = new Client({ name: "sellbot-sse-test-client", version: "0.1.0" });
    const transport = new SSEClientTransport(new URL(server.sseUrl));

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "sellbot_auth_status")).toBe(true);
      expect(tools.tools.some((tool) => tool.name === "sellbot_book_identify_from_photo")).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("risponde 400 sui POST /messages senza sessionId valido", async () => {
    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return null;
      }

      throw error;
    });

    if (!server) {
      return;
    }

    runningServers.push(server);

    const missing = await fetch(`${server.origin}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(missing.status).toBe(400);

    const unknown = await fetch(`${server.origin}/messages?sessionId=does-not-exist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    expect(unknown.status).toBe(404);
  });

  it("completa l'auth eBay via callback HTTP pubblico senza copy-paste", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-mcp-http-auth-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "sellbot-mcp-http-home-"));
    temporaryRoots.push(root, home);
    process.env.HOME = home;
    process.chdir(root);
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    await writeFile(path.join(root, ".env"), "EBAY_ENV=prod\n");
    await writeFile(
      path.join(root, ".env.prod"),
      [
        "EBAY_CLIENT_ID=prod-client",
        "EBAY_CLIENT_SECRET=prod-secret",
        "EBAY_RUNAME=prod-runame",
        "EBAY_CALLBACK_URL=https://public.example.com/auth/ebay/callback"
      ].join("\n")
    );

    vi.spyOn(EbayOAuthClient.prototype, "exchangeAuthorizationCode").mockResolvedValue({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 7200,
      refresh_token: "refresh-token",
      refresh_token_expires_in: 86400,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account.readonly"
    });

    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return null;
      }

      throw error;
    });

    if (!server) {
      return;
    }

    runningServers.push(server);

    const client = new Client({ name: "sellbot-auth-http-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

    try {
      await client.connect(transport);

      const initialStatus = parseToolPayload<{ state: string; token: { status: string } }>(
        await client.callTool({
          name: "sellbot_auth_status"
        })
      );
      expect(initialStatus.state).toBe("not_authenticated");
      expect(initialStatus.token.status).toBe("missing");

      const startedResult = await client.callTool({
        name: "sellbot_auth_start"
      });
      const started = parseToolPayload<{
        state: string;
        consentUrl: string;
        authSessionId: string;
        callbackMode: string;
      }>(startedResult);
      expect(started.consentUrl).toContain("redirect_uri=prod-runame");
      expect(started.callbackMode).toBe("automatic_http");

      const startedText = toolResultText(startedResult);
      expect(startedText).toContain(started.consentUrl);
      expect(startedText).toMatch(/https:\/\/auth\.(sandbox\.)?ebay\.com\/oauth2\/authorize\?/);
      expect(startedText.split("\n")).toContain(started.consentUrl);

      const pendingStatus = parseToolPayload<{ state: string; authSession: { session_id: string; status: string } }>(
        await client.callTool({
          name: "sellbot_auth_status"
        })
      );
      expect(pendingStatus.state).toBe("pending_user_consent");
      expect(pendingStatus.authSession.session_id).toBe(started.authSessionId);
      expect(pendingStatus.authSession.status).toBe("pending_user_consent");

      const callback = await fetch(`${server.origin}/auth/ebay/callback?state=${started.state}&code=test-code`);
      expect(callback.status).toBe(200);
      expect(await callback.text()).toContain("Autorizzazione completata");

      const finalStatus = parseToolPayload<{ state: string; token: { status: string } }>(
        await client.callTool({
          name: "sellbot_auth_status"
        })
      );
      expect(finalStatus.state).toBe("authenticated");
      expect(finalStatus.token.status).toBe("valid");

      await transport.terminateSession();
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("sellbot_auth_complete espone esito leggibile e scope/expiry in testo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sellbot-mcp-auth-complete-"));
    const home = await mkdtemp(path.join(os.tmpdir(), "sellbot-mcp-auth-complete-home-"));
    temporaryRoots.push(root, home);
    process.env.HOME = home;
    process.chdir(root);
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }

    await writeFile(path.join(root, ".env"), "EBAY_ENV=prod\n");
    await writeFile(
      path.join(root, ".env.prod"),
      [
        "EBAY_CLIENT_ID=prod-client",
        "EBAY_CLIENT_SECRET=prod-secret",
        "EBAY_RUNAME=prod-runame"
      ].join("\n")
    );

    vi.spyOn(EbayOAuthClient.prototype, "exchangeAuthorizationCode").mockResolvedValue({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 7200,
      refresh_token: "refresh-token",
      refresh_token_expires_in: 86400,
      scope: "https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account.readonly"
    });

    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return null;
      }

      throw error;
    });

    if (!server) {
      return;
    }

    runningServers.push(server);

    const client = new Client({ name: "sellbot-auth-complete-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl));

    try {
      await client.connect(transport);

      const startedResult = await client.callTool({ name: "sellbot_auth_start" });
      const started = parseToolPayload<{ state: string; consentUrl: string }>(startedResult);
      const startedText = toolResultText(startedResult);
      expect(startedText).toContain(started.consentUrl);

      const completed = await client.callTool({
        name: "sellbot_auth_complete",
        arguments: {
          redirect_url: `https://example.com/final?state=${started.state}&code=manual-code`
        }
      });

      const completedText = toolResultText(completed);
      expect(completedText).toContain("Autenticazione eBay completata");
      expect(completedText).toContain("scope: ");
      expect(completedText).toContain("sell.inventory");
      expect(completedText).toMatch(/tokenExpiresAt: \d{4}-\d{2}-\d{2}T/);

      const completedData = parseToolPayload<{
        alreadyCompleted: boolean;
        token: { scope: string; expires_at: string } | null;
      }>(completed);
      expect(completedData.alreadyCompleted).toBe(false);
      expect(completedData.token?.scope).toContain("sell.inventory");
      expect(completedData.token?.expires_at).toBeTruthy();

      await transport.terminateSession();
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
