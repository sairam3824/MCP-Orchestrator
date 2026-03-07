import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LoadBalancer } from "./balancer.js";
import { HealthChecker } from "./health.js";
import { Monitor } from "./monitor.js";
import { ServerRegistry, parseDuration } from "./registry.js";
import { ToolRouter } from "./router.js";
import type { McpTool, ServerConfig, ServerRuntime, ToolCallResult } from "./types.js";

function tokenizeCommand(command: string): { cmd: string; args: string[] } {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  if (tokens.length === 0) {
    throw new Error(`Invalid command: '${command}'`);
  }

  const cleaned = tokens.map((token) => token.replace(/^['"]|['"]$/g, ""));
  return { cmd: cleaned[0], args: cleaned.slice(1) };
}

class DownstreamMcpServer implements ServerRuntime {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly priority;
  readonly timeoutMs: number;
  readonly healthCheckIntervalMs: number;
  readonly allowTools: Set<string>;
  readonly denyTools: Set<string>;
  readonly rateLimits: Record<string, { maxCalls: number; windowMs: number }>;

  healthy = false;
  activeRequests = 0;
  startedAt = Date.now();
  lastError?: string;

  private readonly config: ServerConfig;
  private client?: Client;
  private transport?: StdioClientTransport;
  private nextConnectAttemptAt = 0;
  private connectBackoffMs = 1_000;
  private connectingPromise?: Promise<void>;

  constructor(config: ServerConfig, id: string) {
    this.id = id;
    this.name = config.name;
    this.description = config.description;
    this.priority = config.priority ?? "normal";
    this.timeoutMs = config.timeout_ms ?? 10_000;
    this.healthCheckIntervalMs = parseDuration(config.health_check_interval, 30_000);
    this.allowTools = new Set(config.allow_tools ?? []);
    this.denyTools = new Set(config.deny_tools ?? []);
    this.rateLimits = config.rate_limits ?? {};
    this.config = config;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureConnected();

    // Use the SDK's native listTools() method directly — no fragile casting.
    const response = await this.client!.listTools();
    return (response.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined
    }));
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    _timeoutMs: number
  ): Promise<ToolCallResult> {
    await this.ensureConnected();

    // Use the SDK's native callTool() method directly — no fragile casting.
    // Timeout is NOT applied here; the caller (ToolRouter) handles timeout
    // to avoid double-wrapping.
    const response = await this.client!.callTool({ name: toolName, arguments: args });
    return response as ToolCallResult;
  }

  async probe(): Promise<void> {
    await this.listTools();
  }

  async shutdown(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // Best-effort shutdown.
    }

    try {
      await this.transport?.close();
    } catch {
      // Best-effort shutdown.
    }

    this.client = undefined;
    this.transport = undefined;
    this.healthy = false;
    this.nextConnectAttemptAt = 0;
    this.connectBackoffMs = 1_000;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client) {
      return;
    }

    // Prevent concurrent callers from spawning duplicate child processes.
    if (this.connectingPromise) {
      await this.connectingPromise;
      return;
    }

    if (Date.now() < this.nextConnectAttemptAt) {
      throw new Error(
        `Server '${this.name}' reconnect backoff in effect for ${this.nextConnectAttemptAt - Date.now()}ms`
      );
    }

    this.connectingPromise = this.doConnect();
    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = undefined;
    }
  }

  private async doConnect(): Promise<void> {
    const { cmd, args } = tokenizeCommand(this.config.command);
    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
      )
    });

    const client = new Client(
      {
        name: `mcp-orchestrator:${this.id}`,
        version: "0.1.0"
      },
      {
        capabilities: {}
      }
    );

    try {
      await client.connect(transport);
      this.client = client;
      this.transport = transport;
      this.startedAt = Date.now();
      this.healthy = true;
      this.lastError = undefined;
      this.nextConnectAttemptAt = 0;
      this.connectBackoffMs = 1_000;
    } catch (error) {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup on failed connect.
      }
      this.client = undefined;
      this.transport = undefined;
      this.healthy = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.nextConnectAttemptAt = Date.now() + this.connectBackoffMs;
      this.connectBackoffMs = Math.min(this.connectBackoffMs * 2, 60_000);
      throw error;
    }
  }
}

