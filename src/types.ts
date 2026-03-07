export type Priority = "low" | "normal" | "high";

export interface RateLimitConfig {
  maxCalls: number;
  windowMs: number;
}

export interface ServerConfig {
  name: string;
  command: string;
  enabled?: boolean;
  description?: string;
  priority?: Priority;
  health_check_interval?: string;
  timeout_ms?: number;
  allow_tools?: string[];
  deny_tools?: string[];
  rate_limits?: Record<string, RateLimitConfig>;
  discovered?: boolean;
}

export interface OrchestratorConfig {
  servers: ServerConfig[];
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCallResult {
  [key: string]: unknown;
}

export interface ServerRuntime {
  id: string;
  name: string;
  description?: string;
  priority: Priority;
  healthy: boolean;
  activeRequests: number;
  startedAt: number;
  healthCheckIntervalMs: number;
  timeoutMs: number;
  allowTools: Set<string>;
  denyTools: Set<string>;
  rateLimits: Record<string, RateLimitConfig>;
  lastError?: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown> | undefined, timeoutMs: number): Promise<ToolCallResult>;
  probe(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ToolBinding {
  namespace: string;
  rawToolName: string;
  namespacedToolName: string;
  server: ServerRuntime;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolCallAuditRecord {
  timestamp: string;
  tool: string;
  server: string;
  success: boolean;
  latencyMs: number;
  error?: string;
}
