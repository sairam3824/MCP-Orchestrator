# mcp-orchestrator

> As MCP adoption explodes, management becomes the bottleneck.  
> **mcp-orchestrator** is the **Nginx for MCP servers** — one meta-MCP endpoint that routes, load balances, and monitors many downstream MCP servers.

Built for [**Claude**](https://claude.ai) and Anthropic's [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — connect Claude to dozens of MCP tool servers through a single orchestrated gateway.

## Architecture

```
Claude Desktop / Claude API
        │
        ▼
 ┌──────────────┐
 │  MCP Orch.   │  ← single stdio MCP server
 └──┬───┬───┬───┘
    │   │   │
    ▼   ▼   ▼
  MCP  MCP  MCP   ← downstream servers (child processes)
  (A)  (B)  (C)
```

The orchestrator itself is an MCP server using **stdio transport**. Claude (or any MCP-compatible LLM client) connects to the orchestrator as if it were a single MCP server. Behind the scenes, the orchestrator manages multiple downstream MCP servers through child-process stdio transports and exposes all their tools through a **single unified interface**.

## Use with Claude Desktop

Add the orchestrator to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-orchestrator/dist/src/cli.js", "start"],
      "env": {}
    }
  }
}
```

Once configured, Claude will see **all tools** from every downstream MCP server aggregated under namespaced names like `arxiv.search_papers`, `github.repo_overview`, etc. — no need to register each server individually with Claude.

## Features

- **Unified MCP endpoint** over stdio (`mcp-orch start`)
- **Server registry** from YAML config (`mcp-orchestrator.yml`)
- **Dynamic discovery** of installed MCP packages via `npm ls` scan
- **Hot reload** — edit the config file, servers update without restart
- **Tool aggregation with namespacing** — `arxiv.search_papers`, `github.repo_overview`
- **Capability-aware routing** with priority + load awareness
- **Round-robin load balancing** across redundant server pools
- **Health-aware routing** — unhealthy servers are skipped automatically
- **Timeout & fallback** — if a server doesn't respond, the next candidate is tried
- **Exponential backoff** — failed servers reconnect with backoff up to 60 s
- **Security controls** — per-server allow/deny tool lists, per-tool rate limiting
- **Audit logging** — every tool call is logged to `.mcp-orch/audit.log`
- **CLI monitoring dashboard**:
  - `mcp-orch status` — server health and uptime
  - `mcp-orch metrics` — call counts, latency, error rates
  - `mcp-orch logs` — aggregated tool call logs

## Project Structure

```
├── src/
│   ├── index.ts          Main orchestrator MCP server
│   ├── registry.ts       Server registry + YAML config parser
│   ├── router.ts         Tool routing logic
│   ├── balancer.ts       Load balancing (round-robin, priority, least-loaded)
│   ├── health.ts         Health checking with probe timeouts
│   ├── monitor.ts        Metrics collection + audit log writer
│   ├── cli.ts            CLI dashboard (status, metrics, logs)
│   ├── types.ts          Shared TypeScript interfaces
│   └── utils.ts          Shared utilities (timeout helper)
├── config/
│   └── mcp-orchestrator.example.yml
├── tests/
│   ├── balancer.test.ts
│   └── router.test.ts
├── mcp-orchestrator.yml  Your local config (gitignored or customised)
├── package.json
├── tsconfig.json
├── LICENSE               MIT License
├── torun.txt             Quick-start run instructions
└── README.md
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Copy and edit config

```bash
cp config/mcp-orchestrator.example.yml mcp-orchestrator.yml
```

Open `mcp-orchestrator.yml` and set `enabled: true` only for servers whose commands are available in your environment. For example:

```yaml
servers:
  - name: arxiv
    enabled: true
    command: npx -y your-arxiv-mcp-server
    description: Search and read arXiv papers
    health_check_interval: 30s

  - name: github
    enabled: true
    command: npx -y your-github-mcp-server
    description: GitHub repository analytics
    priority: high
```

### 3. Build the project

```bash
npm run build
```

### 4. Start the orchestrator

**Development mode** (runs TypeScript directly):

```bash
npm run dev
```

