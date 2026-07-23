// 제공자별 실행 환경·권한 매핑 헬퍼. SessionManager 본체에서 분리한 순수 함수 모음으로
// 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을 재export하므로 기존
// import 경로("./session-manager.js")는 변하지 않는다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { loadMergedConnectors, syncCodexMcpConfig } from "./connectors.js";
import { sharedCodexLiteAgentPath } from "./resource-sync.js";
import { projectSourceDir } from "./runtime-paths.js";
import { qwenSubagentProcessConfig, QWEN_SUBAGENT_SERVER_NAME } from "./qwen-subagent.js";
import type { SessionRecord } from "./types.js";

// provider CLI(codex 등)는 보통 Node와 같은 bin 디렉터리에 설치된다. 그래서 실행 중인
// Node의 bin을 PATH 앞에 붙여 왔다.
//
// 데몬은 macOS 권한 화면 식별을 위해 Node를 복사해 넣은 ChatKJB.app 번들로 실행되므로,
// process.execPath는 번들 안(.../Contents/MacOS)을 가리킨다. 그 디렉터리에는 CLI가 없어
// 이것만 쓰면 `spawn codex ENOENT`가 난다. LaunchAgent가 설치 시점의 실제 Node bin을
// CHATKJB_NODE_BIN으로 넘겨 주므로 그 값을 함께 넣는다.
function nodeBinCandidates(source: NodeJS.ProcessEnv): string[] {
  const candidates = [dirname(process.execPath)];
  const recorded = source.CHATKJB_NODE_BIN?.trim();
  if (recorded) candidates.unshift(recorded);
  return [...new Set(candidates.filter(Boolean))];
}

function prependCurrentNodeBin(
  pathValue: string | undefined,
  source: NodeJS.ProcessEnv = process.env
): string {
  const nodeBins = nodeBinCandidates(source);
  if (!pathValue) return [...nodeBins, "/usr/bin", "/bin"].join(":");
  const entries = pathValue.split(":").filter(Boolean);
  const missing = nodeBins.filter((bin) => !entries.includes(bin));
  return missing.length === 0 ? pathValue : [...missing, ...entries].join(":");
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
  result["PATH"] = prependCurrentNodeBin(result["PATH"], source);
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

export function codexSharedResourceConfig(
  subagentModel?: string | null,
  qwenSubagentModel?: string | null,
  subagentReasoning?: string | null,
  cwd?: string | null
) {
  const liteAgent = subagentModel && !qwenSubagentModel
    ? pinnedCodexChildAgentPath(subagentModel, subagentReasoning)
    : sharedCodexLiteAgentPath();
  return {
    // Codex native collaboration tools are enabled explicitly so ChatKJB sessions do not
    // depend on a provider-home default. Direct children only. max_threads는 루트를 제외한
    // 열려 있는 자식 수를 세므로, 결과 취합 뒤 close_agent로 슬롯을 반환해야 한다.
    // Token Plan Qwen은 Codex native child provider로 실행할 수 없다. Qwen을 선택한
    // 세션에서 native collaboration을 켜 두면 spawn_agent가 부모 GPT 모델을 상속해
    // 패널 선택을 우회하므로, 해당 경로를 완전히 끄고 아래의 전용 MCP만 허용한다.
    features: { memories: true, multi_agent: !qwenSubagentModel },
    agents: {
      max_threads: 4,
      max_depth: 1,
      ...(subagentModel && !qwenSubagentModel ? { default_subagent_model: subagentModel } : {}),
      ...(subagentReasoning && !qwenSubagentModel
        ? { default_subagent_reasoning_effort: subagentReasoning }
        : {}),
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
    },
    // Qwen Token Plan은 Codex native child model provider로 전달할 수 없다. 선택된 경우
    // 루트에만 짧은 전용 MCP를 붙이고, GPT 루트가 이 도구로 위임·검증한다.
    ...(qwenSubagentModel ? {
      mcp_servers: {
        [QWEN_SUBAGENT_SERVER_NAME]: qwenSubagentProcessConfig(qwenSubagentModel, cwd ?? undefined)
      }
    } : {})
  };
}

/**
 * Codex agent 파일의 model/model_reasoning_effort는 spawn 인자보다 우선한다. 따라서
 * 선택한 하위 모델을 실제 강제하려면 [agents] 기본값만 두지 않고 각 built-in 역할이
 * 참조하는 세션 전용 agent file에도 같은 값을 적어야 한다.
 */
export function pinnedCodexChildAgentPath(model: string, reasoning?: string | null): string {
  const base = readFileSync(sharedCodexLiteAgentPath(), "utf8").trimEnd();
  const content = [
    base,
    "",
    `model = ${JSON.stringify(model)}`,
    ...(reasoning ? [`model_reasoning_effort = ${JSON.stringify(reasoning)}`] : []),
    ""
  ].join("\n");
  const directory = join(tmpdir(), "chatkjb-codex-agents");
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 20);
  const path = join(directory, `pinned-${digest}.toml`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    writeFileSync(path, content, "utf8");
  }
  return path;
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
