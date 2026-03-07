import { LoadBalancer } from "./balancer.js";
import type { Monitor } from "./monitor.js";
import type { McpTool, ServerRuntime, ToolBinding } from "./types.js";
import { withTimeout } from "./utils.js";

interface ToolListResponse {
  tools: McpTool[];
}

interface CallToolResponse {
  [key: string]: unknown;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

export class ToolRouter {
  private readonly balancer: LoadBalancer;
  private readonly monitor: Monitor;

  private readonly namespacedToolMap = new Map<string, ToolBinding[]>();
  private readonly aliasToolMap = new Map<string, ToolBinding[]>();
  private readonly rateWindows = new Map<string, RateWindow>();

  constructor(balancer: LoadBalancer, monitor: Monitor) {
    this.balancer = balancer;
    this.monitor = monitor;
  }

  async refreshToolCatalog(servers: ServerRuntime[]): Promise<void> {
    this.namespacedToolMap.clear();
    this.aliasToolMap.clear();

    await Promise.all(
      servers.map(async (server) => {
        await this.addServerTools(server);
      })
    );
  }

  /**
   * Refresh tools for a single recovered server without disrupting the rest of the catalog.
   */
  async refreshSingleServer(server: ServerRuntime): Promise<void> {
    // Remove any existing bindings for this server.
    this.removeServerBindings(server.id);

    // Re-add tools from the recovered server.
    await this.addServerTools(server);
  }

  async listTools(): Promise<ToolListResponse> {
    const uniqueTools = new Map<string, McpTool>();

    for (const [name, bindings] of this.namespacedToolMap.entries()) {
      const first = bindings[0];
      uniqueTools.set(name, {
        name,
        description: first.description,
        inputSchema: first.inputSchema
      });
    }

    return { tools: Array.from(uniqueTools.values()).sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async callTool(
    requestedToolName: string,
    args: Record<string, unknown> | undefined,
    defaultTimeoutMs = 10_000
  ): Promise<CallToolResponse> {
    const candidates = this.getCandidates(requestedToolName);

    if (candidates.length === 0) {
      throw new Error(`No downstream server found for tool '${requestedToolName}'`);
    }

    const attemptedServerIds = new Set<string>();
    let lastError: unknown;

    while (attemptedServerIds.size < candidates.length) {
      const selected = this.balancer.selectFallback(
        candidates.map((c) => c.server),
        attemptedServerIds,
        requestedToolName
      );

      if (!selected) {
        break;
      }

      const binding = candidates.find((candidate) => candidate.server.id === selected.id);
      if (!binding) {
        attemptedServerIds.add(selected.id);
        continue;
      }

      const namespacedCalledTool = binding.namespacedToolName;
      const actualToolName = binding.rawToolName;
      const timeoutMs = selected.timeoutMs ?? defaultTimeoutMs;

      if (!this.consumeRateLimit(selected, actualToolName)) {
        attemptedServerIds.add(selected.id);
        lastError = new Error(`Rate limit exceeded for ${selected.name}.${actualToolName}`);
        continue;
      }

      const startedAt = Date.now();
      selected.activeRequests += 1;

      try {
        // Single timeout applied here — DownstreamMcpServer.callTool no longer wraps its own.
        const response = await withTimeout(selected.callTool(actualToolName, args, timeoutMs), timeoutMs);
        selected.healthy = true;
        selected.lastError = undefined;

        this.monitor.recordToolCall({
          tool: namespacedCalledTool,
          server: selected.name,
          success: true,
          latencyMs: Date.now() - startedAt
        });

        return response;
      } catch (error) {
        selected.healthy = false;
        selected.lastError = error instanceof Error ? error.message : String(error);
        lastError = error;

        this.monitor.recordToolCall({
          tool: namespacedCalledTool,
          server: selected.name,
          success: false,
          latencyMs: Date.now() - startedAt,
          error: selected.lastError
        });

        attemptedServerIds.add(selected.id);
      } finally {
        selected.activeRequests = Math.max(0, selected.activeRequests - 1);
      }
    }

    throw new Error(
      `All candidates failed for tool '${requestedToolName}'. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
  }

  private getCandidates(toolName: string): ToolBinding[] {
    if (toolName.includes(".")) {
      return this.namespacedToolMap.get(toolName) ?? [];
    }

    return this.aliasToolMap.get(toolName) ?? [];
  }

  private isToolAllowed(server: ServerRuntime, toolName: string): boolean {
    if (server.allowTools.size > 0 && !server.allowTools.has(toolName)) {
      return false;
    }

    if (server.denyTools.has(toolName)) {
      return false;
    }

    return true;
  }

  private appendBinding(map: Map<string, ToolBinding[]>, key: string, binding: ToolBinding): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(binding);
    } else {
      map.set(key, [binding]);
    }
  }

  private consumeRateLimit(server: ServerRuntime, rawToolName: string): boolean {
    const limit = server.rateLimits[rawToolName] ?? server.rateLimits["*"];
    if (!limit) {
      return true;
    }

    const now = Date.now();
    const key = `${server.id}:${rawToolName}`;
    const existing = this.rateWindows.get(key);

    if (!existing || now - existing.windowStart >= limit.windowMs) {
      this.rateWindows.set(key, { windowStart: now, count: 1 });
      return true;
    }

    if (existing.count >= limit.maxCalls) {
      return false;
    }

    existing.count += 1;
    this.rateWindows.set(key, existing);
    return true;
  }

  /**
   * Helper to add a single server's tools to the maps.
   */
  private async addServerTools(server: ServerRuntime): Promise<void> {
    let tools: McpTool[] = [];
    try {
      tools = await server.listTools();
    } catch (error) {
      server.healthy = false;
      server.lastError = error instanceof Error ? error.message : String(error);
      return;
    }

    for (const tool of tools) {
      if (!this.isToolAllowed(server, tool.name)) {
        continue;
      }

      const binding: ToolBinding = {
        namespace: server.name,
        rawToolName: tool.name,
        namespacedToolName: `${server.name}.${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        server
      };

      this.appendBinding(this.namespacedToolMap, binding.namespacedToolName, binding);
      this.appendBinding(this.aliasToolMap, tool.name, binding);
    }
  }

  /**
   * Remove all bindings belonging to a given server ID.
   */
  private removeServerBindings(serverId: string): void {
    for (const [key, bindings] of this.namespacedToolMap.entries()) {
      const filtered = bindings.filter((b) => b.server.id !== serverId);
      if (filtered.length === 0) {
        this.namespacedToolMap.delete(key);
      } else {
        this.namespacedToolMap.set(key, filtered);
      }
    }

    for (const [key, bindings] of this.aliasToolMap.entries()) {
      const filtered = bindings.filter((b) => b.server.id !== serverId);
      if (filtered.length === 0) {
        this.aliasToolMap.delete(key);
      } else {
        this.aliasToolMap.set(key, filtered);
      }
    }
  }
}
