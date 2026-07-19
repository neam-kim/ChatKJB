import type {
  McpHttpServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig
} from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ClaudeUserConfig {
  mcpServers?: Record<string, unknown>;
}

/** 파일에서 읽어 타임아웃을 적용할 수 있는 서버 형태(인스턴스 변형 제외). */
export type ConfigurableMcpServer =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSSEServerConfig;

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
  try {
    const url = new URL(server.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
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

/**
 * 단일 MCP 서버 항목(claude.json 또는 codex config에서 정규화된 객체)을 SDK 설정으로 파싱한다.
 * stdio(command) 또는 remote(http/sse) 둘 중 하나로 해석하며, 알 수 없는 형태면 null.
 */
export function parseMcpServerEntry(raw: unknown): ConfigurableMcpServer | null {
  return stdioServer(raw) ?? remoteServer(raw);
}

/**
 * 서버에 타임아웃과 alwaysLoad(장기 실행 서버만)를 적용한다. 장기 실행 서버는 tool search
 * 지연 대신 항상 프롬프트에 포함되고, 나머지는 alwaysLoad를 주지 않아 지연 로딩된다.
 */
export function withMcpTimeout(
  name: string,
  server: ConfigurableMcpServer,
  generalTimeoutMs: number,
  longRunningTimeoutMs: number,
  longRunningServers: ReadonlySet<string>
): McpServerConfig {
  const isLongRunning = longRunningServers.has(name.toLowerCase());
  return {
    ...server,
    timeout: isLongRunning ? longRunningTimeoutMs : generalTimeoutMs,
    ...(isLongRunning ? { alwaysLoad: true } : {})
  };
}

/** claude.json의 mcpServers만 정규화해 반환한다(타임아웃 미적용). */
export function loadClaudeJsonServers(
  configPath = join(homedir(), ".claude.json")
): Record<string, ConfigurableMcpServer> {
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as ClaudeUserConfig;
    const result: Record<string, ConfigurableMcpServer> = {};
    for (const [name, rawServer] of Object.entries(config.mcpServers ?? {})) {
      const server = parseMcpServerEntry(rawServer);
      if (server) result[name] = server;
    }
    return result;
  } catch {
    return {};
  }
}

export function loadMcpServersWithTimeouts(
  generalTimeoutMs: number,
  longRunningTimeoutMs: number,
  longRunningServers: ReadonlySet<string> = new Set(["codex"]),
  configPath = join(homedir(), ".claude.json")
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(loadClaudeJsonServers(configPath))) {
    result[name] = withMcpTimeout(
      name,
      server,
      generalTimeoutMs,
      longRunningTimeoutMs,
      longRunningServers
    );
  }
  return result;
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
