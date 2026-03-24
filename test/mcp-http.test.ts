import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RunningMcpHttpServer } from "../src/mcp/http-server.js";
import { startMcpHttpServer } from "../src/mcp/http-server.js";

const runningServers: RunningMcpHttpServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.map((server) => server.close()));
  runningServers.length = 0;
});

describe("mcp http server", () => {
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
});
