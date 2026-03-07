import type { ServerRuntime } from "./types.js";
import { withTimeout } from "./utils.js";

export interface HealthCheckerOptions {
  timeoutMs?: number;
  onRecovered?: (server: ServerRuntime) => Promise<void> | void;
}

export class HealthChecker {
  private serversProvider: (() => ServerRuntime[]) | undefined;
  private timer?: NodeJS.Timeout;
  private readonly probeTimeoutMs: number;
  private readonly onRecovered?: (server: ServerRuntime) => Promise<void> | void;
  private readonly lastProbeAt = new Map<string, number>();

  constructor(options: HealthCheckerOptions = {}) {
    this.probeTimeoutMs = options.timeoutMs ?? 5_000;
    this.onRecovered = options.onRecovered;
  }

  setServersProvider(provider: () => ServerRuntime[]): void {
    this.serversProvider = provider;
  }

  start(): void {
    this.stop();

    this.timer = setInterval(() => {
      void this.probeServers();
    }, 1_000);
    this.timer.unref();

    void this.probeServers();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async probeServers(): Promise<void> {
    const servers = this.serversProvider?.() ?? [];
    const now = Date.now();

    await Promise.all(
      servers.map(async (server) => {
        const previousProbe = this.lastProbeAt.get(server.id) ?? 0;
        if (now - previousProbe < server.healthCheckIntervalMs) {
          return;
        }
        this.lastProbeAt.set(server.id, now);

        const wasHealthy = server.healthy;
        try {
          await withTimeout(server.probe(), this.probeTimeoutMs);
          server.healthy = true;
          server.lastError = undefined;
          if (!wasHealthy) {
            await this.onRecovered?.(server);
          }
        } catch (error) {
          server.healthy = false;
          server.lastError = error instanceof Error ? error.message : String(error);
        }
      })
    );
  }
}