**Production mode** (uses compiled JavaScript):

```bash
npm start
```

### 5. Monitor (in another terminal)

```bash
# Server health and uptime
npx mcp-orch status

# Call counts, latency, error rates
npx mcp-orch metrics

# Aggregated tool call logs (last 100 entries)
npx mcp-orch logs --tail 100
```

## Configuration Reference

Each server entry in `mcp-orchestrator.yml` supports the following fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | `string` | *required* | Logical namespace — used as tool prefix (e.g. `arxiv.search_papers`) |
| `command` | `string` | *required* | Shell command to start the downstream MCP server |
| `enabled` | `boolean` | `true` | Whether this server is active |
| `description` | `string` | — | Optional description |
| `priority` | `"high" \| "normal" \| "low"` | `"normal"` | Routing priority — higher priority servers are preferred |
| `health_check_interval` | `string` | `"30s"` | How often to probe (supports `ms`, `s`, `m`, `h`) |
| `timeout_ms` | `number` | `10000` | Tool call timeout before fallback (milliseconds) |
| `allow_tools` | `string[]` | `[]` | Allowlist — only these tools are exposed (empty = all) |
| `deny_tools` | `string[]` | `[]` | Denylist — these tools are hidden |
| `rate_limits` | `object` | `{}` | Per-tool or wildcard rate limits |

### Rate limiting example

```yaml
servers:
  - name: arxiv
    command: npx -y your-arxiv-mcp-server
    rate_limits:
      "*":
        maxCalls: 120
        windowMs: 60000
      search_papers:
        maxCalls: 30
        windowMs: 60000
```

### Redundancy / failover

Use duplicate `name` entries to create a failover pool:

```yaml
servers:
  - name: github
    command: npx -y your-github-mcp-server --region us-west
    priority: high

  - name: github
    command: npx -y your-github-mcp-server --region us-east
    priority: high
```

The orchestrator will round-robin across both and fall back automatically if one goes down.

## Behavior Notes

- **Namespaced tools** are always exposed as `<server>.<tool>`.
- **Unqualified calls** (e.g. `search_papers`) route by best-match if the tool name is unique across servers.
- **Unhealthy servers** are skipped when healthy alternatives exist.
- **Timeout/error → fallback**: if a server fails, the next candidate in the pool is tried.
- **Failed servers** reconnect with exponential backoff (1 s → 2 s → 4 s → … → 60 s max).
- **Runtime state** is written to `.mcp-orch/runtime-state.json` every 5 seconds.
- **Audit logs** are appended to `.mcp-orch/audit.log` for every tool call.
- **Dynamic discovery** finds installed npm packages containing "mcp" in their name. Discovered servers default to `enabled: false` — you must enable them in the config.
- **Hot reload**: editing `mcp-orchestrator.yml` triggers a live reload without restarting the process.

## Development

```bash
# Type-check without emitting
npm run typecheck

# Run tests
npm test

# Build to dist/
npm run build

# Development mode (auto-compiles TypeScript)
npm run dev
```

## CLI Reference

```
mcp-orch start [options]        Start the MCP Orchestrator server over stdio
  -c, --config <path>           Path to config file (default: mcp-orchestrator.yml)
  --state-file <path>           Path to runtime state (default: .mcp-orch/runtime-state.json)
  --audit-log <path>            Path to audit log (default: .mcp-orch/audit.log)
  --disable-discovery           Disable auto-discovery of installed MCP packages

mcp-orch status [options]       Show server health and uptime
  --state-file <path>           Path to runtime state file

mcp-orch metrics [options]      Show call counts, latency, error rates
  --state-file <path>           Path to runtime state file

mcp-orch logs [options]         Show aggregated tool call logs
  --audit-log <path>            Path to audit log file
  --tail <count>                Number of lines to show (default: 50)
```

## Roadmap

- Rich interactive terminal dashboard with live refresh and sparkline charts
- Prometheus export / OpenTelemetry hooks
- Adaptive routing policies (latency-aware, cost-aware)
- Optional control-plane API for dynamic registration
- WebSocket transport support

## License

Licensed under the [MIT License](LICENSE).

