// 제공자별 실행 환경·권한 매핑 헬퍼. SessionManager 본체에서 분리한 순수 함수 모음으로
// 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을 재export하므로 기존
// import 경로("./session-manager.js")는 변하지 않는다.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadMergedConnectors, syncCodexMcpConfig } from "./connectors.js";
import { sharedCodexLiteAgentPath } from "./resource-sync.js";
import { projectSourceDir } from "./runtime-paths.js";
import type { SessionRecord } from "./types.js";

function prependCurrentNodeBin(pathValue: string | undefined): string {
  const nodeBin = dirname(process.execPath);
  if (!pathValue) return `${nodeBin}:/usr/bin:/bin`;
  const entries = pathValue.split(":").filter(Boolean);
  return entries.includes(nodeBin) ? pathValue : [nodeBin, ...entries].join(":");
}

export function buildCodexEnvironment(
  targetHome?: string,
  source: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if ([
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_API_BASE"
    ].includes(key)) {
      continue;
    }
    result[key] = value;
  }
  result["PATH"] = prependCurrentNodeBin(result["PATH"]);
  // 다중 계정: 선택된 계정의 CODEX_HOME으로 강제 덮어쓴다. SDK에 env를 통째로 넘기면
  // 자식 프로세스는 process.env를 상속하지 않으므로, 여기서 지정한 값이 인증 디렉터리를 결정한다.
  if (targetHome && targetHome.trim()) {
    result["CODEX_HOME"] = targetHome;
  }
  return result;
}

export function requireCodexSubscriptionAuth(
  home?: string,
  source: NodeJS.ProcessEnv = process.env
): void {
  // 명시된 계정 홈이 있으면 그 홈을, 없으면 기존 단일 계정 해석(CODEX_HOME 또는 ~/.codex)을 검사한다.
  const codexHome = home?.trim() || source.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const authPath = join(codexHome, "auth.json");
  let auth: unknown;
  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
  } catch {
    throw new Error(
      "Codex 구독 로그인을 확인할 수 없습니다. 로컬 Codex CLI에서 Sign in with ChatGPT를 완료하세요."
    );
  }
  if (
    typeof auth !== "object"
    || auth === null
    || Array.isArray(auth)
    || (auth as Record<string, unknown>)["auth_mode"] !== "chatgpt"
  ) {
    throw new Error(
      "Codex API 키 인증은 허용하지 않습니다. Codex CLI를 ChatGPT 구독 계정으로 로그인하세요."
    );
  }
}

export function codexSharedResourceConfig() {
  const liteAgent = sharedCodexLiteAgentPath();
  return {
    // Codex native collaboration tools are enabled explicitly so ChatKJB sessions do not
    // depend on a provider-home default. Direct children only. max_threads는 루트를 제외한
    // 열려 있는 자식 수를 세므로, 결과 취합 뒤 close_agent로 슬롯을 반환해야 한다.
    features: { memories: true, multi_agent: true },
    agents: {
      max_threads: 3,
      max_depth: 1,
      // Codex child sessions otherwise inherit every root MCP and multiply the local stdio
      // process set by the number of active subagents. Root tools stay unchanged; repository
      // exploration/review children use a generated MCP-free role layer.
      default: {
        description: "Lightweight ChatKJB child for bounded repository work.",
        config_file: liteAgent
      },
      explorer: {
        description: "Lightweight ChatKJB explorer without external MCP startup.",
        config_file: liteAgent
      },
      worker: {
        description: "Lightweight ChatKJB worker without external MCP startup.",
        config_file: liteAgent
      }
    },
    memories: {
      generate_memories: true,
      use_memories: true
    }
  };
}

export interface CodexMcpConfigEnsureOptions {
  primaryConfig?: string;
  connectorRegistry?: string;
  wrapperScript?: string;
  nodeExecutable?: string;
}

export function ensureCodexMcpConfigForHome(
  targetHome?: string,
  options: CodexMcpConfigEnsureOptions = {}
): void {
  const trimmedHome = targetHome?.trim();
  if (!trimmedHome) return;

  const primaryConfig = options.primaryConfig ?? join(homedir(), ".codex", "config.toml");
  const accountConfig = join(trimmedHome, "config.toml");
  if (accountConfig === primaryConfig) return;

  const connectorRegistry = options.connectorRegistry
    ?? join(homedir(), ".claude", "shared-resources", "connectors.json");
  const wrapperScript = options.wrapperScript
    ?? join(projectSourceDir(), "scripts", "run-shared-mcp.mjs");
  const connectors = loadMergedConnectors({
    claudeJsonPath: join(homedir(), ".claude.json"),
    codexConfigPath: primaryConfig,
    pluginCachePath: join(homedir(), ".codex", "plugins", "cache")
  });
  syncCodexMcpConfig(
    connectors,
    accountConfig,
    options.nodeExecutable ?? process.execPath,
    wrapperScript,
    connectorRegistry,
    ["--single-owner-per-parent"]
  );
}

export function codexSandboxMode(mode: SessionRecord["permissionMode"]):
  "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "plan") return "read-only";
  if (mode === "default" || mode === "acceptEdits") return "workspace-write";
  return "danger-full-access";
}

export function agyPermissionArgs(mode: SessionRecord["permissionMode"]): string[] {
  return mode === "auto" || mode === "dontAsk"
    ? ["--dangerously-skip-permissions"]
    : ["--sandbox", "--dangerously-skip-permissions"];
}

export function buildClaudeEnvironment(
  oauthToken: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  mcpToolTimeoutMs?: number
): Record<string, string | undefined> {
  return {
    ...baseEnvironment,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    ...(mcpToolTimeoutMs
      ? {
        MCP_TIMEOUT: String(mcpToolTimeoutMs),
        MCP_TOOL_TIMEOUT: String(mcpToolTimeoutMs)
      }
      : {})
  };
}
