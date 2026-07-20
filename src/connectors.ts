import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  pluginCachePath?: string;
  connectorRegistryPath?: string;
}

// Codex 데스크톱 전용 MCP는 다른 제공자가 실행할 수 없고, 계정별 UI/권한 상태를 공유
// 레지스트리에 끌어들인다. ChatKJB 공용 커넥터에는 이식 가능한 서버만 남긴다.
export const PROVIDER_NATIVE_MCP_SERVER_NAMES = new Set([
  "codex",
  "computer-use",
  "node_repl",
  "sites-design-picker"
]);

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
  let current: { name: string; sub: "env" | "headers" | null; } | null = null;
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
    return parseCodexMcpServers(stripManagedCodexBlock(readFileSync(configPath, "utf8")));
  } catch {
    return {};
  }
}

function findPluginMcpFiles(root: string, output: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) findPluginMcpFiles(path, output);
    else if (entry.isFile() && entry.name === ".mcp.json") output.push(path);
  }
}

function resolvePluginScopedPath(root: string, value: string): string | null {
  if (!value.startsWith(".")) return value;
  const scopedRoot = resolve(root);
  const resolved = resolve(scopedRoot, value);
  const offset = relative(scopedRoot, resolved);
  if (offset === "" || offset.startsWith("..") || isAbsolute(offset)) return null;
  return resolved;
}

export function loadPluginMcpServers(
  cacheRoot = join(homedir(), ".codex", "plugins", "cache")
): Record<string, ConfigurableMcpServer> {
  const files: string[] = [];
  findPluginMcpFiles(cacheRoot, files);
  const result: Record<string, ConfigurableMcpServer> = {};
  for (const file of files.sort()) {
    let payload: { mcpServers?: Record<string, Record<string, unknown>>; };
    try {
      payload = JSON.parse(readFileSync(file, "utf8")) as typeof payload;
    } catch {
      continue;
    }
    const root = dirname(file);
    for (const [name, raw] of Object.entries(payload.mcpServers ?? {})) {
      const normalized = { ...raw };
      let invalidPath = false;
      if (typeof normalized.command === "string") {
        const command = resolvePluginScopedPath(root, normalized.command);
        if (command === null) invalidPath = true;
        else normalized.command = command;
      }
      if (Array.isArray(normalized.args)) {
        normalized.args = normalized.args.map((arg) => {
          if (typeof arg !== "string") return arg;
          const resolved = resolvePluginScopedPath(root, arg);
          if (resolved === null) invalidPath = true;
          return resolved ?? arg;
        });
      }
      if (invalidPath) continue;
      const server = parseMcpServerEntry(normalized);
      if (server) result[name] = server;
    }
  }
  return result;
}

/**
 * 모든 소스(claude.json + codex config)에서 MCP 커넥터를 병합한다(타임아웃 미적용).
 * 같은 이름이면 claude.json이 우선한다(Claude의 네이티브 위치).
 */
export function loadMergedConnectors(
  paths: ConnectorSourcePaths = {}
): Record<string, ConfigurableMcpServer> {
  const customPaths = Boolean(
    paths.claudeJsonPath
    || paths.codexConfigPath
    || paths.pluginCachePath
  );
  const plugins = paths.pluginCachePath
    ? loadPluginMcpServers(paths.pluginCachePath)
    : customPaths
      ? {}
      : loadPluginMcpServers();
  const codex = loadCodexMcpServers(paths.codexConfigPath ?? defaultCodexConfigPath());
  const claude = paths.claudeJsonPath
    ? loadClaudeJsonServers(paths.claudeJsonPath)
    : loadClaudeJsonServers();
  // 같은 이름이면 claude.json이 우선한다.
  return Object.fromEntries(
    Object.entries({ ...plugins, ...codex, ...claude }).filter(
      ([name]) => !PROVIDER_NATIVE_MCP_SERVER_NAMES.has(name)
    )
  );
}

function defaultSharedConnectorRegistryPath(): string {
  return join(homedir(), ".claude", "shared-resources", "connectors.json");
}

