import { EventEmitter } from "node:events";
import { readFileSync, watch } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import type { OrchestratorConfig, Priority, ServerConfig } from "./types.js";

const DEFAULT_PRIORITY: Priority = "normal";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_INTERVAL_MS = 30_000;

const DURATION_RE = /^(?<value>\d+)(?<unit>ms|s|m|h)?$/i;

export function parseDuration(value?: string, fallbackMs = DEFAULT_HEALTH_INTERVAL_MS): number {
  if (!value) {
    return fallbackMs;
  }

  const match = value.trim().match(DURATION_RE);
  if (!match?.groups) {
    return fallbackMs;
  }

  const num = Number.parseInt(match.groups.value, 10);
  const unit = (match.groups.unit ?? "ms").toLowerCase();

  if (Number.isNaN(num) || num <= 0) {
    return fallbackMs;
  }

  switch (unit) {
    case "h":
      return num * 60 * 60 * 1000;
    case "m":
      return num * 60 * 1000;
    case "s":
      return num * 1000;
    case "ms":
    default:
      return num;
  }
}

function isPriority(value: unknown): value is Priority {
  return value === "high" || value === "normal" || value === "low";
}

function normalizeServer(raw: ServerConfig): ServerConfig {
  return {
    ...raw,
    name: raw.name.trim(),
    command: raw.command.trim(),
    // Preserve explicit enabled values; default to true only when omitted.
    enabled: raw.enabled ?? true,
    priority: isPriority(raw.priority) ? raw.priority : DEFAULT_PRIORITY,
    timeout_ms: raw.timeout_ms && raw.timeout_ms > 0 ? raw.timeout_ms : DEFAULT_TIMEOUT_MS,
    health_check_interval: raw.health_check_interval ?? "30s",
    allow_tools: raw.allow_tools ?? [],
    deny_tools: raw.deny_tools ?? [],
    rate_limits: raw.rate_limits ?? {}
  };
}

function parseConfig(content: string): OrchestratorConfig {
  const parsed = yaml.load(content) as OrchestratorConfig | undefined;
  const servers = parsed?.servers ?? [];

  if (!Array.isArray(servers)) {
    throw new Error("Invalid config: 'servers' must be an array");
  }

  const normalized: ServerConfig[] = [];
  const names = new Set<string>();

  for (const server of servers) {
    if (!server?.name || !server?.command) {
      throw new Error("Invalid server entry: each server needs 'name' and 'command'");
    }

    const clean = normalizeServer(server);
    if (names.has(clean.name)) {
      // Duplicate names are valid for redundancy pools.
      normalized.push(clean);
      continue;
    }

    names.add(clean.name);
    normalized.push(clean);
  }

  return { servers: normalized };
}

export interface RegistryOptions {
  discoverInstalledServers?: boolean;
}

export class ServerRegistry extends EventEmitter {
  private readonly configPath: string;
  private readonly discoverInstalledServers: boolean;
  private config: OrchestratorConfig = { servers: [] };
  private watcher?: ReturnType<typeof watch>;
  private reloadTimer?: NodeJS.Timeout;

  constructor(configPath: string, options: RegistryOptions = {}) {
    super();
    this.configPath = resolve(configPath);
    this.discoverInstalledServers = options.discoverInstalledServers ?? true;
  }

  load(): OrchestratorConfig {
    const raw = readFileSync(this.configPath, "utf8");
    const parsed = parseConfig(raw);

    if (this.discoverInstalledServers) {
      const discovered = this.discoverInstalled();
      const existing = new Set(parsed.servers.map((s) => s.name));
      for (const server of discovered) {
        if (!existing.has(server.name)) {
          parsed.servers.push(server);
        }
      }
    }

    this.config = parsed;
    return parsed;
  }

  getConfig(): OrchestratorConfig {
    return this.config;
  }

  getServers(): ServerConfig[] {
    return this.config.servers;
  }

  startWatch(): void {
    if (this.watcher) {
      return;
    }

    this.watcher = watch(this.configPath, { persistent: true }, () => {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
      }

      this.reloadTimer = setTimeout(() => {
        try {
          this.load();
          this.emit("reloaded", this.config);
        } catch (error) {
          this.emit("error", error);
        }
      }, 250);
    });

    // Handle watcher-level errors so they don't crash the process.
    this.watcher.on("error", (error) => {
      this.emit("error", error);
    });
  }

  stopWatch(): void {
    this.watcher?.close();
    this.watcher = undefined;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
  }

  private discoverInstalled(): ServerConfig[] {
    const result = spawnSync("npm", ["ls", "--depth=0", "--json"], {
      encoding: "utf8",
      shell: process.platform === "win32"
    });

    // npm ls can exit with non-zero when there are peer dep warnings but
    // still produce valid JSON output — only bail if there's no stdout.
    if (!result.stdout) {
      return [];
    }

    try {
      const parsed = JSON.parse(result.stdout) as { dependencies?: Record<string, unknown> };
      const dependencyNames = Object.keys(parsed.dependencies ?? {});
      const discovered: ServerConfig[] = [];

      for (const pkgName of dependencyNames) {
        if (!pkgName.includes("mcp")) {
          continue;
        }

        const normalizedName = pkgName
          .replace(/^@[^/]+\//, "")
          .replace(/^mcp[-_]?/, "")
          .replace(/[^a-zA-Z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .toLowerCase();

        discovered.push({
          name: normalizedName || pkgName,
          command: `npx ${pkgName}`,
          description: `Discovered MCP package: ${pkgName}`,
          enabled: false,
          priority: "low",
          health_check_interval: "45s",
          timeout_ms: DEFAULT_TIMEOUT_MS,
          allow_tools: [],
          deny_tools: [],
          rate_limits: {},
          discovered: true
        });
      }

      return discovered;
    } catch {
      return [];
    }
  }
}
