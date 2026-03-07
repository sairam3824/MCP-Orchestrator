#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import cliTable3 from "cli-table3";

// cli-table3 is CJS — handle both default-export and namespace-import shapes.
const Table = (cliTable3 as any).default ?? cliTable3;
import { Command } from "commander";
import { startOrchestrator } from "./index.js";

interface RuntimeSnapshot {
  generatedAt: string;
  servers: Array<{
    id: string;
    name: string;
    priority: "low" | "normal" | "high";
    healthy: boolean;
    activeRequests: number;
    uptimeSeconds: number;
    lastError?: string;
  }>;
  metrics: {
    tools: Array<{ tool: string; calls: number; errors: number; avgLatencyMs: number }>;
    servers: Array<{ server: string; calls: number; errors: number; avgLatencyMs: number }>;
  };
  totals: {
    calls: number;
    errors: number;
  };
}

function loadSnapshot(path: string): RuntimeSnapshot {
  const resolved = resolve(path);
  let contents: string;
  try {
    contents = readFileSync(resolved, "utf8");
  } catch {
    throw new Error(
      `Could not read state file at '${resolved}'. Is the orchestrator running?`
    );
  }
  try {
    return JSON.parse(contents) as RuntimeSnapshot;
  } catch {
    throw new Error(`State file '${resolved}' contains invalid JSON.`);
  }
}

function printStatus(snapshot: RuntimeSnapshot): void {
  const table = new Table({
    head: ["Server", "Priority", "Health", "Uptime", "Active", "Last Error"]
  });

  for (const server of snapshot.servers) {
    table.push([
      `${server.name} (${server.id})`,
      server.priority,
      server.healthy ? chalk.green("healthy") : chalk.red("unhealthy"),
      `${server.uptimeSeconds}s`,
      server.activeRequests,
      server.lastError ?? "-"
    ]);
  }

  process.stdout.write(`${chalk.bold("mcp-orch status")}\n`);
  process.stdout.write(`Updated: ${snapshot.generatedAt}\n`);
  process.stdout.write(`${table.toString()}\n`);
}

function printMetrics(snapshot: RuntimeSnapshot): void {
  const serverTable = new Table({
    head: ["Server", "Calls", "Errors", "Avg Latency"]
  });

  for (const metric of snapshot.metrics.servers) {
    serverTable.push([
      metric.server,
      metric.calls,
      metric.errors,
      `${metric.avgLatencyMs.toFixed(2)} ms`
    ]);
  }

  const toolTable = new Table({
    head: ["Tool", "Calls", "Errors", "Avg Latency"]
  });

  for (const metric of snapshot.metrics.tools) {
    toolTable.push([metric.tool, metric.calls, metric.errors, `${metric.avgLatencyMs.toFixed(2)} ms`]);
  }

  process.stdout.write(`${chalk.bold("mcp-orch metrics")}\n`);
  process.stdout.write(`Total calls: ${snapshot.totals.calls}\n`);
  process.stdout.write(`Total errors: ${snapshot.totals.errors}\n\n`);
  process.stdout.write(`${chalk.bold("Per-server")}\n${serverTable.toString()}\n\n`);
  process.stdout.write(`${chalk.bold("Per-tool")}\n${toolTable.toString()}\n`);
}

function printLogs(path: string, tail: number): void {
  const resolved = resolve(path);
  let contents: string;
  try {
    contents = readFileSync(resolved, "utf8");
  } catch {
    process.stderr.write(`Could not read audit log at '${resolved}'. Is the orchestrator running?\n`);
    return;
  }
  const lines = contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-tail);

  process.stdout.write(`${chalk.bold(`mcp-orch logs (last ${tail})`)}\n`);
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as {
        timestamp: string;
        tool: string;
        server: string;
        success: boolean;
        latencyMs: number;
        error?: string;
      };
      const status = record.success ? chalk.green("OK") : chalk.red("ERR");
      process.stdout.write(
        `${record.timestamp} ${status} ${record.server} ${record.tool} ${record.latencyMs}ms ${record.error ? `- ${record.error}` : ""
        }\n`
      );
    } catch {
      process.stdout.write(`${line}\n`);
    }
  }
}

const program = new Command();
program.name("mcp-orch").description("MCP Orchestrator CLI").version("0.1.0");

program
  .command("start")
  .description("Start the MCP Orchestrator server over stdio")
  .option("-c, --config <path>", "Path to mcp-orchestrator.yml", "mcp-orchestrator.yml")
  .option("--state-file <path>", "Path to runtime state file", ".mcp-orch/runtime-state.json")
  .option("--audit-log <path>", "Path to audit log file", ".mcp-orch/audit.log")
  .option("--disable-discovery", "Disable dynamic discovery of installed MCP packages", false)
  .action(async (options) => {
    await startOrchestrator({
      configPath: options.config,
      stateFilePath: options.stateFile,
      auditLogPath: options.auditLog,
      disableDiscovery: options.disableDiscovery
    });
  });

program
  .command("status")
  .description("Show server health and uptime")
  .option("--state-file <path>", "Path to runtime state file", ".mcp-orch/runtime-state.json")
  .action((options) => {
    const snapshot = loadSnapshot(options.stateFile);
    printStatus(snapshot);
  });

program
  .command("metrics")
  .description("Show call counts, latency, and error rates")
  .option("--state-file <path>", "Path to runtime state file", ".mcp-orch/runtime-state.json")
  .action((options) => {
    const snapshot = loadSnapshot(options.stateFile);
    printMetrics(snapshot);
  });

program
  .command("logs")
  .description("Show aggregated tool call logs")
  .option("--audit-log <path>", "Path to audit log file", ".mcp-orch/audit.log")
  .option("--tail <count>", "Number of lines to show", "50")
  .action((options) => {
    const tail = Number.parseInt(options.tail, 10);
    printLogs(options.auditLog, Number.isNaN(tail) || tail <= 0 ? 50 : tail);
  });

// Default to start so the binary can be used directly as an MCP stdio server.
if (process.argv.length <= 2) {
  process.argv.push("start");
}

void program.parseAsync(process.argv);
