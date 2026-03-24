import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("Tool result senza contenuto testuale");
  }

  return JSON.parse(text.text).data as T;
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

      const started = parseToolPayload<{
        state: string;
        consentUrl: string;
        authSessionId: string;
        callbackMode: string;
      }>(
        await client.callTool({
          name: "sellbot_auth_start"
        })
      );
      expect(started.consentUrl).toContain("redirect_uri=prod-runame");
      expect(started.callbackMode).toBe("automatic_http");

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
});
