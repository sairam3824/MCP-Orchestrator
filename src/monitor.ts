import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Priority, ServerRuntime, ToolCallAuditRecord } from "./types.js";

interface ToolMetric {
  calls: number;
  errors: number;
  totalLatencyMs: number;
}

interface ServerMetric {
  calls: number;
  errors: number;
  totalLatencyMs: number;
}

interface ToolCallEvent {
  tool: string;
  server: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}

export interface MonitorOptions {
  stateFilePath?: string;
  auditLogPath?: string;
  flushIntervalMs?: number;
}

interface RuntimeServerSnapshot {
  id: string;
  name: string;
  priority: Priority;
  healthy: boolean;
  activeRequests: number;
  uptimeSeconds: number;
  lastError?: string;
}

export class Monitor {
  private readonly stateFilePath: string;
  private readonly auditLogPath: string;
  private readonly flushIntervalMs: number;

  private readonly perTool = new Map<string, ToolMetric>();
  private readonly perServer = new Map<string, ServerMetric>();

  private serverProvider: (() => ServerRuntime[]) | undefined;
  private flushTimer?: NodeJS.Timeout;

  constructor(options: MonitorOptions = {}) {
    this.stateFilePath = resolve(options.stateFilePath ?? ".mcp-orch/runtime-state.json");
    this.auditLogPath = resolve(options.auditLogPath ?? ".mcp-orch/audit.log");
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;

    this.ensureParentDir(this.stateFilePath);
    this.ensureParentDir(this.auditLogPath);
  }

  setServerProvider(provider: () => ServerRuntime[]): void {
    this.serverProvider = provider;
  }

  start(): void {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.flushState();
    }, this.flushIntervalMs);
    this.flushTimer.unref();
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushState();
  }

  recordToolCall(event: ToolCallEvent): void {
    const toolMetric = this.perTool.get(event.tool) ?? { calls: 0, errors: 0, totalLatencyMs: 0 };
    toolMetric.calls += 1;
    toolMetric.totalLatencyMs += event.latencyMs;
    if (!event.success) {
      toolMetric.errors += 1;
    }
    this.perTool.set(event.tool, toolMetric);

    const serverMetric = this.perServer.get(event.server) ?? { calls: 0, errors: 0, totalLatencyMs: 0 };
    serverMetric.calls += 1;
    serverMetric.totalLatencyMs += event.latencyMs;
    if (!event.success) {
      serverMetric.errors += 1;
    }
    this.perServer.set(event.server, serverMetric);

    const auditRecord: ToolCallAuditRecord = {
      timestamp: new Date().toISOString(),
      tool: event.tool,
      server: event.server,
      success: event.success,
      latencyMs: event.latencyMs,
      error: event.error
    };

    // Async write — fire-and-forget to avoid blocking the event loop.
    void appendFile(this.auditLogPath, `${JSON.stringify(auditRecord)}\n`, "utf8").catch(() => {
      // Best-effort audit logging; swallow write errors.
    });
  }

  flushState(): void {
    const snapshot = this.getSnapshot();
    writeFileSync(this.stateFilePath, JSON.stringify(snapshot, null, 2), "utf8");
  }

  getSnapshot(): Record<string, unknown> {
    const servers = (this.serverProvider?.() ?? []).map((server): RuntimeServerSnapshot => ({
      id: server.id,
      name: server.name,
      priority: server.priority,
      healthy: server.healthy,
      activeRequests: server.activeRequests,
      uptimeSeconds: Math.round((Date.now() - server.startedAt) / 1000),
      lastError: server.lastError
    }));

    const toolMetrics = Array.from(this.perTool.entries()).map(([tool, metric]) => ({
      tool,
      calls: metric.calls,
      errors: metric.errors,
      avgLatencyMs: metric.calls === 0 ? 0 : Number((metric.totalLatencyMs / metric.calls).toFixed(2))
    }));

    const serverMetrics = Array.from(this.perServer.entries()).map(([server, metric]) => ({
      server,
      calls: metric.calls,
      errors: metric.errors,
      avgLatencyMs: metric.calls === 0 ? 0 : Number((metric.totalLatencyMs / metric.calls).toFixed(2))
    }));

    return {
      generatedAt: new Date().toISOString(),
      servers,
      metrics: {
        tools: toolMetrics,
        servers: serverMetrics
      },
      totals: {
        calls: serverMetrics.reduce((sum, m) => sum + m.calls, 0),
        errors: serverMetrics.reduce((sum, m) => sum + m.errors, 0)
      }
    };
  }

  private ensureParentDir(path: string): void {
    const parent = dirname(path);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
  }
}
