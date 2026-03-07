import type { Priority, ServerRuntime } from "./types.js";

const PRIORITY_WEIGHT: Record<Priority, number> = {
  high: 3,
  normal: 2,
  low: 1
};

export class LoadBalancer {
  private readonly rrCursor = new Map<string, number>();

  select(candidates: ServerRuntime[], routeKey: string): ServerRuntime | undefined {
    const healthy = candidates.filter((c) => c.healthy);
    const pool = healthy.length > 0 ? healthy : candidates;

    if (pool.length === 0) {
      return undefined;
    }

    const bestPriority = Math.max(...pool.map((s) => PRIORITY_WEIGHT[s.priority]));
    const priorityPool = pool.filter((s) => PRIORITY_WEIGHT[s.priority] === bestPriority);

    // Prefer lower in-flight requests, then apply round-robin among similarly loaded servers.
    const minLoad = Math.min(...priorityPool.map((s) => s.activeRequests));
    const leastLoaded = priorityPool.filter((s) => s.activeRequests === minLoad);

    const cursor = this.rrCursor.get(routeKey) ?? 0;
    const selected = leastLoaded[cursor % leastLoaded.length];
    // Increment freely — the modulo on access already handles bounds.
    // Wrapping against current pool size would reset the cursor when the pool shrinks.
    this.rrCursor.set(routeKey, cursor + 1);
    return selected;
  }

  selectFallback(
    candidates: ServerRuntime[],
    attemptedServerIds: Set<string>,
    routeKey: string
  ): ServerRuntime | undefined {
    const remaining = candidates.filter((candidate) => !attemptedServerIds.has(candidate.id));
    return this.select(remaining, `${routeKey}:fallback:${attemptedServerIds.size}`);
  }
}