function loadSharedConnectorRegistry(
  registryPath: string
): Record<string, ConfigurableMcpServer> {
  let payload: Record<string, Record<string, unknown>>;
  try {
    payload = JSON.parse(readFileSync(registryPath, "utf8")) as typeof payload;
  } catch {
    return {};
  }
  const result: Record<string, ConfigurableMcpServer> = {};
  for (const [name, raw] of Object.entries(payload)) {
    if (PROVIDER_NATIVE_MCP_SERVER_NAMES.has(name)) continue;
    const server = parseMcpServerEntry(raw);
    if (server) result[name] = server;
  }
  return result;
}

/** Claude Agent SDK에 넘길 mcpServers(병합 + 타임아웃/alwaysLoad 적용)를 만든다. */
export function loadClaudeConnectors(
  generalTimeoutMs: number,
  longRunningTimeoutMs: number,
  longRunningServers: ReadonlySet<string>,
  paths: ConnectorSourcePaths = {}
): Record<string, McpServerConfig> {
  const customPaths = Object.keys(paths).length > 0;
  const registryPath = paths.connectorRegistryPath
    ?? (customPaths ? undefined : defaultSharedConnectorRegistryPath());
  const merged = {
    ...(registryPath ? loadSharedConnectorRegistry(registryPath) : {}),
    ...loadMergedConnectors(paths)
  };
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
  serverUrl?: string;
  headers?: Record<string, string>;
}

function sharedWrapperServer(
  name: string,
  nodeExecutable: string,
  wrapperScript: string,
  connectorRegistry: string
): GeminiServer {
  return {
    command: nodeExecutable,
    args: [wrapperScript, connectorRegistry, name]
  };
}

/** SDK McpServerConfig를 Gemini/antigravity mcp_config.json 서버 형태로 변환한다. */
export function toGeminiServer(
  server: McpServerConfig,
  name?: string,
  nodeExecutable?: string,
  wrapperScript?: string,
  connectorRegistry?: string
): GeminiServer {
  const s = server as Record<string, unknown>;
  if (s.type === "http") {
    return {
      serverUrl: s.url as string,
      ...(s.headers ? { headers: s.headers as Record<string, string> } : {})
    };
  }
  if (s.type === "sse") {
    return {
      serverUrl: s.url as string,
      ...(s.headers ? { headers: s.headers as Record<string, string> } : {})
    };
  }
  if (name && nodeExecutable && wrapperScript && connectorRegistry) {
    return sharedWrapperServer(name, nodeExecutable, wrapperScript, connectorRegistry);
  }
  return {
    command: s.command as string,
    ...(s.args ? { args: s.args as string[] } : {}),
    ...(s.env ? { env: s.env as Record<string, string> } : {})
  };
}

export function toGeminiMcpConfig(
  merged: Record<string, McpServerConfig>,
  nodeExecutable?: string,
  wrapperScript?: string,
  connectorRegistry?: string
): { mcpServers: Record<string, GeminiServer>; } {
  const mcpServers: Record<string, GeminiServer> = {};
  for (const [name, server] of Object.entries(merged)) {
    mcpServers[name] = toGeminiServer(
      server,
      name,
      nodeExecutable,
      wrapperScript,
      connectorRegistry
    );
  }
  return { mcpServers };
}

const CODEX_MANAGED_START = "# BEGIN ChatKJB shared MCP";
const CODEX_MANAGED_END = "# END ChatKJB shared MCP";
const CODEX_SELF_MCP_SERVER = "codex";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}

