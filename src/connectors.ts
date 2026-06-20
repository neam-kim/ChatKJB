import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  type ConfigurableMcpServer,
  loadClaudeJsonServers,
  parseMcpServerEntry,
  withMcpTimeout
} from "./mcp-policy.js";

// 데스크톱 앱이 쓰는 MCP "커넥터"를 한 곳으로 모은다.
// - Claude: claude.json + codex config.toml을 병합해 Agent SDK의 mcpServers로 전달
// - Codex: codex 바이너리가 ~/.codex/config.toml을 네이티브로 읽으므로 별도 주입 불필요
// - agy(antigravity): ~/.gemini/config/mcp_config.json을 네이티브로 읽으므로 병합 셋을 동기화
//
// claude.json·codex config 모두 stdio(command/args/env) 또는 remote(http/sse url) 서버를 담는다.
// codex config.toml의 [mcp_servers.*] 섹션만 좁게 파싱하는 미니 TOML 파서를 둔다(전체 TOML 미지원).

export interface ConnectorSourcePaths {
  claudeJsonPath?: string;
  codexConfigPath?: string;
}

function defaultCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(home, "config.toml");
}

function defaultGeminiMcpConfigPath(): string {
  return join(homedir(), ".gemini", "config", "mcp_config.json");
}

// ---- 미니 TOML 파서 (codex [mcp_servers.*] 전용) ------------------------------

/** 문자열 리터럴 밖의 주석(#)을 제거한다. */
function stripComment(line: string): string {
  let inBasic = false; // "..."
  let inLiteral = false; // '...'
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') inBasic = true;
    else if (ch === "'") inLiteral = true;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** 테이블 헤더(`mcp_servers.name.env`)를 세그먼트 배열로 분해한다(따옴표 세그먼트 처리). */
function parseTablePath(header: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ".") {
      segments.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current.trim());
  return segments.filter((s) => s.length > 0);
}

function unquoteKey(key: string): string {
  const trimmed = key.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** `[`로 시작하는 배열 텍스트의 대괄호가 균형 잡혔는지(문자열 무시) 확인한다. */
function bracketsBalanced(text: string): boolean {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth === 0;
}

type TomlValue = string | number | boolean | TomlValue[];

function parseTomlValue(text: string): TomlValue | undefined {
  const t = text.trim();
  if (t.length === 0) return undefined;
  if (t.startsWith('"')) {
    const m = /^"((?:\\.|[^"\\])*)"/.exec(t);
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  if (t.startsWith("'")) {
    const m = /^'([^']*)'/.exec(t);
    return m ? m[1] : undefined;
  }
  if (t.startsWith("[")) {
    const inner = t.slice(1, t.lastIndexOf("]"));
    return splitTopLevel(inner)
      .map((part) => parseTomlValue(part))
      .filter((v): v is TomlValue => v !== undefined);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  const num = Number(t);
  return Number.isFinite(num) ? num : undefined;
}

/** 최상위 콤마로만 분할한다(중첩 배열/문자열 내부 콤마 무시). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        if (i + 1 < text.length) current += text[++i];
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      if (current.trim()) parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

interface RawServerFields {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** codex config.toml 텍스트에서 [mcp_servers.*] 서버만 SDK 형태로 파싱한다. */
export function parseCodexMcpServers(toml: string): Record<string, ConfigurableMcpServer> {
  const raw: Record<string, RawServerFields> = {};
  let current: { name: string; sub: "env" | "headers" | null } | null = null;
  const lines = toml.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    if (rawLine === undefined) continue;
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      const path = parseTablePath(header[1] ?? "");
      const name = path[1];
      if (path[0] === "mcp_servers" && name) {
        const seg = path[2];
        const sub = seg === "env" ? "env" : seg === "headers" ? "headers" : null;
        current = { name, sub };
        raw[name] ??= {};
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;

    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = unquoteKey(kv[1] ?? "");
    let valueText = kv[2] ?? "";
    // 단일 줄을 넘는 배열은 대괄호 균형이 맞을 때까지 다음 줄을 이어 붙인다.
    if (valueText.trimStart().startsWith("[") && !bracketsBalanced(valueText)) {
      while (i + 1 < lines.length && !bracketsBalanced(valueText)) {
        valueText += `\n${stripComment(lines[++i] ?? "").trim()}`;
      }
    }
    const value = parseTomlValue(valueText);
    if (value === undefined) continue;

    const fields = raw[current.name];
    if (!fields) continue;
    if (current.sub === "env" || current.sub === "headers") {
      if (typeof value === "string") {
        const bag = current.sub === "env" ? (fields.env ??= {}) : (fields.headers ??= {});
        bag[key] = value;
      }
      continue;
    }
    if (key === "command" && typeof value === "string") fields.command = value;
    else if (key === "args" && Array.isArray(value)) {
      fields.args = value.filter((v): v is string => typeof v === "string");
    } else if (key === "type" && typeof value === "string") fields.type = value;
    else if (key === "url" && typeof value === "string") fields.url = value;
    // startup_timeout_sec 등 나머지 키는 무시한다.
  }

  const result: Record<string, ConfigurableMcpServer> = {};
  for (const [name, fields] of Object.entries(raw)) {
    const normalized = fields.url
      ? {
          type: fields.type ?? "http",
          url: fields.url,
          ...(fields.headers ? { headers: fields.headers } : {})
        }
      : {
          command: fields.command,
          ...(fields.args ? { args: fields.args } : {}),
          ...(fields.env ? { env: fields.env } : {})
        };
    const server = parseMcpServerEntry(normalized);
    if (server) result[name] = server;
  }
  return result;
}