export interface OrchestratorStartOptions {
  configPath?: string;
  stateFilePath?: string;
  auditLogPath?: string;
  disableDiscovery?: boolean;
}

export class McpOrchestrator {
  private readonly registry: ServerRegistry;
  private readonly monitor: Monitor;
  private readonly balancer: LoadBalancer;
  private readonly router: ToolRouter;
  private readonly healthChecker: HealthChecker;
  private readonly mcpServer: Server;

  private servers: ServerRuntime[] = [];
  private started = false;
  private reloading = false;

  constructor(options: OrchestratorStartOptions = {}) {
    const configPath = resolve(options.configPath ?? "mcp-orchestrator.yml");

    this.registry = new ServerRegistry(configPath, {
      discoverInstalledServers: !options.disableDiscovery
    });
    this.monitor = new Monitor({
      stateFilePath: options.stateFilePath,
      auditLogPath: options.auditLogPath
    });
    this.balancer = new LoadBalancer();
    this.router = new ToolRouter(this.balancer, this.monitor);
    this.healthChecker = new HealthChecker({
      timeoutMs: 5_000,
      onRecovered: async (server) => {
        // Only refresh the recovered server's tools, not the entire catalog.
        await this.router.refreshSingleServer(server);
        this.monitor.flushState();
      }
    });

    this.mcpServer = new Server(
      {
        name: "mcp-orchestrator",
        version: "0.1.0"
      },
      {
        capabilities: {
          tools: {}
        }
      }
    );

    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return (await this.router.listTools()) as any;
    });

    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };

      if (!params?.name) {
        return {
          isError: true,
          content: [{ type: "text", text: "Missing tool name" }]
        };
      }

      try {
        return (await this.router.callTool(params.name, params.arguments ?? undefined, 10_000)) as any;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        };
      }
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.registry.load();
    await this.reloadServers();

    this.registry.on("reloaded", async () => {
      await this.reloadServers();
    });
    this.registry.on("error", (error) => {
      // Surface registry errors in runtime state for visibility.
      const message = error instanceof Error ? error.message : String(error);
      this.monitor.recordToolCall({
        tool: "registry.reload",
        server: "orchestrator",
        success: false,
        latencyMs: 0,
        error: message
      });
    });

    this.registry.startWatch();
    this.monitor.setServerProvider(() => this.servers);
    this.monitor.start();

    this.healthChecker.setServersProvider(() => this.servers);
    this.healthChecker.start();

    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    this.started = true;
  }

  async stop(): Promise<void> {
    this.registry.stopWatch();
    this.healthChecker.stop();
    this.monitor.stop();

    for (const server of this.servers) {
      await server.shutdown();
    }

    this.servers = [];
    this.started = false;
  }

  private async reloadServers(): Promise<void> {
    // Prevent overlapping reloads from concurrent config changes.
    if (this.reloading) {
      return;
    }
    this.reloading = true;

    try {
      const oldServers = this.servers;

      const configs = this.registry.getServers().filter((config) => config.enabled !== false);
      const newServers = configs.map((config, idx) => new DownstreamMcpServer(config, `${config.name}:${idx}`));

      // Trigger initial connection attempts without failing startup on single-node failure.
      await Promise.all(
        newServers.map(async (server) => {
          try {
            await server.probe();
          } catch {
            // Individual server may be down; router + health checker handle fallback and recovery.
          }
        })
      );

      // Swap atomically — no window where this.servers is empty.
      this.servers = newServers;

      await this.router.refreshToolCatalog(this.servers);
      this.monitor.flushState();

      // Shut down old servers AFTER swapping, so in-flight operations aren't interrupted.
      for (const old of oldServers) {
        await old.shutdown();
      }
    } finally {
      this.reloading = false;
    }
  }
}

export async function startOrchestrator(options: OrchestratorStartOptions = {}): Promise<void> {
  const orchestrator = new McpOrchestrator(options);

  const shutdown = async () => {
    try {
      await orchestrator.stop();
    } catch {
      // Best-effort — still exit regardless.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await orchestrator.start();
}

// Fixed: use fileURLToPath so the comparison actually works on all platforms.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  void startOrchestrator();
}