function stripManagedCodexBlock(text: string): string {
  return text
    .replace(/^# BEGIN .* shared MCP\n[\s\S]*?^# END .* shared MCP\n?/gm, "")
    .trimEnd();
}

export function syncCodexMcpConfig(
  merged: Record<string, McpServerConfig>,
  codexConfigPath: string,
  nodeExecutable: string,
  wrapperScript: string,
  connectorRegistry: string,
  wrapperArgs: readonly string[] = []
): { changed: boolean; count: number; } {
  let existing = "";
  try {
    existing = readFileSync(codexConfigPath, "utf8");
  } catch {
    existing = "";
  }
  const native = parseCodexMcpServers(stripManagedCodexBlock(existing));
  const lines = [CODEX_MANAGED_START];
  let count = 0;
  for (const [name, server] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    if (native[name] || name === CODEX_SELF_MCP_SERVER) continue;
    const value = server as Record<string, unknown>;
    lines.push("", `[mcp_servers.${tomlKey(name)}]`);
    if (value.type === "http" || value.type === "sse") {
      lines.push(`url = ${tomlString(String(value.url))}`);
    } else {
      lines.push(`command = ${tomlString(nodeExecutable)}`);
      lines.push(
        `args = [${[wrapperScript, connectorRegistry, name, ...wrapperArgs].map(tomlString).join(", ")}]`
      );
    }
    lines.push("startup_timeout_sec = 120");
    count += 1;
  }
  lines.push("", CODEX_MANAGED_END);
  const base = stripManagedCodexBlock(existing);
  const next = `${base}${base ? "\n\n" : ""}${lines.join("\n")}\n`;
  if (next === existing) return { changed: false, count };
  mkdirSync(dirname(codexConfigPath), { recursive: true });
  writeFileSync(codexConfigPath, next, { mode: 0o600 });
  return { changed: true, count };
}

/**
 * 병합 커넥터를 agy가 읽는 ~/.gemini/config/mcp_config.json에 동기화한다.
 * 기존 파일의 사용자 정의 서버와 다른 최상위 키는 보존하고, 관리 대상 서버를 덮어쓴다.
 * 내용이 바뀐 경우에만 파일을 쓰며, 변경 여부를 반환한다.
 */
export function syncAgyMcpConfig(
  merged: Record<string, McpServerConfig>,
  geminiMcpConfigPath = defaultGeminiMcpConfigPath(),
  nodeExecutable?: string,
  wrapperScript?: string,
  connectorRegistry?: string,
  managedNames: ReadonlySet<string> = new Set(Object.keys(merged))
): { changed: boolean; count: number; } {
  const desired = toGeminiMcpConfig(
    merged,
    nodeExecutable,
    wrapperScript,
    connectorRegistry
  ).mcpServers;
  const count = Object.keys(desired).length;

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
  const preservedServers = Object.fromEntries(
    Object.entries(existingServers).filter(([name, server]) => {
      if (managedNames.has(name) && !Object.prototype.hasOwnProperty.call(desired, name)) {
        return false;
      }
      if (!wrapperScript || !connectorRegistry) return true;
      if (!server || typeof server !== "object" || Array.isArray(server)) return true;
      const value = server as Record<string, unknown>;
      return !(
        Array.isArray(value.args)
        && value.args[0] === wrapperScript
        && value.args[1] === connectorRegistry
      );
    })
  );
  if (desired.dataAnalyticsWidgets && !desired.datascienceWidgets) {
    delete preservedServers.datascienceWidgets;
  }
  let prevText = "";
  try {
    prevText = readFileSync(geminiMcpConfigPath, "utf8");
  } catch {
    prevText = "";
  }
  if (count === 0 && prevText === "") return { changed: false, count };

  const next = { ...existing, mcpServers: { ...preservedServers, ...desired } };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (nextText === prevText) return { changed: false, count };

  mkdirSync(dirname(geminiMcpConfigPath), { recursive: true });
  writeFileSync(geminiMcpConfigPath, nextText, { mode: 0o600 });
  return { changed: true, count };
}

// ---- Cline SDK 동기화 -------------------------------------------------------

interface ClineTransport {
  type?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

interface ClineServer {
  transport?: ClineTransport;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

const CLINE_MANAGED_METADATA_KEY = "chatkjbSharedMcp";
const CLINE_MANAGED_METADATA_VERSION = 1;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isChatKjbManagedClineServer(value: unknown): value is ClineServer {
  const server = objectRecord(value);
  const metadata = objectRecord(server?.metadata);
  return metadata?.[CLINE_MANAGED_METADATA_KEY] === CLINE_MANAGED_METADATA_VERSION;
}

function clineTransport(
  server: McpServerConfig,
  name: string,
  nodeExecutable: string,
  wrapperScript: string,
  connectorRegistry: string,
  existing?: ClineTransport
): ClineTransport {
  const value = server as Record<string, unknown>;
  if (value.type === "http" || value.type === "sse") {
    const compatibleExisting = { ...(existing ?? {}) };
    delete compatibleExisting.command;
    delete compatibleExisting.args;
    delete compatibleExisting.cwd;
    delete compatibleExisting.env;
    const desiredHeaders = objectRecord(value.headers) as Record<string, string> | null;
    const existingHeaders = objectRecord(existing?.headers) as Record<string, string> | null;
    const headers = { ...(desiredHeaders ?? {}), ...(existingHeaders ?? {}) };
    return {
      ...compatibleExisting,
      type: value.type === "sse" ? "sse" : "streamableHttp",
      url: String(value.url),
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    };
  }
  const compatibleExisting = { ...(existing ?? {}) };
  delete compatibleExisting.url;
  delete compatibleExisting.headers;
  return {
    ...compatibleExisting,
    type: "stdio",
    command: nodeExecutable,
    args: [wrapperScript, connectorRegistry, name]
  };
}

/**
 * 공유 커넥터를 Cline SDK의 native MCP 설정에 병합한다.
 *
 * ChatKJB가 만든 항목만 metadata 표식으로 갱신·정리한다. 같은 이름의 사용자 항목과 다른
 * 최상위 설정은 그대로 보존하며, 관리 항목 안에서도 disabled·oauth·사용자 metadata·env/cwd와
 * 같은 Cline 설정을 유지한다. stdio 서버의 실제 env/비밀은 0600 공유 registry를 읽는 wrapper에
 * 남겨 Cline 설정에 복제하지 않는다.
 */
export function syncClineMcpConfig(
  merged: Record<string, McpServerConfig>,
  clineMcpConfigPath: string,
  nodeExecutable: string,
  wrapperScript: string,
  connectorRegistry: string
): { changed: boolean; count: number; } {
  let previousText = "";
  let existing: Record<string, unknown> = {};
  try {
    previousText = readFileSync(clineMcpConfigPath, "utf8");
    const parsed = previousText.trim() ? JSON.parse(previousText) : {};
    const record = objectRecord(parsed);
    if (!record) throw new Error("Cline MCP 설정의 최상위 값은 객체여야 합니다.");
    existing = record;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(
        `기존 Cline MCP 설정을 보존할 수 없어 동기화를 중단했습니다: ${clineMcpConfigPath}`,
        { cause: error }
      );
    }
  }

  const existingServers = existing.mcpServers === undefined
    ? {}
    : objectRecord(existing.mcpServers);
  if (!existingServers) {
    throw new Error(
      `기존 Cline MCP 설정을 보존할 수 없어 동기화를 중단했습니다: ${clineMcpConfigPath}`
    );
  }
  const nextServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(existingServers)) {
    if (!isChatKjbManagedClineServer(server)) nextServers[name] = server;
  }

  let count = 0;
  for (const [name, server] of Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))) {
    const current = existingServers[name];
    if (current !== undefined && !isChatKjbManagedClineServer(current)) continue;
    const managed = objectRecord(current) as ClineServer | null;
    const existingTransport = objectRecord(managed?.transport) as ClineTransport | null;
    const metadata = {
      ...(objectRecord(managed?.metadata) ?? {}),
      [CLINE_MANAGED_METADATA_KEY]: CLINE_MANAGED_METADATA_VERSION
    };
    const desiredTransport = clineTransport(
      server,
      name,
      nodeExecutable,
      wrapperScript,
      connectorRegistry,
      existingTransport ?? undefined
    );
    nextServers[name] = {
      ...(managed ?? {}),
      transport: desiredTransport,
      metadata
    };
    count += 1;
  }

  if (count === 0 && previousText === "") return { changed: false, count };
  const next = { ...existing, mcpServers: nextServers };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  if (nextText === previousText) {
    chmodSync(clineMcpConfigPath, 0o600);
    return { changed: false, count };
  }
  mkdirSync(dirname(clineMcpConfigPath), { recursive: true });
  const temporary = `${clineMcpConfigPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temporary, nextText, { mode: 0o600, flag: "wx" });
    renameSync(temporary, clineMcpConfigPath);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { changed: true, count };
}