export function loadCodexMcpServers(
  configPath = defaultCodexConfigPath()
): Record<string, ConfigurableMcpServer> {
  try {
    return parseCodexMcpServers(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 모든 소스(claude.json + codex config)에서 MCP 커넥터를 병합한다(타임아웃 미적용).
 * 같은 이름이면 claude.json이 우선한다(Claude의 네이티브 위치).
 */
export function loadMergedConnectors(
  paths: ConnectorSourcePaths = {}
): Record<string, ConfigurableMcpServer> {
  const codex = loadCodexMcpServers(paths.codexConfigPath ?? defaultCodexConfigPath());
  const claude = paths.claudeJsonPath
    ? loadClaudeJsonServers(paths.claudeJsonPath)
    : loadClaudeJsonServers();
  // 같은 이름이면 claude.json이 우선한다.
  return { ...codex, ...claude };
}

/** Claude Agent SDK에 넘길 mcpServers(병합 + 타임아웃/alwaysLoad 적용)를 만든다. */
export function loadClaudeConnectors(
  generalTimeoutMs: number,
  longRunningTimeoutMs: number,
  longRunningServers: ReadonlySet<string>,
  paths: ConnectorSourcePaths = {}
): Record<string, McpServerConfig> {
  const merged = loadMergedConnectors(paths);
  const result: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(merged)) {
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

// ---- agy(antigravity / Gemini) 동기화 ----------------------------------------

interface GeminiServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
}

/** SDK McpServerConfig를 Gemini/antigravity mcp_config.json 서버 형태로 변환한다. */
export function toGeminiServer(server: McpServerConfig): GeminiServer {
  const s = server as Record<string, unknown>;
  if (s.type === "http") {
    return {
      httpUrl: s.url as string,
      ...(s.headers ? { headers: s.headers as Record<string, string> } : {})
    };
  }
  if (s.type === "sse") {
    return {
      url: s.url as string,
      ...(s.headers ? { headers: s.headers as Record<string, string> } : {})
    };
  }
  return {
    command: s.command as string,
    ...(s.args ? { args: s.args as string[] } : {}),
    ...(s.env ? { env: s.env as Record<string, string> } : {})
  };
}

export function toGeminiMcpConfig(
  merged: Record<string, McpServerConfig>
): { mcpServers: Record<string, GeminiServer> } {
  const mcpServers: Record<string, GeminiServer> = {};
  for (const [name, server] of Object.entries(merged)) {
    mcpServers[name] = toGeminiServer(server);
  }
  return { mcpServers };
}

/**
 * 병합 커넥터를 agy가 읽는 ~/.gemini/config/mcp_config.json에 동기화한다.
 * 기존 파일의 사용자 정의 서버와 다른 최상위 키는 보존하고, 관리 대상 서버를 덮어쓴다.
 * 내용이 바뀐 경우에만 파일을 쓰며, 변경 여부를 반환한다.
 */
export function syncAgyMcpConfig(
  merged: Record<string, McpServerConfig>,
  geminiMcpConfigPath = defaultGeminiMcpConfigPath()
): { changed: boolean; count: number } {
  const desired = toGeminiMcpConfig(merged).mcpServers;
  const count = Object.keys(desired).length;
  if (count === 0) return { changed: false, count: 0 };

  let existing: Record<string, unknown> = {};
  try {
    const text = readFileSync(geminiMcpConfigPath, "utf8").trim();
    if (text) existing = JSON.parse(text) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const existingServers =
    existing.mcpServers && typeof existing.mcpServers === "object"
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const next = { ...existing, mcpServers: { ...existingServers, ...desired } };

  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  let prevText = "";
  try {
    prevText = readFileSync(geminiMcpConfigPath, "utf8");
  } catch {
    prevText = "";
  }
  if (nextText === prevText) return { changed: false, count };

  mkdirSync(dirname(geminiMcpConfigPath), { recursive: true });
  writeFileSync(geminiMcpConfigPath, nextText, { mode: 0o600 });
  return { changed: true, count };
}
