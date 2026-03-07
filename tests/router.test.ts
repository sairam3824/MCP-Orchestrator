import { describe, expect, it } from "vitest";
import { LoadBalancer } from "../src/balancer.js";
import { Monitor } from "../src/monitor.js";
import { ToolRouter } from "../src/router.js";
import type { McpTool, ServerRuntime } from "../src/types.js";

function makeServer(
  id: string,
  name: string,
  tools: McpTool[],
  impl: (tool: string) => Promise<Record<string, unknown>>
): ServerRuntime {
  return {
    id,
    name,
    description: name,
    priority: "normal",
    healthy: true,
    activeRequests: 0,
    startedAt: Date.now(),
    healthCheckIntervalMs: 30_000,
    timeoutMs: 100,
    allowTools: new Set<string>(),
    denyTools: new Set<string>(),
    rateLimits: {},
    lastError: undefined,
    listTools: async () => tools,
    callTool: async (toolName) => await impl(toolName),
    probe: async () => {},
    shutdown: async () => {}
  };
}

describe("ToolRouter", () => {
  it("lists namespaced tools", async () => {
    const monitor = new Monitor({
      stateFilePath: "/tmp/mcp-orch-router-test-state.json",
      auditLogPath: "/tmp/mcp-orch-router-test-audit.log"
    });
    const router = new ToolRouter(new LoadBalancer(), monitor);

    const server = makeServer(
      "s1",
      "arxiv",
      [{ name: "search_papers", description: "Search" }],
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );

    await router.refreshToolCatalog([server]);
    const tools = await router.listTools();

    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0].name).toBe("arxiv.search_papers");
  });

  it("falls back when first server fails", async () => {
    const monitor = new Monitor({
      stateFilePath: "/tmp/mcp-orch-router-test2-state.json",
      auditLogPath: "/tmp/mcp-orch-router-test2-audit.log"
    });
    const router = new ToolRouter(new LoadBalancer(), monitor);

    const broken = makeServer(
      "broken",
      "github",
      [{ name: "repo_overview" }],
      async () => {
        throw new Error("down");
      }
    );
    const healthy = makeServer(
      "healthy",
      "github",
      [{ name: "repo_overview" }],
      async () => ({ content: [{ type: "text", text: "fallback" }] })
    );

    await router.refreshToolCatalog([broken, healthy]);
    const result = await router.callTool("github.repo_overview", {});

    expect(result).toMatchObject({ content: [{ text: "fallback" }] });
  });
});
