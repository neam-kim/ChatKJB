import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig
} from "@anthropic-ai/claude-agent-sdk";

interface ClaudeUserConfig {
  mcpServers?: Record<string, unknown>;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? Object.fromEntries(entries) as Record<string, string>
    : undefined;
}

function stdioServer(value: unknown): McpStdioServerConfig | null {
  if (!value || typeof value !== "object") return null;
  const server = value as Record<string, unknown>;
  if (typeof server.command !== "string") return null;
  const args = server.args === undefined ? undefined : stringArray(server.args);
  const env = server.env === undefined ? undefined : stringRecord(server.env);
  if ((server.args !== undefined && !args) || (server.env !== undefined && !env)) return null;
  return {
    type: "stdio",
    command: server.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {})
  };
}

function remoteServer(value: unknown): McpHttpServerConfig | McpSSEServerConfig | null {
  if (!value || typeof value !== "object") return null;
  const server = value as Record<string, unknown>;
  if ((server.type !== "http" && server.type !== "sse") || typeof server.url !== "string") {
    return null;
  }
  const headers = server.headers === undefined ? undefined : stringRecord(server.headers);
  if (server.headers !== undefined && !headers) return null;
  return {
    type: server.type,
    url: server.url,
    ...(headers ? { headers } : {})
  };
}

export function loadMcpServersWithTimeouts(
  generalTimeoutMs: number,
  longRunningTimeoutMs: number,
  longRunningServers: ReadonlySet<string> = new Set(["codex"]),
  configPath = join(homedir(), ".claude.json")
): Record<string, McpServerConfig> {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as ClaudeUserConfig;
    const result: Record<string, McpServerConfig> = {};
    for (const [name, rawServer] of Object.entries(config.mcpServers ?? {})) {
      const server = stdioServer(rawServer) ?? remoteServer(rawServer);
      if (!server) continue;
      const isLongRunning = longRunningServers.has(name.toLowerCase());
      result[name] = {
        ...server,
        timeout: isLongRunning ? longRunningTimeoutMs : generalTimeoutMs,
        ...(isLongRunning ? { alwaysLoad: true } : {})
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function mcpServerName(toolName: string): string | null {
  const match = /^mcp__(.+?)__/.exec(toolName);
  return match?.[1] ?? null;
}

export function isRetryableMcpError(toolName: string, error: string): boolean {
  if (!toolName.startsWith("mcp__")) return false;
  return /timed?\s*out|timeout|connection closed|econnreset|econnrefused|broken pipe|transport|server disconnected/i
    .test(error);
}

export function mcpCallKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input)}`;
}
