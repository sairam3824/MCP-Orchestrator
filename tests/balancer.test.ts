import { describe, expect, it } from "vitest";
import { LoadBalancer } from "../src/balancer.js";
import type { ServerRuntime } from "../src/types.js";

function makeServer(id: string, name: string): ServerRuntime {
  return {
    id,
    name,
    priority: "normal",
    healthy: true,
    activeRequests: 0,
    startedAt: Date.now(),
    healthCheckIntervalMs: 30_000,
    timeoutMs: 10_000,
    allowTools: new Set<string>(),
    denyTools: new Set<string>(),
    rateLimits: {},
    listTools: async () => [],
    callTool: async () => ({}),
    probe: async () => {},
    shutdown: async () => {},
    description: "",
    lastError: undefined
  };
}

describe("LoadBalancer", () => {
  it("round-robins among equally eligible servers", () => {
    const balancer = new LoadBalancer();
    const a = makeServer("a", "github");
    const b = makeServer("b", "github");

    const first = balancer.select([a, b], "github.repo_overview");
    const second = balancer.select([a, b], "github.repo_overview");

    expect(first?.id).toBe("a");
    expect(second?.id).toBe("b");
  });

  it("prefers healthy servers", () => {
    const balancer = new LoadBalancer();
    const unhealthy = makeServer("a", "github");
    unhealthy.healthy = false;
    const healthy = makeServer("b", "github");

    const selected = balancer.select([unhealthy, healthy], "github.repo_overview");
    expect(selected?.id).toBe("b");
  });
});
