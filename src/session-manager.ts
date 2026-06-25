import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  deleteSession as deleteClaudeSession,
  query,
  renameSession,
  type HookCallback,
  type EffortLevel,
  type Options,
  type Query,
  type ThinkingConfig,
  type SDKUserMessage,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type ThreadItem, type Usage as CodexSdkUsage } from "@openai/codex-sdk";
import { InlineKeyboard } from "grammy";
import {
  isRetryableMcpError,
  mcpCallKey,
  mcpServerName
} from "./mcp-policy.js";
import {
  loadClaudeConnectors
} from "./connectors.js";
import { PermissionBroker } from "./permission-broker.js";
import { StateStore } from "./store.js";
import { StreamRenderer } from "./stream-renderer.js";
import { safeErrorMessage } from "./telegram-transport.js";
import { TokenPool } from "./token-pool.js";
import { CodexAccountPool } from "./codex-account-pool.js";
import {
  estimateGoalRisk,
  normalizeGoalCondition,
  parseGoalChecks,
  parseGoalVerdict,
  runGoalChecks,
  type CheckRunResult
} from "./goal-checks.js";
import type { RiskLevel } from "./orchestration/types.js";
import {
  sharedMemoryBridgePath,
  sharedResourceGuidePath,
  syncSharedResources
} from "./resource-sync.js";
import {
  agyModelLabel,
  codexModelLabel,
  codexReasoningLabel,
  DEFAULT_AGY_MODEL,
  DEFAULT_AGY_THINKING_LEVEL,
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING,
  DEFAULT_THINKING_LEVEL,
  type CodexReasoningEffort,
  type ModelCatalog,
  modelLabel,
  normalizeThinkingForModel,
  thinkingLabel
} from "./model-catalog.js";
import type {
  MessageTransport,
  CodexAccountUsageSnapshot,
  CodexUsageSnapshot,
  ProjectConfig,
  ProviderKind,
  SessionRecord,
  UsageSnapshot
} from "./types.js";
import {
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "./usage.js";
import { AgyInteractiveSession, type AgyAttachment, type AgyLiveStatus } from "./agy-interactive.js";
import {
  buildJudgePrompt,
  buildSynthesisPrompt,
  parseJudgeResponse,
  type JudgeCandidate,
  type JudgeVerdict
} from "./judge.js";

// 일시적 과부하(Overloaded/5xx) 자동 재시도 상한과 백오프(지수, 상한 60초).
const MAX_OVERLOAD_RETRIES = 5;
const OVERLOAD_RETRY_BASE_MS = 5_000;
const OVERLOAD_RETRY_CAP_MS = 60_000;
// 모든 토큰이 한도에 도달했을 때, 가장 먼저 회복되는 시각 이후로 자동 재개를 미루는 여유분.
// 한도 초기화 직후의 미세한 시계 오차로 또 거부당하는 것을 막는다.
const LIMIT_RESUME_BUFFER_MS = 10_000;
// /goal: 한 목표를 향해 자동으로 이어 도는 최대 턴 수(폭주·무한 반복 방지).
// Structure2.md는 고정 턴 상한 대신 Risk_Level별 checkpoint 경로로 진행을 통제한다.
// 위험도를 추정할 수 없을 때(자유서술형 목표 등)의 안전 상한으로만 남긴다.
export const MAX_GOAL_ROUNDS = 25;
// Risk_Level별 자동 진행 턴 상한. checkpointsForRisk 단계 수에 여유를 둔 값으로,
// L0(사소)는 짧게, L4(치명)는 길게 둔다. classifyRisk로 목표 위험도를 추정해 선택한다.
const GOAL_ROUNDS_BY_RISK: Record<RiskLevel, number> = {
  L0: 3,
  L1: 6,
  L2: 12,
  L3: 20,
  L4: 30
};
// /synth 다중후보 판관. 후보 생성·통합과 별개로 심사만 고정 고성능 모델(Opus 4.8 high)에
// 맡긴다. Opus 판관이 실패하면 다른 모델로 폴백하지 않고 첫 후보를 그대로 채택한다.
// /goal 평가와는 무관하다(Tier 5 판관 = 세션 모델).
const SYNTH_JUDGE_CLAUDE_MODEL = "claude-opus-4-8";
const SYNTH_JUDGE_CLAUDE_THINKING = "high";
const SYNTH_JUDGE_CLAUDE_EFFORT = "high";
const CODEX_ACCOUNT_STATE_SETTING = "codex.accountState.v1";
export const CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export const CODEX_MODEL = DEFAULT_CODEX_MODEL;
export const CODEX_REASONING_EFFORT = DEFAULT_CODEX_REASONING;
export const CLAUDE_THINKING = { type: "adaptive" } as const;

export function resolveThinkingConfig(level: string | null | undefined): ThinkingConfig {
  switch (level) {
    case "off":
      return { type: "disabled" };
    case "adaptive":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
    default:
      return { type: "adaptive" };
  }
}

export function resolveClaudeEffort(level: string | null | undefined): EffortLevel | undefined {
  switch (level) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return level;
    default:
      return undefined;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 6: agy 네이티브 멀티모달 첨부 헬퍼
//
// handleFile(bot.ts)이 생성하는 fileMessage 형식:
//   [첨부 파일]
//   종류: <type>
//   파일명: <name>
//   저장 경로: <absolutePath>
//   캡션: <caption>   (선택)
//
// 이 형식은 우리 코드가 통제하는 안정적 계약이다. MessageQueue 리팩토링 없이
// executeAgy에서 turnPrompt를 파싱해 첨부 목록을 도출한다(side-channel 불필요).
// ──────────────────────────────────────────────────────────────────────────────

/** 확장자 → MIME 타입 테이블. agy SDK의 SUPPORTED_*_MIMES 집합만 포함한다. */
const EXT_TO_MIME: ReadonlyMap<string, string> = new Map([
  // 이미지 (SUPPORTED_IMAGE_MIMES)
  ["jpg",  "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png",  "image/png"],
  ["webp", "image/webp"],
  ["bmp",  "image/bmp"],
  // 문서 (SUPPORTED_DOCUMENT_MIMES)
  ["pdf",  "application/pdf"],
  ["txt",  "text/plain"],
  ["csv",  "text/csv"],
  ["json", "application/json"],
  ["html", "text/html"],
  ["htm",  "text/html"],
  ["xml",  "text/xml"],
  ["css",  "text/css"],
  ["js",   "text/javascript"],
  ["rtf",  "text/rtf"],
  // 오디오 (SUPPORTED_AUDIO_MIMES)
  ["mp3",  "audio/mpeg"],
  ["m4a",  "audio/m4a"],
  ["wav",  "audio/wav"],
  ["aac",  "audio/aac"],
  ["flac", "audio/flac"],
  ["ogg",  "audio/ogg"],
  ["opus", "audio/opus"],
  // 동영상 (SUPPORTED_VIDEO_MIMES)
  ["mp4",  "video/mp4"],
  ["mov",  "video/quicktime"],
  ["webm", "video/webm"],
  ["avi",  "video/avi"],
  ["mpeg", "video/mpeg"],
  ["mpg",  "video/mpeg"],
  ["3gp",  "video/3gpp"],
  ["wmv",  "video/wmv"],
  ["flv",  "video/x-flv"],
]);

/**
 * 파일 경로의 확장자로 MIME 타입을 반환한다.
 * 알 수 없는 확장자이거나 agy가 지원하지 않는 형식이면 undefined를 반환한다.
 */
export function mimeFromPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME.get(ext);
}

/**
 * agy fileMessage 텍스트에서 '저장 경로: <path>' 줄을 파싱해
 * AgyAttachment 배열을 반환한다. 지원 MIME이 없는 경로는 제외한다.
 *
 * 텍스트 프롬프트는 변경하지 않는다(모델이 파일명·캡션 문맥을 볼 수 있도록).
 * 이 함수는 executeAgy 전용이다. Claude/Codex turn에서는 호출하지 않는다.
 */
export function extractAgyAttachments(prompt: string): AgyAttachment[] {
  const attachments: AgyAttachment[] = [];
  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("저장 경로: ")) continue;
    const filePath = trimmed.slice("저장 경로: ".length).trim();
    if (!filePath) continue;
    const mimeType = mimeFromPath(filePath);
    if (!mimeType) continue; // 지원되지 않는 형식 — 텍스트 폴백 유지
    attachments.push({ path: filePath, mimeType });
  }
  return attachments;
}

export function buildLeanInstructions(enabled: boolean): string {
  if (!enabled) return "";
  return [
    "[LEAN_IMPLEMENTATION_POLICY]",
    "구현 전에 아래 순서에서 처음으로 충분한 해법을 선택한다.",
    "1. 실제로 만들 필요가 없는 요구라면 만들지 않고 이유를 짧게 설명한다.",
    "2. 표준 라이브러리로 해결되면 그것을 사용한다.",
    "3. 운영체제, 런타임, 브라우저, DB 등 플랫폼 기본 기능으로 해결되면 그것을 사용한다.",
    "4. 이미 설치된 의존성으로 해결되면 새 의존성을 추가하지 않는다.",
    "5. 그 다음에만 동작하는 최소 범위의 코드를 작성한다.",
    "요청하지 않은 추상화, 미래용 확장점, 중복 래퍼, 불필요한 설정과 의존성을 만들지 않는다.",
    "단, 신뢰 경계 입력 검증, 보안, 데이터 손실 방지 오류 처리, 접근성, 사용자가 명시한 요구사항과 실행 가능한 검증은 축소하지 않는다."
  ].join("\n");
}

export function buildPublicProgressInstructions(): string {
  return [
    "작업 중에는 내부 사고 과정이나 숨은 reasoning을 노출하지 마십시오.",
    "대신 주요 단계의 시작, 확인된 중간 결과, 다음 행동을 공개 가능한 짧은 진행 설명으로 작성하십시오.",
    "각 진행 설명은 독립된 문단으로 출력하고, 실제 작업 결과와 최종 답변도 명확히 구분하십시오."
  ].join("\n");
}

export function buildPermissionModeInstructions(mode: SessionRecord["permissionMode"]): string {
  if (mode === "plan") {
    return "현재 권한 모드는 plan이다. 파일이나 외부 상태를 변경하지 말고 조사와 실행 계획만 제시한다.";
  }
  if (mode === "default") {
    return "현재 권한 모드는 default이다. 읽기와 안전한 진단은 자율 수행하고, 파괴적 변경·외부 전송·권한 확대가 필요하면 멈추고 사용자 승인을 요청한다.";
  }
  if (mode === "acceptEdits") {
    return "현재 권한 모드는 acceptEdits이다. 프로젝트 내부 파일 편집과 검증은 자율 수행하되, 파괴적 변경·외부 전송·프로젝트 밖 변경은 사용자 승인 없이 하지 않는다.";
  }
  return "현재 권한 모드는 자율 실행이다. 사용자가 지정한 범위 안의 구현·검증은 끝까지 수행하되, 비밀 노출·파괴적 변경·범위 밖 외부 작업은 하지 않는다.";
}

function buildProviderBootstrap(session: SessionRecord, memoryDir: string): string {
  const globalInstructions = loadGlobalInstructions();
  const instructions = loadProjectInstructions(session.cwd);
  return [
    buildKstDateNote(),
    `장기기억은 전역 선별 저장소 ${memoryDir}, Claude 저장소별 자동 메모리 ${join(homedir(), ".claude", "projects")}, Codex 자동 메모리 ${join(homedir(), ".codex", "memories")}에 있다. 작업과 관련 있으면 ${sharedMemoryBridgePath()}를 통해 세 저장소를 함께 읽고 중복을 제거해 활용한다. 명시적 /memory 기록은 전역 선별 저장소에 하고, Claude와 Codex의 자동 메모리는 각자 네이티브 형식으로 유지한다.`,
    buildPublicProgressInstructions(),
    buildPermissionModeInstructions(session.permissionMode),
    `공통 AI 자원 안내는 ${sharedResourceGuidePath()} 에 있다. 먼저 읽고 세 제공자 공통 스킬·커넥터·플러그인 기능·도구 정책을 따른다.`,
    ...(session.leanMode ? [buildLeanInstructions(true)] : []),
    ...(globalInstructions
      ? [`다음 전역 사용자 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${globalInstructions}`]
      : []),
    ...(instructions
      ? [`다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`]
      : [])
  ].join("\n\n");
}

// Claude는 claude_code 프리셋이 날짜를 자동 주입하지만 Codex·agy는 시스템 프롬프트가
// 없어 날짜를 모른다. 첫 턴 memoryNote와 함께 주입해 "오늘/내일" 등 상대 날짜 해석을 보완한다.
function buildKstDateNote(): string {
  const nowKst = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "full",
    timeStyle: "short",
    hour12: false
  }).format(new Date());
  return (
    `현재 시각은 ${nowKst} (KST, UTC+9)이다. "오늘/내일/다음 주" 등 상대 날짜는 `
    + `이 기준으로 해석한다. Google Calendar 이벤트를 만들거나 조회할 때 시간대는 `
    + `항상 Asia/Seoul로 지정하고, start/end의 timeZone 필드에 "Asia/Seoul"을 명시한다.`
  );
}

export class ProgressiveParagraphCollector {
  private emittedLength = 0;

  accept(fullText: string): string[] {
    if (fullText.length < this.emittedLength) this.emittedLength = 0;
    const remaining = fullText.slice(this.emittedLength);
    const boundary = remaining.lastIndexOf("\n\n");
    if (boundary < 0) return [];
    const completed = remaining.slice(0, boundary);
    this.emittedLength += boundary + 2;
    return completed
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  }

  finish(fullText: string): string[] {
    const completed = this.accept(`${fullText}\n\n`);
    this.emittedLength = fullText.length;
    return completed;
  }
}

export function agyRequestsProceed(text: string): boolean {
  return /\bProceed\b[\s\S]{0,100}(?:버튼|승인)/iu.test(text)
    || /(?:진행|승인)[\s\S]{0,50}버튼/u.test(text);
}

export function agyFailureFromLog(log: string): string | null {
  const retry = log.match(/Please retry in ([0-9.]+s)/i)?.[1];
  if (retry) {
    return `Gemini API 무료 분당 한도에 도달했습니다. 약 ${retry} 후 다시 시도하십시오.`;
  }
  const lines = log.split(/\r?\n/).filter((line) =>
    /RESOURCE_EXHAUSTED|Individual quota reached|model unreachable/i.test(line)
  );
  if (lines.length === 0) return null;
  const reset = lines.join("\n").match(/Resets in ([0-9hms]+)/i)?.[1];
  return reset
    ? `선택한 agy 모델의 개인 할당량이 소진되었습니다. 초기화까지 ${reset} 남았습니다. 다른 모델로 바꾸거나 초기화 후 다시 시도하십시오.`
    : "선택한 agy 모델의 개인 할당량이 소진되었습니다. 다른 모델로 바꾸거나 할당량 초기화 후 다시 시도하십시오.";
}

interface RunRequest {
  session: SessionRecord;
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  operation?: "prompt" | "compact";
  // 한도 오류로 다른 계정 토큰에 자동 전환해 재실행한 횟수. 무한 전환을 막는 가드.
  autoSwitchCount?: number;
  // 일시적 과부하(Overloaded/5xx)로 백오프 후 자동 재시도한 횟수. 무한 재시도를 막는 가드.
  retryCount?: number;
  // Codex rollout 유실(no rollout found)로 스레드를 버리고 새 스레드로 재실행한 횟수. 무한 루프 가드.
  rolloutResetCount?: number;
}

interface SessionManagerOptions {
  debounceMs: number;
  claudeCodeOauthToken: string;
  // 한도 도달 시 페일오버할 추가 계정 토큰(선택). 기본 토큰 다음 우선순위로 사용된다.
  additionalOauthTokens?: string[];
  // Codex 계정별 CODEX_HOME 디렉터리 목록(선택). 미지정 시 단일 기본 홈으로 동작한다.
  codexAccountHomes?: string[];
  claudeCodeExecutable?: string;
  // agy(Antigravity CLI) 바이너리 경로. 데몬 PATH에 ~/.local/bin이 없을 수 있어 명시 경로를 받는다.
  agyExecutable?: string;
  geminiApiKey?: string;
  agySdkPython?: string;
  mcpToolTimeoutMs: number;
  mcpMaxAttempts: number;
  codexMcpTimeoutMs: number;
  codexMcpHeartbeatMs: number;
  longRunningMcpServers: ReadonlySet<string>;
  turnIdleTimeoutMs: number;
  claudeMemoryDir: string;
  modelCatalog: ModelCatalog;
  deleteClaudeSession?: typeof deleteClaudeSession;
  // 테스트 주입용: agy 영속 대화 save_dir 경로. 기본값은 브리지 설정과 동일한 경로.
  agyConvSaveDir?: string;
}

interface ActiveRun {
  controller: AbortController;
  input: MessageQueue;
  pendingTurns: number;
  startedAt: number;
  query?: Query;
  stopRequested?: boolean;
  codexCurrentPrompt?: string;
  codexRestartPrompt?: string;
  codexTimers: Map<string, NodeJS.Timeout>;
  codexStarts: Map<string, number>;
  mcpFailures: Map<string, number>;
}

interface PersistedCodexAccountState {
  version: 1;
  accounts: Array<{
    home: string;
    exhaustedUntil: number | null;
    latestUsage: CodexUsageSnapshot | null;
  }>;
}

function isCodexUsageSnapshot(value: unknown): value is CodexUsageSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.capturedAt === "number"
    && typeof record.model === "string"
    && typeof record.reasoning === "string"
    && typeof record.inputTokens === "number"
    && typeof record.cachedInputTokens === "number"
    && typeof record.outputTokens === "number"
    && typeof record.reasoningOutputTokens === "number"
    && typeof record.totalTokens === "number";
}

export interface SessionInspection {
  sessionId: string;
  cwd: string;
  title: string;
  startedAt: number;
  pendingTurns: number;
  codexInFlight: boolean;
  codexElapsedMs: number | null;
}

export interface AgyLiveStatusResult {
  status: AgyLiveStatus | null;
  error: string | null;
}

export interface ResetContextResult {
  ok: boolean;
  reason?: string;
}

export interface SynthesisResult {
  ok: boolean;
  reason?: string;
  // 최종 종합 답변(ok일 때).
  answer?: string;
  // 후보로 실제 응답한 provider들.
  candidates?: ProviderKind[];
  // 심사 결과(투명성). 단일 후보면 생략될 수 있다.
  verdict?: JudgeVerdict;
  // 종합자로 쓴 provider.
  synthesizedBy?: ProviderKind;
}

interface SilentReadOnlyOptions {
  claudeModelOverride?: string;
  claudeThinkingOverride?: string;
  claudeEffortOverride?: string;
  codexModelOverride?: string;
  codexReasoningOverride?: CodexReasoningEffort;
}

function assistantBlocks(message: SDKMessage): Array<Record<string, unknown>> {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content as unknown as Array<Record<string, unknown>>;
}

function resultText(message: SDKMessage): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success") return message.result;
  return message.errors.join("\n");
}

function codexProgress(item: ThreadItem): string | null {
  if (item.type === "command_execution") {
    return `Codex 명령 완료: ${item.command.split("\n")[0]?.slice(0, 180) ?? ""}`;
  }
  if (item.type === "file_change") {
    const paths = item.changes.map((change) => change.path).slice(0, 4).join(", ");
    return `Codex 파일 변경: ${paths}`;
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    return `Codex 계획 진행: ${completed}/${item.items.length}`;
  }
  if (item.type === "web_search") return `Codex 검색 완료: ${item.query.slice(0, 180)}`;
  if (item.type === "mcp_tool_call") return `Codex MCP 완료: ${item.server}/${item.tool}`;
  if (item.type === "error") return `Codex 오류: ${item.message.slice(0, 180)}`;
  return null;
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

function codexSharedResourceConfig() {
  return {
    features: { memories: true },
    memories: {
      generate_memories: true,
      use_memories: true
    }
  };
}

function codexSandboxMode(mode: SessionRecord["permissionMode"]):
  "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "plan") return "read-only";
  if (mode === "default" || mode === "acceptEdits") return "workspace-write";
  return "danger-full-access";
}

function agyPermissionArgs(mode: SessionRecord["permissionMode"]): string[] {
  return mode === "auto" || mode === "dontAsk"
    ? ["--dangerously-skip-permissions"]
    : ["--sandbox", "--dangerously-skip-permissions"];
}

export class StreamingTextCollector {
  private readonly blocks = new Map<number, string>();

  accept(message: SDKMessage): string | null {
    if (message.type !== "stream_event" || message.parent_tool_use_id !== null) return null;
    const event = message.event;
    if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        this.blocks.set(event.index, event.content_block.text);
      }
      return null;
    }
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      this.blocks.set(event.index, (this.blocks.get(event.index) ?? "") + event.delta.text);
      return null;
    }
    if (event.type !== "content_block_stop") return null;

    const text = this.blocks.get(event.index)?.trim() ?? "";
    this.blocks.delete(event.index);
    return text || null;
  }
}

export function buildCompactCommand(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return clean ? `/compact ${clean}` : "/compact";
}

export function buildRolloverSummaryPrompt(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 500);
  return [
    "현재 대화와 작업 문맥을 새 세션이 그대로 이어받을 수 있도록 한국어 인계 요약으로 압축하십시오.",
    "목표, 사용자 의도, 결정사항, 수정 파일, 실행한 검증, 현재 상태, 남은 일, 위험과 주의점을 포함하십시오.",
    "추측하지 말고 실제 확인된 내용만 쓰며 요약 본문만 출력하십시오.",
    ...(clean ? [`특히 다음 내용을 보존하십시오: ${clean}`] : [])
  ].join("\n");
}

/**
 * /goal 자동 진행 턴에 전달할 작업 프롬프트. reason은 직전 평가에서 무엇이 남았는지.
 * 목표 원문에 포함된 `check:` 결정론 게이트 줄은 작업 모델에게 노출하지 않는다(평가 전용).
 * 사람용 설명(description)만 목표로 제시한다.
 */
export function buildGoalPrompt(condition: string, reason?: string): string {
  const { description, checks } = parseGoalChecks(condition);
  const clean = (description || condition).replace(/\s+/g, " ").trim();
  const checkNote = checks.length > 0
    ? `\n(완료 판정은 다음 명령으로 객관 검증됩니다: ${checks.join(" ; ")})`
    : "";
  const base = `[GOAL] 다음 목표가 완전히 충족될 때까지 작업을 진행하세요: ${clean}${checkNote}`;
  const tail = reason
    ? `\n직전 턴 평가에서 아직 충족되지 않았습니다: ${reason}\n남은 부분을 끝까지 완료하세요.`
    : "";
  return `${base}${tail}`;
}

/**
 * /goal 충족 여부를 빠른 모델(판관)로 판정시키기 위한 읽기 전용 프롬프트.
 * Structure2.md의 Tier 0 철학에 따라, 결정론적 게이트(`check:` 명령) 실행 결과가 있으면
 * 그 사실을 packet으로 함께 전달해 판관이 사실을 추측하지 않게 한다. description은 목표에서
 * check 줄을 뺀 사람용 텍스트다.
 */
export function buildGoalCheckPrompt(
  description: string,
  checkRun?: CheckRunResult
): string {
  const clean = description.replace(/\s+/g, " ").trim();
  const lines = [
    "다음 목표가 현재 저장소 상태에서 이미 충족되었는지 읽기 전용으로만 확인해 판정하세요.",
    "파일을 수정하지 말고, 필요한 파일·명령 결과를 확인한 뒤 마지막 줄에 정확히 아래 한 형식으로만 답하세요.",
    "GOAL_MET: <한 줄 근거>",
    "GOAL_UNMET: <무엇이 남았는지 한 줄>",
    "",
    `목표: ${clean || "(자유형 목표)"}`
  ];
  if (checkRun && checkRun.results.length > 0) {
    lines.push(
      "",
      "[결정론적 검증 결과] 아래는 이미 실행된 명령의 객관적 결과입니다. 이 사실은 추측하지 말고 그대로 신뢰하세요."
    );
    for (const result of checkRun.results) {
      const status = result.passed ? "PASS" : "FAIL";
      lines.push(`- ${status}: ${result.command}`);
      if (!result.passed && result.outputTail) {
        lines.push(`  출력(꼬리): ${result.outputTail.replace(/\s+/g, " ").slice(-200)}`);
      }
    }
    lines.push(
      "",
      checkRun.allPassed
        ? "모든 결정론적 검증은 통과했습니다. 위 목표 설명의 나머지 부분까지 충족됐는지 확인해 판정하세요."
        : "결정론적 검증 중 실패가 있으므로 목표는 아직 미충족입니다. GOAL_UNMET으로 답하세요."
    );
  }
  return lines.join("\n");
}

export function buildMemoryPrompt(focus?: string, memoryDir = "~/.claude/memory"): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const scope = clean
    ? `사용자가 지정한 저장 초점: ${clean}`
    : "현재 세션 전체에서 앞으로도 반복해서 유용할 내용을 검토한다.";
  // 경로와 파일 형식을 프롬프트 본문에 명시해 Claude/Codex 양쪽에서 동일하게 동작하게 한다.
  // Codex 턴에는 Claude 같은 메모리 시스템 프롬프트가 없으므로 self-contained해야 한다.
  return [
    "[EXPLICIT_MEMORY_UPDATE]",
    "사용자가 /memory 명령으로 전역 장기 메모리 업데이트를 명시적으로 승인했다.",
    scope,
    `메모리는 항상 ${memoryDir} 에만 기록한다. 새 메모리 파일은 이 경로에 만들고 인덱스는 ${memoryDir}/MEMORY.md 를 한 줄로 갱신한다.`,
    "각 메모리 파일은 frontmatter(--- / name: <kebab-slug> / description: <한 줄 요약> / "
    + "metadata: type: user|feedback|project|reference / ---)와 본문 한 가지 사실로 구성한다.",
    `기존 ${memoryDir}/MEMORY.md와 관련 메모리 파일을 먼저 읽고, 중복 없이 최소 범위로 갱신한다.`,
    "일시적인 작업 상태, 이미 끝난 세부 절차, 추측, 비밀정보, 자격증명은 저장하지 않는다.",
    "새 사실을 발명하지 말고 현재 대화에서 확인된 사용자 선호, 결정, 반복 사용 가능한 프로젝트 지식만 기록한다.",
    "이 명령문 자체는 메모리 내용으로 저장하지 않는다.",
    "완료 후 변경한 메모리 파일과 저장한 핵심 내용을 짧게 보고한다."
  ].join("\n");
}

export function resultSummary(
  message: SDKMessage,
  hasDeliveredAssistantText: boolean
): string {
  if (message.type !== "result") return "";
  if (message.subtype === "success" && hasDeliveredAssistantText) return "";
  return resultText(message);
}

export function loadProjectInstructions(cwd: string): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const content = readFileSync(join(cwd, filename), "utf8").trim();
      // AGENTS.md is often a symlink to CLAUDE.md (so Codex/agy read the same
      // project rules); dedupe identical content to avoid double-injection.
      if (!content || seen.has(content)) continue;
      seen.add(content);
      sections.push(`[${filename}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Project instruction files are optional.
    }
  }
  return sections.join("\n\n");
}

export function loadGlobalInstructions(): string {
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const [label, path] of [
    ["CLAUDE.md", join(homedir(), ".claude", "CLAUDE.md")],
    ["AGENTS.md", join(homedir(), ".codex", "AGENTS.md")]
  ] as const) {
    try {
      const content = readFileSync(path, "utf8").trim();
      if (!content || seen.has(content)) continue;
      seen.add(content);
      sections.push(`[${label}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Global instruction files are optional.
    }
  }
  return sections.join("\n\n");
}

async function readUsageSnapshot(
  sdkQuery: ReturnType<typeof query>,
  timeoutMs = 5000
): Promise<UsageSnapshot | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      sdkQuery
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
        .then((usage) => snapshotFromUsageResponse(usage)),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface UsageLookupResult {
  snapshot: UsageSnapshot | null;
  error: string | null;
}

export interface TokenUsageLookupResult extends UsageLookupResult {
  tokenIndex: number;
}

function hasUsageWindows(snapshot: UsageSnapshot): boolean {
  return Boolean(
    snapshot.fiveHour
    || snapshot.sevenDay
    || snapshot.sevenDayOpus
    || snapshot.sevenDaySonnet
    || snapshot.agentSdkWeekly
    || snapshot.extraUsage
  );
}

function datePartsInTimeZone(timestamp: number, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year ?? 0,
    month: values.month ?? 0,
    day: values.day ?? 0,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0
  };
}

function zonedDateTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = targetAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = datePartsInTimeZone(candidate, timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second
    );
    const correction = targetAsUtc - actualAsUtc;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate;
}

function normalizeResetTimeZone(value: string | undefined): string {
  const clean = value?.trim();
  if (!clean) return "Asia/Seoul";
  const aliases: Record<string, string> = {
    KST: "Asia/Seoul",
    UTC: "UTC",
    GMT: "UTC"
  };
  const timeZone = aliases[clean.toUpperCase()] ?? clean;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "Asia/Seoul";
  }
}

function nextResetInTimeZone(
  hour: number,
  minute: number,
  timeZone: string,
  now = Date.now()
): string {
  const current = datePartsInTimeZone(now, timeZone);
  let reset = zonedDateTimeToEpoch(
    current.year,
    current.month,
    current.day,
    hour,
    minute,
    timeZone
  );
  if (reset <= now) {
    const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
    reset = zonedDateTimeToEpoch(
      nextDate.getUTCFullYear(),
      nextDate.getUTCMonth() + 1,
      nextDate.getUTCDate(),
      hour,
      minute,
      timeZone
    );
  }
  return new Date(reset).toISOString();
}

const RESET_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

// 한도 메시지에서 회복 시각(ISO)을 파싱한다. 지원하는 표현:
//  - Claude 5시간 한도: "resets 2pm (Asia/Seoul)", "resets 4:40pm"
//  - Claude 주간 한도:  "resets Jun 25 at 9am (Asia/Seoul)" (연도 생략 → 가까운 미래로 보정)
//  - Codex 사용 한도:   "...try again at Jun 27th, 2026 3:57 PM.", "...try again at 5:28 PM."
// 시간만 주어지면 다음 도래 시각, 날짜가 함께 오면 그 절대 시각을 쓴다. 시간대 미표기 시
// 로컬(Asia/Seoul)로 가정한다(Codex/Claude 모두 사용자 로컬 표기를 따른다).
export function parseResetTimestamp(message: string, capturedAt = Date.now()): string | null {
  const anchor = message.match(/(?:resets?|try again at)\s+(.+?)(?:[.\n]|$)/i);
  const tail = anchor?.[1];
  if (!tail) return null;
  const detail = tail.match(
    /(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?\s*(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i
  );
  if (!detail) return null;
  const [, monthName, dayStr, yearStr, hourStr, minuteStr, meridiem] = detail;
  let hour = Number(hourStr);
  const minute = minuteStr ? Number(minuteStr) : 0;
  const ampm = meridiem?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;
  const timeZone = normalizeResetTimeZone(detail[7]);

  const month = monthName ? RESET_MONTHS[monthName.toLowerCase().slice(0, 3)] : undefined;
  if (monthName && month !== undefined) {
    const day = Number(dayStr);
    const year = yearStr ? Number(yearStr) : datePartsInTimeZone(capturedAt, timeZone).year;
    let reset = zonedDateTimeToEpoch(year, month, day, hour, minute, timeZone);
    // 연도가 생략된 형식(예: Claude 주간 한도 "resets Jun 25 at 9am")에서 이미 지난
    // 날짜면 다음 해로 넘긴다. 연도가 명시된 Codex 메시지는 그대로 쓴다.
    if (!yearStr && reset <= capturedAt) {
      reset = zonedDateTimeToEpoch(year + 1, month, day, hour, minute, timeZone);
    }
    return new Date(reset).toISOString();
  }
  return nextResetInTimeZone(hour, minute, timeZone, capturedAt);
}

export function snapshotFromRateLimitError(error: unknown, capturedAt = Date.now()): UsageSnapshot | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRateLimitError(message)) return null;
  return {
    capturedAt,
    subscriptionType: null,
    rateLimitsAvailable: true,
    fiveHour: {
      utilization: 100,
      resetsAt: parseResetTimestamp(message, capturedAt)
    }
  };
}

// 한도/요금 한계로 턴이 실패했는지 휴리스틱으로 판별한다. utilization 100% 이벤트가
// 오기 전에 곧장 에러로 끝나는 경우를 잡아 다음 세션을 다른 토큰으로 유도하기 위함이다.
export function isRateLimitError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("rate limit")
    || message.includes("rate_limit")
    || message.includes("429")
    || message.includes("usage limit")
    || message.includes("quota")
    || (message.includes("limit") && message.includes("reset"))
  );
}

// Codex 스레드 재개(thread/resume) 시 해당 rollout 파일이 사라져 재개가 불가능한지 판별한다.
// 계정 홈을 바꿨거나 rollout이 정리/만료된 경우 "no rollout found ... (code -32600)"로 실패하며,
// 이때는 기존 codexThreadId를 버리고 새 스레드로 다시 시작하면 복구된다(맥락은 부트스트랩으로 보강).
export function isNoRolloutError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("no rollout found") || message.includes("thread/resume failed");
}

// 일시적 서버 과부하/장애로 턴이 실패했는지 판별한다. 토큰 한도가 아니라 Anthropic
// 백엔드 전역 과부하(529 Overloaded)나 일시 장애(5xx)이므로, 토큰을 봉인/전환하지 않고
// 짧은 백오프 후 같은 토큰으로 같은 작업을 재시도하면 대부분 회복된다.
export function isOverloadedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("overloaded")
    || message.includes("529")
    || message.includes("503")
    || message.includes("502")
    || message.includes("service unavailable")
    || message.includes("internal server error")
  );
}

export function resultFailureText(
  message: SDKMessage,
  rateLimitRejected = false
): string | null {
  if (message.type !== "result") return null;
  const text = resultText(message);
  const apiErrorStatus =
    message.subtype === "success" ? message.api_error_status : null;
  if (apiErrorStatus === 429) {
    return text || "Claude API Error: 429 rate limit";
  }
  if (apiErrorStatus != null && apiErrorStatus >= 500) {
    return text && !text.includes("[ede_diagnostic]")
      ? text
      : `Claude API Error: ${apiErrorStatus} ${
          apiErrorStatus === 529 ? "Overloaded" : "server error"
        }`;
  }
  if (rateLimitRejected || isRateLimitError(text) || isOverloadedError(text)) {
    return text || (rateLimitRejected ? "Claude rate limit rejected" : null);
  }
  return message.subtype === "success" ? null : text || "Claude 실행이 실패했습니다.";
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

export function buildUserMessage(
  text: string,
  priority?: "now" | "next"
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {})
  };
}

export function buildCodexSteeredPrompt(originalPrompt: string, steeringPrompt: string): string {
  return `[중단된 기존 Codex 지시]\n${originalPrompt.trim()}\n\n`
    + `[/steer로 새로 들어온 우선 지시]\n${steeringPrompt.trim()}\n\n`
    + `위 /steer 지시를 우선 반영해 기존 작업을 다시 수행하십시오. `
    + `이미 적용된 실제 파일 변경은 무작정 되돌리지 말고, 현재 저장소 상태를 확인한 뒤 이어서 진행하십시오.`;
}

export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly values: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(value: SDKUserMessage): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

export class SessionManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly projectTails = new Map<string, Promise<void>>();
  private readonly queuedCounts = new Map<string, number>();
  private readonly sessionTasks = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  // 모든 토큰 한도 도달로 멈춘 세션을 회복 시각에 자동 재개하기 위해 거는 타이머.
  private readonly limitWaiters = new Map<string, NodeJS.Timeout>();
  // /goal 자동 진행이 한 목표에서 돈 턴 수(MAX_GOAL_ROUNDS 상한 적용).
  private readonly goalRounds = new Map<string, number>();
  private readonly agyInteractiveSessions = new Map<
    string,
    { client: AgyInteractiveSession; signature: string }
  >();
  private readonly tokenPool: TokenPool;
  private readonly oauthTokens: string[];
  // Codex 다중 계정 풀(CODEX_HOME 디렉터리 기준, sticky 선택 + reactive 페일오버).
  private readonly codexAccountPool: CodexAccountPool;
  private readonly codexUsageByHome = new Map<string, CodexUsageSnapshot>();

  constructor(
    private readonly store: StateStore,
    private readonly transport: MessageTransport,
    private readonly permissions: PermissionBroker,
    private readonly options: SessionManagerOptions
  ) {
    this.oauthTokens = [
      options.claudeCodeOauthToken,
      ...(options.additionalOauthTokens ?? [])
    ];
    this.tokenPool = new TokenPool(this.oauthTokens);
    // 계정 홈이 주어지지 않으면 기본 홈(CODEX_HOME 또는 ~/.codex) 1개로 단일 계정 동작.
    const codexHomes = options.codexAccountHomes && options.codexAccountHomes.length > 0
      ? options.codexAccountHomes
      : [process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")];
    this.codexAccountPool = new CodexAccountPool(codexHomes);
    this.restoreCodexAccountState();
  }

  createSession(
    project: ProjectConfig,
    chatId: number,
    topicId: number,
    title: string,
    prompt: string,
    resumeSessionId?: string,
    forkSession = false,
    model?: string | null,
    thinking?: string | null,
    claudeEffort?: string | null,
    leanMode = true,
    provider: ProviderKind = "claude",
    codexModel?: string | null,
    codexReasoning?: string | null,
    agyThinkingLevel?: string | null,
    agyModel?: string | null,
    handoffSummary?: string | null
  ): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      sdkSessionId: forkSession ? null : resumeSessionId ?? null,
      chatId,
      topicId,
      projectName: project.name,
      cwd: project.cwd,
      title,
      status: "queued",
      permissionMode: project.defaultMode,
      provider,
      model: model ?? null,
      thinking: thinking ?? null,
      claudeEffort: claudeEffort ?? null,
      codexModel: codexModel ?? null,
      codexReasoning: codexReasoning ?? null,
      codexThreadId: null,
      agyModel: agyModel ?? null,
      agyThinkingLevel: agyThinkingLevel ?? null,
      agyConversationId: null,
      agyUsage: null,
      handoffSummary: handoffSummary ?? null,
      goalCondition: null,
      leanMode,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    this.store.createSession(session);
    this.enqueue({
      session,
      prompt,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(forkSession ? { forkSession: true } : {})
    });
    return session;
  }

  resume(session: SessionRecord, prompt: string): boolean {
    if (this.active.has(session.id)) return false;
    // Codex 세션은 스레드를 새로 시작할 수 있어 항상 이어 갈 수 있다. Claude 세션은 이어 갈
    // SDK 세션 id가 있어야 한다. 제공사 전환 직후(handoffSummary 보유)에는 양쪽 모두 새
    // 맥락에서 요약을 받아 시작하므로 재개 핸들 없이도 진행한다.
    const canResume = session.provider === "codex"
      || session.provider === "agy"
      || !!session.sdkSessionId
      || !!session.handoffSummary;
    if (!canResume) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt,
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {})
    });
    return true;
  }

  compact(session: SessionRecord, focus?: string): boolean {
    if (!this.resumeHandle(session) || this.active.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: session.provider === "claude"
        ? buildCompactCommand(focus)
        : buildRolloverSummaryPrompt(focus),
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {}),
      operation: "compact"
    });
    return true;
  }

  async prepareFork(session: SessionRecord): Promise<string | null> {
    if (this.active.has(session.id) || !this.resumeHandle(session)) return null;
    return this.summarizeForHandoff(session);
  }

  /** 제공자별 "이어 갈 수 있는 재개 핸들". null이면 아직 한 번도 실행되지 않은 세션이다. */
  private resumeHandle(session: SessionRecord): string | null {
    if (session.provider === "codex") return session.codexThreadId;
    if (session.provider === "agy") return session.agyConversationId;
    return session.sdkSessionId;
  }

  /**
   * 목표를 설정한다. 유휴 상태이고 이어 갈 세션(Claude/Codex/agy)이 있으면 즉시 목표를 향한
   * 턴을 시작한다("queued"). 실행 중이면 현재 턴이 끝날 때 평가한다("active"). 이어 갈 세션이
   * 아직 없으면 저장만 한다("stored").
   */
  setGoal(sessionId: string, condition: string): "queued" | "active" | "stored" {
    const session = this.store.getSession(sessionId);
    if (!session) return "stored";
    // 개행은 보존하고 각 줄 안의 공백만 압축한다. check: 게이트는 줄 단위로 추출하므로
    // 개행을 통째로 없애면(`\s+`→" ") 결정론 검증이 동작하지 않는다.
    const clean = normalizeGoalCondition(condition);
    this.store.updateSession(sessionId, { goalCondition: clean });
    this.goalRounds.set(sessionId, 0);
    if (this.active.has(sessionId)) return "active";
    if (!this.resumeHandle(session)) return "stored";
    this.store.updateSession(sessionId, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(sessionId) ?? session,
      prompt: buildGoalPrompt(clean),
      // resumeSessionId는 Claude 전용 재개 핸들이다. codex/agy는 executeX가 스레드/대화 id를
      // 저장소에서 다시 읽어 재개하므로 전달하지 않는다.
      ...(session.provider === "claude" && session.sdkSessionId
        ? { resumeSessionId: session.sdkSessionId }
        : {})
    });
    return "queued";
  }

  /** 목표 자동 진행을 끈다. 끌 목표가 있었으면 true. */
  clearGoal(sessionId: string): boolean {
    const had = !!this.store.getSession(sessionId)?.goalCondition;
    this.goalRounds.delete(sessionId);
    if (this.store.getSession(sessionId)) {
      this.store.updateSession(sessionId, { goalCondition: null });
    }
    return had;
  }

  stop(sessionId: string): boolean {
    // /stop은 진행 중인 목표 자동 진행도 함께 멈춘다.
    this.clearGoal(sessionId);
    // 한도 회복을 기다리며 예약된 자동 재개가 있으면 그것도 중단으로 친다.
    if (this.cancelLimitWaiter(sessionId)) {
      if (this.store.getSession(sessionId)?.status === "waiting_limit") {
        this.store.updateSession(sessionId, { status: "aborted" });
      }
      return true;
    }
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.stopRequested = true;
    run.input.close();
    run.controller.abort();
    this.agyInteractiveSessions.get(sessionId)?.client.interrupt();
    // close()는 hang된 for-await가 풀리길 기다리지 않고 CLI 서브프로세스를 즉시
    // 강제 종료한다 — in-flight MCP 호출/transport와 서브에이전트까지 함께 정리되어
    // 종료 후 MCP 호출이 남아 가로막는 문제를 막는다. finally의 close()는 멱등 백업.
    run.query?.close();
    return true;
  }

  async fetchCurrentUsageSnapshots(cwd: string): Promise<TokenUsageLookupResult[]> {
    const results: TokenUsageLookupResult[] = [];
    for (const [index, oauthToken] of this.oauthTokens.entries()) {
      const result = await this.fetchUsageSnapshotForToken(cwd, oauthToken);
      results.push({ tokenIndex: index + 1, ...result });
    }
    return results;
  }

  async fetchCurrentUsageSnapshot(cwd: string): Promise<UsageLookupResult> {
    return this.fetchUsageSnapshotForToken(cwd, this.tokenPool.select());
  }

  getCodexUsageSnapshots(now: number = Date.now()): CodexAccountUsageSnapshot[] {
    return this.codexAccountPool.statuses(now).map((status) => ({
      accountIndex: status.index,
      available: status.available,
      exhaustedUntil: status.available ? null : status.exhaustedUntil,
      latestUsage: this.codexUsageByHome.get(status.home) ?? null
    }));
  }

  private restoreCodexAccountState(): void {
    const raw = this.store.getAppSetting(CODEX_ACCOUNT_STATE_SETTING);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedCodexAccountState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts)) return;
      for (const account of parsed.accounts) {
        if (!account || typeof account.home !== "string") continue;
        if (this.codexAccountPool.indexOf(account.home) === -1) continue;
        if (typeof account.exhaustedUntil === "number" && Number.isFinite(account.exhaustedUntil)) {
          this.codexAccountPool.markFailed(account.home, Date.now(), account.exhaustedUntil);
        }
        if (isCodexUsageSnapshot(account.latestUsage)) {
          this.codexUsageByHome.set(account.home, account.latestUsage);
        }
      }
    } catch (error) {
      console.error("Codex account state restore failed:", safeErrorMessage(error));
    }
  }

  private persistCodexAccountState(): void {
    const state: PersistedCodexAccountState = {
      version: 1,
      accounts: this.codexAccountPool.statuses().map((status) => ({
        home: status.home,
        exhaustedUntil: status.exhaustedUntil,
        latestUsage: this.codexUsageByHome.get(status.home) ?? null
      }))
    };
    this.store.setAppSetting(CODEX_ACCOUNT_STATE_SETTING, JSON.stringify(state));
  }

  private recordCodexUsage(
    home: string,
    usage: CodexSdkUsage,
    model: string,
    reasoning: string
  ): void {
    const inputTokens = usage.input_tokens;
    const cachedInputTokens = usage.cached_input_tokens;
    const outputTokens = usage.output_tokens;
    const reasoningOutputTokens = usage.reasoning_output_tokens;
    this.codexUsageByHome.set(home, {
      capturedAt: Date.now(),
      model,
      reasoning,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens
    });
    this.persistCodexAccountState();
  }

  private async fetchUsageSnapshotForToken(
    cwd: string,
    oauthToken: string
  ): Promise<UsageLookupResult> {
    const abortController = new AbortController();
    let provisionalSnapshot: UsageSnapshot | null = null;
    const sdkQuery = query({
      prompt: "사용량 확인용 요청입니다. 도구를 쓰지 말고 OK만 답하세요.",
      options: {
        cwd,
        abortController,
        model: DEFAULT_CLAUDE_MODEL,
        thinking: { type: "disabled" },
        maxTurns: 1,
        maxBudgetUsd: 0.01,
        permissionMode: "default",
        allowedTools: [],
        settingSources: [],
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      }
    });

    try {
      for await (const message of sdkQuery) {
        if (message.type === "system" && message.subtype === "init") {
          const snapshot = await readUsageSnapshot(sdkQuery, 10_000);
          if (snapshot && hasUsageWindows(snapshot)) {
            this.tokenPool.observe(oauthToken, snapshot);
            return { snapshot, error: null };
          }
          provisionalSnapshot = snapshot;
        }
        if (message.type !== "result") continue;
        const snapshot = await readUsageSnapshot(sdkQuery, 10_000);
        this.tokenPool.observe(oauthToken, snapshot);
        return { snapshot: snapshot ?? provisionalSnapshot, error: null };
      }
      return {
        snapshot: provisionalSnapshot,
        error: provisionalSnapshot ? null : "사용량 조회 세션이 결과 없이 종료되었습니다."
      };
    } catch (error) {
      const limitSnapshot = snapshotFromRateLimitError(error);
      if (limitSnapshot) {
        this.tokenPool.noteRateLimited(
          oauthToken,
          Date.now(),
          limitSnapshot.fiveHour?.resetsAt ? Date.parse(limitSnapshot.fiveHour.resetsAt) : undefined
        );
        return { snapshot: limitSnapshot, error: null };
      }
      if (isRateLimitError(error)) {
        this.tokenPool.noteRateLimited(oauthToken);
      }
      return { snapshot: null, error: safeErrorMessage(error) };
    } finally {
      abortController.abort();
      sdkQuery.close();
    }
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  inspect(): SessionInspection[] {
    const now = Date.now();
    const inspections: SessionInspection[] = [];
    for (const [sessionId, run] of this.active) {
      const session = this.store.getSession(sessionId);
      if (!session) continue;
      const oldestCodexStart = run.codexStarts.size > 0
        ? Math.min(...run.codexStarts.values())
        : null;
      inspections.push({
        sessionId,
        cwd: session.cwd,
        title: session.title,
        startedAt: run.startedAt,
        pendingTurns: run.pendingTurns,
        codexInFlight: oldestCodexStart !== null,
        codexElapsedMs: oldestCodexStart === null ? null : now - oldestCodexStart
      });
    }
    return inspections;
  }

  // 제공사를 전환한다(유휴 상태에서만). 현재 provider로 인계 요약을 만들어 저장하고,
  // 대상 provider의 재개 핸들을 비워 새 맥락에서 요약을 받아 이어 가게 한다. 전환 결과를
  // 돌려주고, 다음 사용자 턴부터 새 provider가 적용된다.
  async switchProvider(
    sessionId: string,
    target: ProviderKind
  ): Promise<{ ok: boolean; reason?: string }> {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, reason: "세션을 찾을 수 없습니다." };
    if (this.active.has(sessionId) || this.sessionTasks.has(sessionId)) {
      return { ok: false, reason: "실행 중에는 전환할 수 없습니다. 작업 완료 또는 중단 후 다시 시도하세요." };
    }
    if (session.provider === target) return { ok: false, reason: "이미 해당 제공사를 사용 중입니다." };

    let summary = "";
    try {
      summary = await this.summarizeForHandoff(session);
    } catch (error) {
      console.error("Handoff summary failed:", safeErrorMessage(error, this.oauthTokens));
    }
    if (session.provider === "agy") this.closeAgyInteractiveSession(session.id);

    if (target === "codex") {
      // 대상=Codex: 새 스레드에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "codex",
        codexThreadId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    } else if (target === "agy") {
      // 대상=agy: 새 대화에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "agy",
        agyConversationId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    } else {
      // 대상=Claude: 새 SDK 세션에서 요약을 받아 시작한다.
      this.store.updateSession(sessionId, {
        provider: "claude",
        sdkSessionId: null,
        ...(summary ? { handoffSummary: summary } : {})
      });
    }
    return { ok: true };
  }

  async resetContext(sessionId: string): Promise<ResetContextResult> {
    const session = this.store.getSession(sessionId);
    if (!session) return { ok: false, reason: "세션을 찾을 수 없습니다." };
    if (this.active.has(sessionId) || this.sessionTasks.has(sessionId)) {
      return { ok: false, reason: "실행 중에는 문맥을 초기화할 수 없습니다. /stop 후 다시 시도하세요." };
    }

    try {
      if (session.provider === "claude") {
        await this.resetClaudeContext(session);
        this.store.updateSession(session.id, {
          sdkSessionId: null,
          handoffSummary: null,
          usageSnapshot: null
        });
      } else if (session.provider === "codex") {
        this.resetCodexContext(session);
        this.store.updateSession(session.id, {
          codexThreadId: null,
          handoffSummary: null
        });
      } else {
        await this.resetAgyContext(session);
        this.store.updateSession(session.id, {
          agyConversationId: null,
          agyUsage: null,
          handoffSummary: null
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: safeErrorMessage(error, this.oauthTokens) };
    }
  }

  async getAgyLiveStatus(sessionId: string): Promise<AgyLiveStatusResult> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return { status: null, error: "세션을 찾을 수 없습니다." };
    }
    if (session.provider !== "agy") {
      return { status: null, error: "agy 세션이 아닙니다." };
    }
    const existing = this.agyInteractiveSessions.get(session.id)?.client;
    if (existing) {
      try {
        return { status: await existing.getStatus(), error: null };
      } catch (error) {
        return { status: null, error: safeErrorMessage(error, this.oauthTokens) };
      }
    }
    if (!session.agyConversationId) {
      return {
        status: {
          isIdle: true,
          turnCount: 0,
          conversationId: null
        },
        error: null
      };
    }

    try {
      const client = this.getAgyInteractiveSession(
        session,
        session.agyModel ?? DEFAULT_AGY_MODEL,
        session.permissionMode,
        session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL
      );
      const status = await client.getStatus();
      return { status, error: null };
    } catch (error) {
      return { status: null, error: safeErrorMessage(error, this.oauthTokens) };
    }
  }

  // 현재 provider에게 다음 어시스턴트가 이어받을 인계 요약을 만들게 한다. 한 번도 실행된 적이
  // 없는 세션(재개 핸들 없음)은 인계할 맥락이 없으므로 빈 문자열을 돌려준다.
  private async summarizeForHandoff(session: SessionRecord): Promise<string> {
    const prompt =
      "이 세션에서 지금까지 진행한 대화와 작업을, 다른 AI 어시스턴트가 그대로 이어받아 "
      + "작업을 계속할 수 있도록 한국어로 간결하게 요약하세요. 핵심 목표, 현재까지의 진행/결정, "
      + "수정한 파일과 그 이유, 남은 일과 주의점을 포함하고 요약 본문만 출력하세요.";
    if (session.provider === "claude") {
      if (!session.sdkSessionId) return "";
      const controller = new AbortController();
      const run: ActiveRun = {
        controller,
        input: new MessageQueue(),
        pendingTurns: 0,
        startedAt: Date.now(),
        codexTimers: new Map(),
        codexStarts: new Map(),
        mcpFailures: new Map()
      };
      return this.runReadOnlyClaude(session, controller, run, prompt, this.tokenPool.select());
    }
    if (session.provider === "agy") {
      // agy: 영속 대화식 세션을 읽기 전용 권한으로 재개해 요약 한 턴을 받는다.
      if (!session.agyConversationId) return "";
      const client = this.getAgyInteractiveSession(
        session,
        session.agyModel ?? DEFAULT_AGY_MODEL,
        "plan"
      );
      const result = await client.runTurn(prompt);
      return result.response.trim();
    }
    // Codex: 직전 스레드를 재개해 비스트리밍으로 요약 한 턴을 받는다.
    if (!session.codexThreadId) return "";
    const codexHome = this.codexAccountPool.select();
    requireCodexSubscriptionAuth(codexHome);
    const codex = new Codex({
      env: buildCodexEnvironment(codexHome),
      config: codexSharedResourceConfig()
    });
    const thread = codex.resumeThread(session.codexThreadId, {
      workingDirectory: session.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never"
    });
    const result = await thread.run(prompt);
    return result.finalResponse.trim();
  }

  private async resetClaudeContext(session: SessionRecord): Promise<void> {
    if (!session.sdkSessionId) return;
    const removeClaudeSession = this.options.deleteClaudeSession ?? deleteClaudeSession;
    await removeClaudeSession(session.sdkSessionId, { dir: session.cwd });
  }

  private resetCodexContext(session: SessionRecord): void {
    void session;
  }

  private async resetAgyContext(session: SessionRecord): Promise<void> {
    const client = this.agyInteractiveSessions.get(session.id)?.client;
    if (client) {
      try {
        await client.clearHistory();
        this.closeAgyInteractiveSession(session.id);
        return;
      } catch (error) {
        console.error("agy clear_history failed, falling back to file cleanup:", safeErrorMessage(error));
      }
    }
    this.closeAgyInteractiveSession(session.id);
    if (session.agyConversationId) {
      this.removeAgyConversationArtifacts(session.agyConversationId);
    }
  }

  private removeAgyConversationArtifacts(conversationId: string): void {
    if (!/^[0-9a-f]{32}$/i.test(conversationId)) {
      console.error(`agy conversation file removal skipped: invalid conversation_id format — "${conversationId}"`);
      return;
    }
    const saveDir = this.options.agyConvSaveDir
      ?? join(homedir(), ".local", "share", "telegram-claude-orchestrator", "agy-conversations");
    for (const suffix of [".db", ".db-shm", ".db-wal"]) {
      try {
        rmSync(join(saveDir, conversationId + suffix), { force: true });
      } catch (error) {
        console.error(`agy conversation file removal failed (${suffix}):`, safeErrorMessage(error));
      }
    }
  }

  async deleteSession(session: SessionRecord): Promise<void> {
    this.deleting.add(session.id);
    const wasActive = this.active.has(session.id);
    this.stop(session.id);
    this.closeAgyInteractiveSession(session.id);
    this.store.deleteSession(session.id);

    const task = this.sessionTasks.get(session.id);
    if (wasActive && task) await task.catch(() => undefined);

    if (session.sdkSessionId) {
      await this.resetClaudeContext(session).catch((error) => {
        console.error("Claude session deletion failed:", safeErrorMessage(error));
      });
    }

    if (session.provider === "agy" && session.agyConversationId) {
      this.removeAgyConversationArtifacts(session.agyConversationId);
    }

    if (!task || wasActive) this.deleting.delete(session.id);
  }

  steer(sessionId: string, prompt: string): "restarted" | "queued" | false {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    const session = this.store.getSession(sessionId);
    if (session?.provider === "codex" && run.codexCurrentPrompt) {
      const base = run.codexRestartPrompt ?? run.codexCurrentPrompt;
      run.codexRestartPrompt = buildCodexSteeredPrompt(base, clean);
      run.controller.abort();
      return "restarted";
    }
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(clean, "now"))) return "queued";
    run.pendingTurns -= 1;
    return false;
  }

  queueFollowUp(sessionId: string, prompt: string): boolean {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(clean, "next"))) return true;
    run.pendingTurns -= 1;
    return false;
  }

  /** 예약된 한도-회복 자동 재개 타이머를 취소한다. 실제로 취소했으면 true. */
  private cancelLimitWaiter(sessionId: string): boolean {
    const timer = this.limitWaiters.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.limitWaiters.delete(sessionId);
    return true;
  }

  /**
   * 모든 토큰이 한도에 도달해 더 실행할 수 없을 때, 가장 먼저 회복되는 시각에 맞춰
   * 같은 작업을 자동으로 다시 큐에 넣는다. 그 전에 사용자가 새 지시를 보내면(enqueue)
   * 타이머가 취소되어 즉시 재개되고, 데몬이 재시작되면 타이머는 사라지되 세션은
   * interrupted로 복구된다.
   */
  private scheduleLimitResume(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null,
    resumeAt: number
  ): void {
    const delayMs = Math.max(0, resumeAt - Date.now()) + LIMIT_RESUME_BUFFER_MS;
    const when = new Date(resumeAt + LIMIT_RESUME_BUFFER_MS).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul"
    });
    const lead = this.tokenPool.size > 1
      ? "모든 계정 토큰이 한도에 도달했습니다."
      : "토큰이 한도에 도달했습니다.";
    this.store.updateSession(session.id, { status: "waiting_limit" });
    void this.transport.sendText(
      session.chatId,
      session.topicId,
      `${lead} ${when}에 한도가 회복되면 자동으로 이어서 실행합니다. `
      + "(그 전에 새 지시를 보내면 즉시 재개를 시도합니다.)"
    ).catch(() => undefined);
    void this.safeRename(session, `[WAIT] ${session.title}`);

    const resumeId = sdkSessionId ?? request.resumeSessionId;
    const resumeRequest: RunRequest = {
      ...request,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
      // 회복 후에는 다시 토큰 전환을 시도할 수 있도록 전환 카운터를 초기화한다.
      autoSwitchCount: 0
    };
    this.cancelLimitWaiter(session.id);
    const timer = setTimeout(() => {
      this.limitWaiters.delete(session.id);
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      if (this.active.has(session.id)) return;
      this.enqueue(resumeRequest);
    }, delayMs);
    timer.unref();
    this.limitWaiters.set(session.id, timer);
  }

  private enqueue(request: RunRequest): void {
    // 예약된 한도-회복 자동 재개가 있으면 취소한다. 사용자가 먼저 새 지시를 보냈거나
    // 자동 재개 타이머가 직접 enqueue를 호출한 경우 모두, 중복 실행을 막는다.
    this.cancelLimitWaiter(request.session.id);
    const cwd = request.session.cwd;
    const count = this.queuedCounts.get(cwd) ?? 0;
    const waitsForPrevious = this.projectTails.has(cwd);
    this.queuedCounts.set(cwd, count + 1);
    const previous = this.projectTails.get(cwd) ?? Promise.resolve();
    if (waitsForPrevious) {
      const ahead = Math.max(1, count);
      void this.transport.sendText(
        request.session.chatId,
        request.session.topicId,
        `[QUEUED] 같은 프로젝트에서 실행 중인 작업 ${ahead}개가 끝나기를 기다립니다.\n`
        + "앞선 작업이 종료되면 자동으로 시작합니다."
      ).catch((error: unknown) => {
        console.error(
          `Queued status notification failed (${request.session.id}):`,
          safeErrorMessage(error, this.oauthTokens)
        );
      });
    }
    const next = previous
      .catch(() => undefined)
      .then(() => this.dispatch(request))
      .catch((error: unknown) => {
        // execute()의 자체 오류 처리 중 Telegram 전송/토픽 변경까지 실패하면 예외가
        // 여기까지 빠질 수 있다. 이 Promise를 미처리 rejection으로 두면 Node 데몬이
        // 종료되고 launchd 재시작 뒤 토큰 풀이 초기화되어 같은 페일오버를 반복한다.
        console.error(
          `Session execution escaped error (${request.session.id}):`,
          safeErrorMessage(error, this.oauthTokens)
        );
        if (this.store.getSession(request.session.id)) {
          this.store.updateSession(request.session.id, { status: "error" });
        }
        void this.transport.sendText(
          request.session.chatId,
          request.session.topicId,
          "[ERROR] 작업 오류를 처리하는 중 추가 통신 오류가 발생했습니다. "
          + "오케스트레이터는 종료되지 않았습니다. 잠시 후 다시 시도하세요."
        ).catch(() => undefined);
      })
      .finally(() => {
        const remaining = Math.max(0, (this.queuedCounts.get(cwd) ?? 1) - 1);
        this.queuedCounts.set(cwd, remaining);
        if (this.projectTails.get(cwd) === next) this.projectTails.delete(cwd);
        if (this.sessionTasks.get(request.session.id) === next) {
          this.sessionTasks.delete(request.session.id);
        }
        this.deleting.delete(request.session.id);
      });
    this.projectTails.set(cwd, next);
    this.sessionTasks.set(request.session.id, next);
  }

  // 제공사 전환 직후 첫 턴에 직전 provider의 인계 요약을 프롬프트 앞에 붙이고 저장값을
  // 비운다. compact 같은 비대화 작업에는 주입하지 않는다.
  private applyHandoffSummary(request: RunRequest, session: SessionRecord): RunRequest {
    if (!session.handoffSummary || request.operation === "compact") return request;
    const prompt =
      `[이전 어시스턴트로부터 인계받은 작업 요약]\n${session.handoffSummary}\n\n`
      + `[사용자의 새 지시]\n${request.prompt}`;
    this.store.updateSession(session.id, { handoffSummary: null });
    return { ...request, prompt };
  }

  // 큐에서 꺼낸 작업을 현재 저장된 provider에 맞는 실행기로 보낸다. provider는 /model
  // 전환으로 큐 대기 중에 바뀔 수 있으므로 스냅샷이 아닌 최신 값을 다시 읽는다.
  private async dispatch(request: RunRequest): Promise<void> {
    const session = this.store.getSession(request.session.id);
    const provider = session?.provider ?? request.session.provider;
    if (provider === "codex") {
      await this.executeCodex(request);
      return;
    }
    if (provider === "agy") {
      await this.executeAgy(request);
      return;
    }
    await this.execute(request);
  }

  private async execute(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    const session = this.store.getSession(request.session.id);
    if (!session) return;
    // 제공사 전환 직후 첫 턴이면 인계 요약을 프롬프트 앞에 1회 주입하고 비운다.
    request = this.applyHandoffSummary(request, session);
    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const abortController = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller: abortController,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);
    const claudeModel = session.model ?? DEFAULT_CLAUDE_MODEL;
    // 한도에 도달하지 않은 토큰을 고른다. 전부 소진이면 가장 빨리 회복될 토큰을 시도한다.
    // 마지막 사용 토큰은 Claude 모델별로 따로 유지한다.
    const oauthToken = this.tokenPool.select(Date.now(), claudeModel);
    const tokenIndex = this.tokenPool.indexOf(oauthToken);
    let sdkSessionId = request.resumeSessionId ?? session.sdkSessionId;
    // 세션의 usageSnapshot은 텔레그램 표시용 캐시이며 어느 계정 토큰에서 수집됐는지
    // 식별하지 않는다. 토큰 전환 실행에서 이를 새 토큰의 관측값으로 재사용하면,
    // 1번 토큰의 100% 스냅샷 때문에 2번 토큰까지 소진 처리될 수 있다.
    let latestUsage: UsageSnapshot | null = session.usageSnapshot;
    let currentTokenUsage: UsageSnapshot | null = null;
    let lastAssistantText = "";
    let compactSummary = "";
    let finalStatus: "done" | "error" = "done";
    let lastActivityAt = Date.now();
    let idleTimedOut = false;
    let idleWatchdog: NodeJS.Timeout | undefined;
    const streamingText = new StreamingTextCollector();
    const streamedAssistantTexts: string[] = [];
    let hasDeliveredAssistantText = false;
    let rateLimitRejected = false;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      if (this.tokenPool.size > 1 && tokenIndex > 0) {
        renderer.note(`기본 토큰 한도 도달 → 계정 토큰 #${tokenIndex + 1}로 전환해 실행합니다.`);
      }
      if (this.deleting.has(session.id)) return;
      this.store.updateSession(session.id, { status: "running" });

      const startCodexHeartbeat = (toolName: string, toolUseId: string): void => {
        const serverName = mcpServerName(toolName)?.toLowerCase();
        if (!serverName || !this.options.longRunningMcpServers.has(serverName)) return;
        const timer = setInterval(() => {
          void this.transport.sendText(
            session.chatId,
            session.topicId,
            `[MCP RUNNING] ${toolName} 작업이 계속 진행 중입니다. 완료 또는 실제 연결 실패까지 기다립니다.`
          ).catch(() => undefined);
        }, this.options.codexMcpHeartbeatMs);
        run.codexTimers.set(toolUseId, timer);
        run.codexStarts.set(toolUseId, Date.now());
      };

      const clearToolTimer = (toolUseId: string): void => {
        const timer = run.codexTimers.get(toolUseId);
        if (timer) clearInterval(timer);
        run.codexTimers.delete(toolUseId);
        run.codexStarts.delete(toolUseId);
      };

      const postToolUse: HookCallback = async (hookInput) => {
        if (hookInput.hook_event_name !== "PostToolUse") return {};
        clearToolTimer(hookInput.tool_use_id);
        run.mcpFailures.delete(mcpCallKey(hookInput.tool_name, hookInput.tool_input));
        return {};
      };

      const postToolUseFailure: HookCallback = async (hookInput) => {
        if (hookInput.hook_event_name !== "PostToolUseFailure") return {};
        clearToolTimer(hookInput.tool_use_id);
        if (!isRetryableMcpError(hookInput.tool_name, hookInput.error)) return {};

        const key = mcpCallKey(hookInput.tool_name, hookInput.tool_input);
        const failedAttempts = (run.mcpFailures.get(key) ?? 0) + 1;
        run.mcpFailures.set(key, failedAttempts);
        const server = mcpServerName(hookInput.tool_name) ?? "unknown";

        if (failedAttempts < this.options.mcpMaxAttempts) {
          renderer.note(
            `MCP ${server} 재시도 ${failedAttempts + 1}/${this.options.mcpMaxAttempts}`
          );
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: "PostToolUseFailure",
              additionalContext:
                `[MCP_RETRY ${failedAttempts + 1}/${this.options.mcpMaxAttempts}] `
                + `일시적 MCP 연결 오류입니다. 같은 도구와 같은 입력을 병렬 실행하지 말고 즉시 한 번만 다시 호출하세요.`
            }
          };
        }

        await this.transport.sendText(
          session.chatId,
          session.topicId,
          `[MCP FAILED] ${server} 서버의 ${hookInput.tool_name} 호출이 `
          + `${this.options.mcpMaxAttempts}회 모두 실패했습니다.\n${hookInput.error}`
        ).catch(() => undefined);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext:
              `[MCP_FAILED] ${this.options.mcpMaxAttempts}회 모두 실패했습니다. `
              + "같은 호출은 더 재시도하지 말고 사용자에게 실패 원인과 가능한 대안을 설명하세요."
          }
        };
      };

      const thinking = normalizeThinkingForModel(
        this.options.modelCatalog,
        claudeModel,
        session.thinking
      );
      const effort = resolveClaudeEffort(session.claudeEffort);
      const queryOptions: Options = {
        cwd: session.cwd,
        abortController,
        model: claudeModel,
        thinking: resolveThinkingConfig(thinking),
        ...(effort ? { effort } : {}),
        permissionMode: session.permissionMode,
        allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
        // 데스크톱/Claude Code와 동일하게 사용자 설정에서 스킬·플러그인·전역 CLAUDE.md를
        // 발견한다. 사전 승인 권한 규칙은 settings.local.json('local' 소스)에만 있어 'user'
        // 소스로는 로드되지 않으므로 모든 도구는 그대로 canUseTool 승인 브로커를 거친다.
        settingSources: ["user"],
        // 점진적 공개(name+description만 선로딩)로 모든 스킬을 켠다.
        skills: "all",
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `MCP 도구가 timeout, connection closed 또는 transport 오류로 실패하면 `
            + `호스트의 MCP_RETRY 지시에 따라 같은 입력을 순차적으로 최대 `
            + `${this.options.mcpMaxAttempts}회까지만 재시도한다. 병렬 재시도하지 않는다.`
            + `\n\n명시적 /memory 저장은 ${this.options.claudeMemoryDir} 에 기록하고 `
            + `인덱스 ${this.options.claudeMemoryDir}/MEMORY.md 를 갱신한다. `
            + `Claude 네이티브 자동 메모리는 ${join(homedir(), ".claude", "projects")} 아래의 저장소별 memory에, `
            + `Codex 네이티브 자동 메모리는 ${join(homedir(), ".codex", "memories")}에 유지한다. `
            + `${sharedMemoryBridgePath()}를 통해 세 메모리 저장소를 함께 검색한다.`
            + `\n\n${buildPublicProgressInstructions()}`
            + `\n\n${buildPermissionModeInstructions(session.permissionMode)}`
            + `\n\n공통 AI 자원 안내는 ${sharedResourceGuidePath()} 에 있다. 먼저 읽고 세 제공자 공통 스킬·커넥터·플러그인 기능·도구 정책을 따른다.`
            + (session.leanMode ? `\n\n${buildLeanInstructions(true)}` : "")
            + (() => {
              const instructions = loadGlobalInstructions();
              return instructions
                ? `\n\n다음 전역 사용자 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`
                : "";
            })()
            + (() => {
              const instructions = loadProjectInstructions(session.cwd);
              return instructions
                ? `\n\n다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`
                : "";
            })()
        },
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        // claude.json + codex config.toml의 커넥터를 병합해 전달한다(장기 실행 서버만
        // alwaysLoad, 나머지는 tool search로 지연 로딩되어 컨텍스트를 아낀다).
        mcpServers: loadClaudeConnectors(
          this.options.mcpToolTimeoutMs,
          this.options.codexMcpTimeoutMs,
          this.options.longRunningMcpServers
        ),
        hooks: {
          PostToolUse: [{ hooks: [postToolUse] }],
          PostToolUseFailure: [{ hooks: [postToolUseFailure] }]
        },
        includePartialMessages: true,
        canUseTool: async (toolName, toolInput, permissionOptions) => {
          const result = await this.permissions.request(
            this.store.getSession(session.id) ?? session,
            toolName,
            toolInput,
            permissionOptions
          );
          if (result.behavior === "allow") {
            startCodexHeartbeat(toolName, permissionOptions.toolUseID);
          }
          return result;
        },
        ...(request.resumeSessionId ? { resume: request.resumeSessionId } : {}),
        ...(request.forkSession ? { forkSession: true } : {}),
        ...(!request.resumeSessionId && !request.forkSession ? { sessionId: session.id } : {}),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      };

      const sdkQuery = query({ prompt: input, options: queryOptions });
      run.query = sdkQuery;
      lastActivityAt = Date.now();
      idleWatchdog = setInterval(() => {
        if (Date.now() - lastActivityAt <= this.options.turnIdleTimeoutMs) return;
        idleTimedOut = true;
        abortController.abort();
        // 먹통 상태에선 abort만으로 hang된 for-await가 안 풀릴 수 있으므로
        // 서브프로세스/MCP transport를 강제 종료한다.
        run.query?.close();
      }, Math.min(30_000, this.options.turnIdleTimeoutMs));
      for await (const message of sdkQuery) {
        lastActivityAt = Date.now();
        const completedStreamText = streamingText.accept(message);
        if (completedStreamText) {
          streamedAssistantTexts.push(completedStreamText);
          if (!isRateLimitError(completedStreamText) && !isOverloadedError(completedStreamText)) {
            await renderer.text(completedStreamText);
            hasDeliveredAssistantText = true;
          }
        }
        if (message.type === "system" && message.subtype === "init") {
          sdkSessionId = message.session_id;
          this.store.updateSession(session.id, { sdkSessionId });
        }

        if (message.type === "rate_limit_event") {
          if (message.rate_limit_info.status === "rejected") {
            rateLimitRejected = true;
          }
          currentTokenUsage = mergeUsageSnapshots(
            currentTokenUsage,
            snapshotFromRateLimitInfo(message.rate_limit_info)
          );
          latestUsage = currentTokenUsage;
          this.store.updateSession(session.id, { usageSnapshot: latestUsage });
          renderer.usage(latestUsage);
          this.tokenPool.observe(oauthToken, currentTokenUsage);
        }

        if (message.type === "system" && message.subtype === "compact_boundary") {
          const before = message.compact_metadata.pre_tokens.toLocaleString("ko-KR");
          const after = message.compact_metadata.post_tokens?.toLocaleString("ko-KR");
          compactSummary = after
            ? `컨텍스트 압축 완료: ${before} → ${after} 토큰`
            : `컨텍스트 압축 완료: 압축 전 ${before} 토큰`;
        }

        if (
          message.type === "system"
          && message.subtype === "status"
          && message.compact_result === "failed"
        ) {
          throw new Error(message.compact_error || "컨텍스트 압축에 실패했습니다.");
        }

        for (const block of assistantBlocks(message)) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            renderer.tool(
              block.name,
              block.input && typeof block.input === "object"
                ? block.input as Record<string, unknown>
                : {}
            );
          }
          if (block.type === "text" && typeof block.text === "string") {
            lastAssistantText = block.text.trim();
            const streamedIndex = streamedAssistantTexts.indexOf(lastAssistantText);
            if (streamedIndex >= 0) {
              streamedAssistantTexts.splice(streamedIndex, 1);
            } else if (
              !isRateLimitError(lastAssistantText)
              && !isOverloadedError(lastAssistantText)
            ) {
              await renderer.text(block.text);
              hasDeliveredAssistantText = true;
            }
          }
        }

        if (message.type === "result") {
          sdkSessionId = message.session_id;
          const serverUsage = await readUsageSnapshot(sdkQuery);
          if (serverUsage) {
            currentTokenUsage = serverUsage;
            latestUsage = serverUsage;
            renderer.usage(serverUsage);
          }
          this.tokenPool.observe(oauthToken, currentTokenUsage);
          const failureText = resultFailureText(message, rateLimitRejected);
          if (failureText) {
            throw new Error(failureText);
          }
          run.pendingTurns = Math.max(0, run.pendingTurns - 1);
          finalStatus = message.subtype === "success" ? "done" : "error";
          this.store.updateSession(session.id, {
            sdkSessionId,
            usageSnapshot: latestUsage,
            status: run.pendingTurns === 0 ? finalStatus : "running"
          });
          if (run.pendingTurns === 0) {
            input.close();
            await renderer.finish(
              finalStatus,
              request.operation === "compact" && compactSummary
                ? compactSummary
                : resultSummary(message, hasDeliveredAssistantText)
            );
            // 스트리밍 입력 모드의 Query는 다음 사용자 턴을 받기 위해 result 뒤에도
            // 열린 채로 있을 수 있다. 이 호스트는 후속 입력을 pendingTurns로 이미
            // 추적하므로 마지막 턴이면 즉시 루프를 끝내고 finally에서 Query를 닫는다.
            break;
          } else {
            renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
          }
        }
      }

      // close()로 스트림이 throw가 아니라 정상 return으로 끝날 수도 있으므로,
      // 중단/유휴로 끝난 경우 아래 정상완료 처리 대신 catch의 통합 분기로 보낸다.
      if (idleTimedOut || abortController.signal.aborted) {
        throw new Error("turn aborted");
      }

      if (sdkSessionId) {
        await renameSession(sdkSessionId, session.title, { dir: session.cwd }).catch(() => undefined);
      }
      const current = this.store.getSession(session.id);
      if (current?.status === "running") {
        this.store.updateSession(session.id, { status: finalStatus });
        await renderer.finish(finalStatus, compactSummary);
      }
      await this.safeRename(
        session,
        `${finalStatus === "done" ? "[DONE]" : "[ERROR]"} ${session.title}`
      );
      // 턴이 정상 완료됐으면 활성 목표 충족 여부를 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      if (finalStatus === "done") {
        await this.maybeContinueGoal(session, request, sdkSessionId);
      }
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `Claude run failed (session=${session.id}, token=#${tokenIndex + 1}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (idleTimedOut) {
        const minutes = Math.round(this.options.turnIdleTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish(
          "error",
          `${minutes}분간 어떤 진행도 없어 작업을 중단했습니다. `
          + `MCP 서버 또는 SDK가 응답하지 않는(먹통) 상태일 수 있습니다.`
        );
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (abortController.signal.aborted) {
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else if (isRateLimitError(error)) {
        // 한도 오류로 끝난 토큰을 봉인하고, 살아있는 다른 토큰이 있으면 같은 작업을
        // 그 토큰으로 즉시 자동 재실행한다. 사용자가 "계속" 같은 추가 입력을 보낼 필요가 없다.
        const limitSnapshot = snapshotFromRateLimitError(error);
        const resetsAt = limitSnapshot?.fiveHour?.resetsAt;
        this.tokenPool.noteRateLimited(
          oauthToken,
          Date.now(),
          resetsAt ? Date.parse(resetsAt) : undefined
        );
        const attempts = (request.autoSwitchCount ?? 0) + 1;
        const nextToken = this.tokenPool.select(Date.now(), claudeModel);
        const canAutoSwitch =
          this.tokenPool.size > 1
          && attempts < this.tokenPool.size
          && !this.tokenPool.isExhausted(nextToken);
        if (canAutoSwitch) {
          const nextIndex = this.tokenPool.indexOf(nextToken);
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            `토큰 #${tokenIndex + 1} 한도 도달 → 계정 토큰 #${nextIndex + 1}로 자동 전환해 이어서 실행합니다.`
          ).catch(() => undefined);
          await this.safeRename(session, `[SWITCH] ${session.title}`);
          // 같은 프로젝트 큐의 맨 뒤에 재투입한다. 현재 실행의 finally가 active/렌더러를
          // 정리한 뒤 살아있는 토큰으로 다시 실행된다. resume으로 대화 맥락을 잇는다.
          const resumeId = sdkSessionId ?? request.resumeSessionId;
          this.enqueue({
            ...request,
            ...(resumeId ? { resumeSessionId: resumeId } : {}),
            autoSwitchCount: attempts
          });
          return;
        }
        // 전환할 살아있는 토큰이 없다. 에러로 끝내는 대신, 가장 먼저 회복되는 한도
        // 시각에 맞춰 같은 작업을 자동으로 이어서 실행하도록 예약한다.
        const resumeAt = this.tokenPool.recoversAt();
        if (resumeAt !== null) {
          if (this.tokenPool.size > 1) {
            renderer.note("모든 계정 토큰이 한도에 도달했습니다. 회복 시각에 자동 재개를 예약합니다.");
          }
          this.scheduleLimitResume(session, request, sdkSessionId, resumeAt);
          return;
        }
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      } else if (isOverloadedError(error)) {
        // 일시적 서버 과부하/장애. 토큰을 봉인하지 않고 지수 백오프 후 같은 작업을
        // 자동 재시도한다. 사용자가 직접 "계속"을 보낼 필요가 없다.
        const attempt = (request.retryCount ?? 0) + 1;
        if (attempt <= MAX_OVERLOAD_RETRIES) {
          const delayMs = Math.min(
            OVERLOAD_RETRY_BASE_MS * 2 ** (attempt - 1),
            OVERLOAD_RETRY_CAP_MS
          );
          const seconds = Math.round(delayMs / 1000);
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            `서버 과부하(Overloaded)로 일시 중단 → ${seconds}초 후 자동 재시도합니다. (${attempt}/${MAX_OVERLOAD_RETRIES})`
          ).catch(() => undefined);
          await this.safeRename(session, `[RETRY] ${session.title}`);
          const resumeId = sdkSessionId ?? request.resumeSessionId;
          const retryRequest: RunRequest = {
            ...request,
            ...(resumeId ? { resumeSessionId: resumeId } : {}),
            retryCount: attempt
          };
          setTimeout(() => {
            if (this.deleting.has(session.id)) return;
            this.enqueue(retryRequest);
          }, delayMs).unref();
          return;
        }
        renderer.note(`과부하가 ${MAX_OVERLOAD_RETRIES}회 재시도 후에도 풀리지 않았습니다.`);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      } else {
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", String(error));
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      renderer.dispose();
      input.close();
      if (idleWatchdog) clearInterval(idleWatchdog);
      for (const timer of run.codexTimers.values()) clearInterval(timer);
      run.query?.close();
      this.active.delete(session.id);
    }
  }

  // Codex 제공사 세션의 한 작업(여러 턴)을 실행한다. Claude의 execute()에 대응하며, Codex
  // SDK 스레드로 턴을 돌린다. 웹검색은 항상 켜고 저장된 권한 모드를 Codex 샌드박스에 매핑한다.
  // steer/next로 큐에 쌓인 메시지는 같은 스레드에서 이어지는 턴으로 처리한다.
  private async executeCodex(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    let session = this.store.getSession(request.session.id);
    if (!session) return;
    request = this.applyHandoffSummary(request, session);
    session = this.store.getSession(request.session.id) ?? session;

    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    let controller = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);

    let timedOut = false;
    let turnTimeout: NodeJS.Timeout | undefined;
    let lastResponse = "";
    // 턴이 완료 이벤트 없이 끊겨도(SIGTERM·타임아웃 등) 직전에 포착한 최종 답변을 잃지 않도록
    // try 바깥에 둔다. catch에서 텔레그램으로 강제 전송하는 복구 경로의 소스가 된다.
    let lastAgentMessage = "";
    let codexThreadId = session.codexThreadId;
    // catch의 한도 페일오버에서 봉인 대상으로 참조하려고 try 바깥에 둔다.
    let codexHome = this.codexAccountPool.select();

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      this.store.updateSession(session.id, { status: "running" });

      codexHome = this.codexAccountPool.select();
      requireCodexSubscriptionAuth(codexHome);
      syncSharedResources();
      const codexModel = session.codexModel ?? DEFAULT_CODEX_MODEL;
      const codexReasoning =
        (session.codexReasoning as CodexReasoningEffort | null) ?? DEFAULT_CODEX_REASONING;
      const threadOptions = {
        model: codexModel,
        modelReasoningEffort: codexReasoning,
        workingDirectory: session.cwd,
        skipGitRepoCheck: true,
        sandboxMode: codexSandboxMode(session.permissionMode),
        approvalPolicy: "never" as const,
        webSearchEnabled: true
      };
      const codex = new Codex({
        env: buildCodexEnvironment(codexHome),
        config: codexSharedResourceConfig()
      });
      const thread = codexThreadId
        ? codex.resumeThread(codexThreadId, threadOptions)
        : codex.startThread(threadOptions);
      renderer.note(
        `Codex 실행 (${codexModelLabel(this.options.modelCatalog, codexModel)} · reasoning ${codexReasoningLabel(codexReasoning)})`
      );

      const bootstrap = buildProviderBootstrap(session, this.options.claudeMemoryDir);
      const iterator = input[Symbol.asyncIterator]();
      // 초기 메시지는 위에서 push했으므로 큐에서 꺼내 첫 턴으로 쓴다. 이후 steer/next로
      // 쌓인 메시지는 pendingTurns>0인 동안 같은 스레드에서 이어지는 턴으로 소비한다.
      let pending = await iterator.next();
      let firstTurn = true;
      while (!pending.done) {
        const content = pending.value.message.content;
        let turnPrompt = typeof content === "string" ? content : request.prompt;
        let attemptResponse = "";
        while (true) {
          controller = new AbortController();
          run.controller = controller;
          run.codexCurrentPrompt = turnPrompt;
          delete run.codexRestartPrompt;
          const memoryPrefix = firstTurn ? `${bootstrap}\n\n` : "";
          run.codexStarts.set("codex", Date.now());
          timedOut = false;
          if (turnTimeout) clearTimeout(turnTimeout);
          turnTimeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.options.codexMcpTimeoutMs);

          let completed = false;
          try {
            const streamed = await thread.runStreamed(`${memoryPrefix}${turnPrompt}`, {
              signal: controller.signal
            });
            for await (const event of streamed.events) {
              if (event.type === "item.completed") {
                if (event.item.type === "agent_message") {
                  attemptResponse = event.item.text;
                  lastAgentMessage = event.item.text;
                  await renderer.text(event.item.text);
                }
                const progress = codexProgress(event.item);
                if (progress) renderer.note(progress);
              } else if (event.type === "item.updated") {
                // 답변 본문이 자라는 동안 상태 메시지에 미리보기로 흘려보낸다.
                if (event.item.type === "agent_message") renderer.partial(event.item.text);
              } else if (event.type === "turn.completed") {
                completed = true;
                this.recordCodexUsage(codexHome, event.usage, codexModel, codexReasoning);
              } else if (event.type === "turn.failed") {
                throw new Error(`Codex 실행 실패: ${event.error.message}`);
              } else if (event.type === "error") {
                throw new Error(`Codex 스트림 오류: ${event.message}`);
              }
            }
          } catch (error) {
            if (!controller.signal.aborted || !run.codexRestartPrompt || timedOut || run.stopRequested) {
              throw error;
            }
          } finally {
            run.codexStarts.delete("codex");
            delete run.codexCurrentPrompt;
            if (turnTimeout) clearTimeout(turnTimeout);
          }
          if (run.codexRestartPrompt && !timedOut && !run.stopRequested) {
            turnPrompt = run.codexRestartPrompt;
            delete run.codexRestartPrompt;
            attemptResponse = "";
            renderer.note("Codex 현재 턴을 /steer 지시로 중단하고 다시 시작합니다.");
            continue;
          }
          if (timedOut || controller.signal.aborted) throw new Error("turn aborted");
          if (!completed) throw new Error("Codex 실행이 완료 이벤트 없이 종료되었습니다.");
          break;
        }

        if (thread.id && thread.id !== codexThreadId) {
          codexThreadId = thread.id;
          this.store.updateSession(session.id, { codexThreadId });
        }
        lastResponse = attemptResponse || lastResponse;
        firstTurn = false;

        run.pendingTurns = Math.max(0, run.pendingTurns - 1);
        if (run.pendingTurns === 0) break;
        renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
        pending = await iterator.next();
      }

      if (request.operation === "compact") {
        this.store.updateSession(session.id, {
          status: "done",
          codexThreadId: null,
          handoffSummary: lastResponse
        });
        await renderer.finish("done", "컨텍스트 압축 완료: 다음 턴은 압축 요약으로 새 Codex 스레드에서 이어집니다.");
      } else {
        this.store.updateSession(session.id, { status: "done" });
        await renderer.finish("done", lastResponse ? "" : "Codex가 텍스트 응답 없이 작업을 마쳤습니다.");
      }
      await this.safeRename(session, `[DONE] ${session.title}`);
      // 활성 목표가 있으면 충족 여부를 읽기 전용 Haiku로 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      // codex는 Claude 재개 핸들이 없으므로 sdkSessionId=null로 넘긴다(executeCodex가 스레드를 재개).
      if (request.operation !== "compact") {
        await this.maybeContinueGoal(session, request, null);
      }
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `Codex run failed (session=${session.id}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (timedOut) {
        // task_complete 후 자식 프로세스가 안 끝나 타임아웃된 경우, 직전에 받은 최종 답변이
        // 있으면 버리지 않고 텔레그램으로 강제 전송한다(렌더러가 중복은 자동 무시).
        if (lastAgentMessage.trim()) await renderer.text(lastAgentMessage).catch(() => undefined);
        const minutes = Math.round(this.options.codexMcpTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `Codex 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`);
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (controller.signal.aborted) {
        if (lastAgentMessage.trim()) await renderer.text(lastAgentMessage).catch(() => undefined);
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else if (isNoRolloutError(error) && codexThreadId && (request.rolloutResetCount ?? 0) < 1) {
        // Codex rollout(스레드 기록)이 유실돼 재개가 불가능하다. 기존 스레드를 버리고 새 스레드로
        // 한 번만 재실행한다(대화 맥락은 메모리/요약 부트스트랩으로 보강). 무한 루프는 카운터로 막는다.
        await this.transport.sendText(
          session.chatId,
          session.topicId,
          "Codex 스레드 기록(rollout)이 유실되어 새 스레드로 이어서 다시 실행합니다."
        ).catch(() => undefined);
        await this.safeRename(session, `[RETRY] ${session.title}`);
        this.store.updateSession(session.id, { codexThreadId: null });
        this.enqueue({ ...request, rolloutResetCount: (request.rolloutResetCount ?? 0) + 1 });
        return;
      } else if (isRateLimitError(error)) {
        // 현재 계정이 한도에 도달했다. 봉인하고, 살아있는 다른 계정이 있으면 같은 작업을
        // 그 계정으로 자동 재실행한다. 스레드는 계정 홈(CODEX_HOME)별로 저장되므로, 다른
        // 계정에서는 기존 codexThreadId가 없다 → null로 리셋해 새 스레드로 시작한다.
        // 대화 맥락은 다음 턴의 메모리/요약 부트스트랩으로 보강된다.
        const limitSnapshot = snapshotFromRateLimitError(error);
        const resetsAt = limitSnapshot?.fiveHour?.resetsAt;
        this.codexAccountPool.markFailed(
          codexHome,
          Date.now(),
          resetsAt ? Date.parse(resetsAt) : undefined
        );
        this.persistCodexAccountState();
        const attempts = (request.autoSwitchCount ?? 0) + 1;
        const nextHome = this.codexAccountPool.select();
        const canAutoSwitch =
          this.codexAccountPool.size > 1
          && attempts < this.codexAccountPool.size
          && !this.codexAccountPool.isExhausted(nextHome);
        if (canAutoSwitch) {
          const fromIndex = this.codexAccountPool.indexOf(codexHome);
          const nextIndex = this.codexAccountPool.indexOf(nextHome);
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            `Codex 계정 #${fromIndex + 1} 한도 도달 → 계정 #${nextIndex + 1}로 자동 전환해 새 스레드로 이어서 실행합니다.`
          ).catch(() => undefined);
          await this.safeRename(session, `[SWITCH] ${session.title}`);
          // 다른 계정 홈에는 기존 스레드가 없으므로 스레드를 리셋한다.
          this.store.updateSession(session.id, { codexThreadId: null });
          this.enqueue({ ...request, autoSwitchCount: attempts });
          return;
        }
        // 전환할 살아있는 계정이 없으면 회복 시각에 맞춰 자동 재개를 예약한다.
        const resumeAt = this.codexAccountPool.recoversAt();
        if (resumeAt !== null) {
          if (this.codexAccountPool.size > 1) {
            renderer.note("모든 Codex 계정이 한도에 도달했습니다. 회복 시각에 자동 재개를 예약합니다.");
          }
          this.scheduleLimitResume(session, request, null, resumeAt);
          return;
        }
        if (lastAgentMessage.trim()) await renderer.text(lastAgentMessage).catch(() => undefined);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `Codex 실행 실패: ${safeErrorMessage(error)}`);
        await this.safeRename(session, `[ERROR] ${session.title}`);
      } else {
        if (lastAgentMessage.trim()) await renderer.text(lastAgentMessage).catch(() => undefined);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `Codex 실행 실패: ${safeErrorMessage(error)}`);
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      if (turnTimeout) clearTimeout(turnTimeout);
      renderer.dispose();
      input.close();
      this.active.delete(session.id);
    }
  }

  private getAgyInteractiveSession(
    session: SessionRecord,
    model: string,
    permissionMode: SessionRecord["permissionMode"] = session.permissionMode,
    thinkingLevel: string | null = session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL
  ): AgyInteractiveSession {
    const geminiApiKey = this.options.geminiApiKey ?? process.env["GEMINI_API_KEY"];
    if (!geminiApiKey) {
      throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
    }
    // thinkingLevel이 변경되면 세션을 재구성한다(새 ModelTarget으로 init).
    const signature = JSON.stringify({
      cwd: session.cwd,
      model,
      permissionMode,
      thinkingLevel
    });
    const existing = this.agyInteractiveSessions.get(session.id);
    if (existing?.signature === signature && existing.client.alive) return existing.client;
    if (existing) this.closeAgyInteractiveSession(session.id);

    const client = new AgyInteractiveSession({
      pythonPath: this.options.agySdkPython ?? join(
        homedir(),
        ".local",
        "share",
        "telegram-claude-orchestrator",
        "agy-sdk",
        "bin",
        "python"
      ),
      bridgePath: resolve(process.cwd(), "scripts", "agy-sdk-bridge.py"),
      cwd: session.cwd,
      model,
      thinkingLevel,
      permissionMode,
      conversationId: session.agyConversationId,
      systemInstructions: buildProviderBootstrap(session, this.options.claudeMemoryDir),
      connectorRegistry: join(homedir(), ".claude", "shared-resources", "connectors.json"),
      skillsPaths: [
        join(homedir(), ".claude", "skills"),
        join(homedir(), ".codex", "skills"),
        join(homedir(), ".gemini", "config", "skills")
      ],
      env: {
        ...process.env,
        GEMINI_API_KEY: geminiApiKey,
        PYTHONUNBUFFERED: "1"
      }
    });
    this.agyInteractiveSessions.set(session.id, { client, signature });
    return client;
  }

  private closeAgyInteractiveSession(sessionId: string): void {
    const existing = this.agyInteractiveSessions.get(sessionId);
    if (!existing) return;
    this.agyInteractiveSessions.delete(sessionId);
    existing.client.close();
  }

  private async executeAgy(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    let session = this.store.getSession(request.session.id);
    if (!session) return;
    request = this.applyHandoffSummary(request, session);
    session = this.store.getSession(request.session.id) ?? session;

    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const controller = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(request.prompt));
    const run: ActiveRun = {
      controller,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.active.set(session.id, run);

    let timedOut = false;
    let turnTimeout: NodeJS.Timeout | undefined;
    let lastResponse = "";
    let agyConversationId = session.agyConversationId;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
      this.store.updateSession(session.id, { status: "running" });

      const agyModel = session.agyModel ?? DEFAULT_AGY_MODEL;
      let agyConnectorCount = 0;
      try {
        agyConnectorCount = syncSharedResources().connectorCount;
      } catch (error) {
        console.error(
          `agy MCP 동기화 실패 (session=${session.id}):`,
          safeErrorMessage(error)
        );
      }
      renderer.note(
        `agy SDK 대화식 실행 (${agyModelLabel(this.options.modelCatalog, agyModel)})`
        + ` · 커넥터 ${agyConnectorCount}개 공유`
      );

      const client = this.getAgyInteractiveSession(session, agyModel);
      const iterator = input[Symbol.asyncIterator]();
      let pending = await iterator.next();
      while (!pending.done) {
        const content = pending.value.message.content;
        const turnPrompt = typeof content === "string" ? content : request.prompt;

        // Phase 6: turnPrompt에서 '저장 경로:' 줄을 파싱해 agy 네이티브 첨부를 구성한다.
        // 텍스트 프롬프트는 그대로 유지해 모델이 파일명·캡션 문맥을 볼 수 있게 한다.
        // 지원 MIME이 없거나 파싱 불가 시 첨부는 빈 배열이 되고 기존 텍스트 경로 폴백이 작동한다.
        const turnAttachments = extractAgyAttachments(turnPrompt);

        if (turnTimeout) clearTimeout(turnTimeout);
        turnTimeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.options.codexMcpTimeoutMs);

        const progress = new ProgressiveParagraphCollector();
        let progressDelivery = Promise.resolve();
        let result!: Awaited<ReturnType<AgyInteractiveSession["runTurn"]>>;
        try {
          result = await client.runTurn(
            turnPrompt,
            controller.signal,
            (soFar) => {
              renderer.partial(soFar);
              for (const paragraph of progress.accept(soFar)) {
                progressDelivery = progressDelivery.then(() => renderer.text(paragraph));
              }
            },
            turnAttachments.length > 0 ? turnAttachments : undefined
          );
        } finally {
          if (turnTimeout) clearTimeout(turnTimeout);
        }
        if (timedOut || controller.signal.aborted) throw new Error("turn aborted");
        if (result.conversationId && result.conversationId !== agyConversationId) {
          agyConversationId = result.conversationId;
          this.store.updateSession(session.id, { agyConversationId });
        }
        // 대화 누적 사용량을 JSON 문자열로 저장한다(없으면 null 유지).
        if (result.totalUsage) {
          this.store.updateSession(session.id, {
            agyUsage: JSON.stringify(result.totalUsage)
          });
        }

        const attemptResponse = result.response.trim();
        if (!attemptResponse) {
          throw new Error("agy SDK가 성공 종료와 함께 빈 응답을 반환했습니다.");
        }
        for (const paragraph of progress.finish(attemptResponse)) {
          progressDelivery = progressDelivery.then(() => renderer.text(paragraph));
        }
        await progressDelivery;
        lastResponse = attemptResponse || lastResponse;
        if (agyRequestsProceed(attemptResponse)) {
          await this.transport.sendText(
            session.chatId,
            session.topicId,
            "제시된 계획대로 계속 진행하시겠습니까?",
            new InlineKeyboard().text("진행", `agygo:${session.id}`)
          );
        }
        run.pendingTurns = Math.max(0, run.pendingTurns - 1);
        if (run.pendingTurns === 0) break;
        renderer.note(`예약 메시지 ${run.pendingTurns}개 처리 대기`);
        pending = await iterator.next();
      }

      if (request.operation === "compact") {
        this.closeAgyInteractiveSession(session.id);
        this.store.updateSession(session.id, {
          status: "done",
          agyConversationId: null,
          handoffSummary: lastResponse
        });
        await renderer.finish("done", "컨텍스트 압축 완료: 다음 턴은 압축 요약으로 새 agy 대화에서 이어집니다.");
      } else {
        this.store.updateSession(session.id, { status: "done" });
        await renderer.finish("done", lastResponse ? "" : "agy가 텍스트 응답 없이 작업을 마쳤습니다.");
      }
      await this.safeRename(session, `[DONE] ${session.title}`);
      // 활성 목표가 있으면 충족 여부를 읽기 전용 Haiku로 평가하고, 미충족이면 다음 턴을 자동 예약한다.
      // agy는 Claude 재개 핸들이 없으므로 sdkSessionId=null로 넘긴다(executeAgy가 대화를 재개).
      if (request.operation !== "compact") {
        await this.maybeContinueGoal(session, request, null);
      }
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      console.error(
        `agy run failed (session=${session.id}):`,
        safeErrorMessage(error, this.oauthTokens)
      );
      if (timedOut) {
        const minutes = Math.round(this.options.codexMcpTimeoutMs / 60_000);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", `agy 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`);
        await this.safeRename(session, `[STALL] ${session.title}`);
      } else if (controller.signal.aborted) {
        this.store.updateSession(session.id, { status: "aborted" });
        await renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
        await this.safeRename(session, `[STOP] ${session.title}`);
      } else {
        const message = safeErrorMessage(error);
        const agyFailure = agyFailureFromLog(message);
        this.store.updateSession(session.id, { status: "error" });
        await renderer.finish("error", agyFailure ?? `agy SDK 실행 실패: ${message}`);
        await this.safeRename(session, `[ERROR] ${session.title}`);
      }
    } finally {
      if (turnTimeout) clearTimeout(turnTimeout);
      renderer.dispose();
      input.close();
      this.active.delete(session.id);
    }
  }

  /**
   * 모든 토큰 한도로 목표 충족 여부를 아직 평가하지 못했을 때, 회복 시각에 다시 평가·진행하도록
   * 예약한다. 작업 턴의 scheduleLimitResume과 같은 limitWaiters를 쓰므로, 회복 전에 사용자가
   * 새 지시를 보내거나 /stop을 누르면 예약이 취소된다. 데몬 재시작 시에는 interrupted로 복구된다.
   */
  private scheduleGoalRecheck(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null,
    resumeAt: number
  ): void {
    const delayMs = Math.max(0, resumeAt - Date.now()) + LIMIT_RESUME_BUFFER_MS;
    const when = new Date(resumeAt + LIMIT_RESUME_BUFFER_MS).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul"
    });
    this.store.updateSession(session.id, { status: "waiting_limit" });
    void this.transport.sendText(
      session.chatId,
      session.topicId,
      `${this.tokenPool.size > 1 ? "모든 계정 토큰이" : "토큰이"} 한도에 도달해 목표 달성 여부를 `
      + `아직 확인하지 못했습니다. ${when}에 회복되면 자동으로 다시 평가하고 목표 진행을 이어 갑니다.`
    ).catch(() => undefined);
    void this.safeRename(session, `[WAIT] ${session.title}`);
    this.cancelLimitWaiter(session.id);
    const timer = setTimeout(() => {
      this.limitWaiters.delete(session.id);
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      if (this.active.has(session.id)) return;
      void this.maybeContinueGoal(session, request, sdkSessionId);
    }, delayMs);
    timer.unref();
    this.limitWaiters.set(session.id, timer);
  }

  /**
   * 한 턴이 정상 종료된 직후 호출한다. 활성 목표가 있으면 빠른 모델로 충족 여부를 판정하고,
   * 미충족이면(상한 안에서) 같은 목표를 향한 다음 턴을 자동으로 큐에 넣는다. 이 후속 턴도
   * 일반 execute 경로를 타므로 토큰 자동 전환·waiting_limit 대기가 그대로 적용된다.
   */
  private async maybeContinueGoal(
    session: SessionRecord,
    request: RunRequest,
    sdkSessionId: string | null
  ): Promise<void> {
    const condition = this.store.getSession(session.id)?.goalCondition;
    if (!condition || this.deleting.has(session.id)) return;

    // 모든 토큰이 한도면 판관(세션 모델)을 부를 수 없으므로 충족 여부 평가 자체가 불가능하다.
    // 다른 모델로 대신 판정하지 않고, 가장 먼저 회복되는 시각에 다시 예약한다.
    const recoversAt = this.tokenPool.recoversAt();
    if (recoversAt !== null) {
      this.scheduleGoalRecheck(session, request, sdkSessionId, recoversAt);
      return;
    }

    let verdict: { met: boolean; reason: string };
    try {
      verdict = await this.evaluateGoal(session, condition);
    } catch (error) {
      // 평가 도중 모든 토큰이 한도에 닿았으면 판관(세션 모델)을 부를 수 없으므로
      // 다른 모델로 대신 판정하지 않고 회복 시각에 다시 예약한다.
      if (isRateLimitError(error)) {
        const at = this.tokenPool.recoversAt();
        if (at !== null) {
          this.scheduleGoalRecheck(session, request, sdkSessionId, at);
          return;
        }
      }
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표 달성 여부를 평가하지 못해 자동 진행을 멈췄습니다: ${safeErrorMessage(error)}\n`
        + "새 지시를 보내면 다시 평가하고, /goal clear 로 목표를 해제할 수 있습니다."
      ).catch(() => undefined);
      return;
    }

    if (verdict.met) {
      this.goalRounds.delete(session.id);
      this.store.updateSession(session.id, { goalCondition: null });
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표를 달성했습니다 ✅\n조건: ${condition}\n근거: ${verdict.reason}`
      ).catch(() => undefined);
      return;
    }

    const rounds = this.goalRounds.get(session.id) ?? 0;
    // Structure2.md: 고정 상한이 아니라 추정된 Risk_Level별 상한으로 자동 진행을 통제한다.
    const limit = Math.min(this.goalRoundLimit(condition), MAX_GOAL_ROUNDS);
    if (rounds + 1 >= limit) {
      this.goalRounds.delete(session.id);
      this.store.updateSession(session.id, { goalCondition: null });
      await this.transport.sendText(
        session.chatId,
        session.topicId,
        `목표 자동 진행을 ${limit}턴 후 중단합니다(아직 미달성).\n조건: ${condition}\n`
        + `마지막 평가: ${verdict.reason}\n계속하려면 새 지시를 보내거나 /goal 로 다시 설정하세요.`
      ).catch(() => undefined);
      return;
    }

    this.goalRounds.set(session.id, rounds + 1);
    await this.transport.sendText(
      session.chatId,
      session.topicId,
      `목표 미달성 → 자동으로 다음 턴을 진행합니다 (${rounds + 1}/${limit}).\n남은 점: ${verdict.reason}`
    ).catch(() => undefined);
    const resumeId = sdkSessionId ?? request.resumeSessionId;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: buildGoalPrompt(condition, verdict.reason),
      ...(resumeId ? { resumeSessionId: resumeId } : {})
    });
  }

  /**
   * 목표 충족 여부를 판정한다(Structure2.md Tier 0 + Tier 5 판관).
   * 1) 목표에 `check:` 결정론적 게이트가 있으면 먼저 실행한다.
   * 2) 게이트가 하나라도 실패하면 LLM을 부르지 않고 즉시 미충족으로 본다(사실은 추측하지 않는다).
   * 3) 게이트가 모두 통과(또는 게이트 없음)면 그 객관적 결과를 packet으로 판관에 넘겨
   *    목표 설명(description)의 나머지 충족 여부를 읽기 전용으로 판정한다.
   *    판관 = Tier 5 = "이 세션이 도는 모델 그 자체"(session.model). 옛 Haiku 고정 평가 및
   *    로컬 Tier 2(qwen3.6) 사전 판정은 폐지했다. 목표 판관은 항상 세션 모델이다.
   */
  private async evaluateGoal(
    session: SessionRecord,
    condition: string
  ): Promise<{ met: boolean; reason: string }> {
    const spec = parseGoalChecks(condition);
    const checkRun = await runGoalChecks(spec.checks, session.cwd);
    if (!checkRun.allPassed) {
      const failed = checkRun.results.filter((r) => !r.passed).map((r) => r.command);
      return {
        met: false,
        reason: `결정론적 검증 실패: ${failed.join(", ")}`
      };
    }
    // 게이트만 있고 사람용 설명이 없으면(=순수 결정론 목표) LLM 없이 통과로 판정한다.
    if (spec.checks.length > 0 && !spec.description) {
      return {
        met: true,
        reason: `결정론적 검증 ${spec.checks.length}건 모두 통과`
      };
    }

    // 결정론 게이트가 통과한 뒤(또는 게이트 없는 자유서술형) 사람용 설명이 남은 경우:
    // 판관 = Tier 5(세션 모델)로 읽기 전용 판정한다.
    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      input: new MessageQueue(),
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    // Tier 5 판관 = 세션 모델. modelOverride를 주지 않으면 runReadOnlyClaude가 session.model을 쓴다.
    const text = await this.runReadOnlyClaude(
      session,
      controller,
      run,
      buildGoalCheckPrompt(spec.description, checkRun),
      this.tokenPool.select(),
      false
    );
    return parseGoalVerdict(text);
  }

  /**
   * 목표 텍스트에서 Structure2.md Risk_Level을 추정해 자동 진행 턴 상한을 정한다.
   * 위험도 추정은 순수 함수(estimateGoalRisk)로 분리해 테스트 가능하게 했다.
   */
  private goalRoundLimit(condition: string): number {
    return GOAL_ROUNDS_BY_RISK[estimateGoalRisk(condition)];
  }

  private async runReadOnlyClaude(
    session: SessionRecord,
    controller: AbortController,
    run: ActiveRun,
    prompt: string,
    oauthToken: string,
    allowQuestions = false,
    modelOverride?: string,
    thinkingOverride?: string,
    effortOverride?: string
  ): Promise<string> {
    const instructions = loadProjectInstructions(session.cwd);
    const claudeModel = modelOverride ?? session.model ?? DEFAULT_CLAUDE_MODEL;
    const thinking = normalizeThinkingForModel(
      this.options.modelCatalog,
      claudeModel,
      thinkingOverride ?? session.thinking
    );
    const effort = resolveClaudeEffort(effortOverride ?? session.claudeEffort);
    const sdkQuery = query({
      prompt,
      options: {
        cwd: session.cwd,
        abortController: controller,
        model: claudeModel,
        thinking: resolveThinkingConfig(thinking),
        ...(effort ? { effort } : {}),
        // plan 모드는 모델이 도구를 쓰려 하면 turn을 즉시 종료해 AskUserQuestion의 답을
        // 기다리지 못한다. 대화가 필요한 계획 단계에서는 default 모드로 돌려 질문이 실제로
        // 사용자 응답을 기다리게 한다. 편집은 read-only allowedTools로 여전히 차단된다.
        permissionMode: allowQuestions ? "default" : "plan",
        allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
        settingSources: [],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...((instructions || session.leanMode)
            ? {
                append:
                  (session.leanMode ? `${buildLeanInstructions(true)}\n\n` : "")
                  + (instructions
                    ? "다음 프로젝트 지침을 따르되 파일을 수정하지 마세요. "
                      + "이 지침은 추가 도구 권한을 부여하지 않습니다.\n\n"
                      + instructions
                    : "")
              }
            : {})
        },
        env: buildClaudeEnvironment(
          oauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        // allowQuestions가 켜지면(계획 단계) AskUserQuestion이 permission broker를 거쳐
        // 텔레그램으로 전달되고 사용자의 답을 기다린다. Codex 실행은 여전히 비대화형이므로
        // 필요한 정보는 이 단계에서 모두 확보된다.
        ...(allowQuestions
          ? {
              includePartialMessages: true,
              canUseTool: async (toolName, toolInput, permissionOptions) =>
                this.permissions.request(
                  this.store.getSession(session.id) ?? session,
                  toolName,
                  toolInput,
                  permissionOptions
                )
            }
          : {}),
        ...(this.options.claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: this.options.claudeCodeExecutable }
          : {})
      }
    });
    run.query = sdkQuery;
    let text = "";
    try {
      for await (const message of sdkQuery) {
        for (const block of assistantBlocks(message)) {
          if (block.type === "text" && typeof block.text === "string") {
            text = block.text.trim();
          }
        }
        if (message.type === "result") {
          if (message.subtype !== "success") {
            throw new Error(resultText(message) || "Claude 읽기 전용 단계가 실패했습니다.");
          }
          text = text || message.result.trim();
        }
      }
    } finally {
      sdkQuery.close();
      if (run.query === sdkQuery) delete run.query;
    }
    if (!text) throw new Error("Claude 읽기 전용 단계가 빈 응답을 반환했습니다.");
    return text;
  }

  // ── 2단계 병렬 종합 ──────────────────────────────────────────────────────
  // 같은 작업을 Claude·Codex·agy에 읽기 전용으로 동시에 시키고(파일 충돌 없음), Claude
  // Opus 4.8 high 심사자(실패 시 Codex 5.5 high 폴백)가 가장 나은 답을 고른 뒤,
  // 승자 provider가 다른 후보의 더 나은 부분을 통합해 최종답을 만든다. /synth 명령으로만
  // 호출되는 비싼 경로다.
  async runSynthesis(session: SessionRecord, prompt: string): Promise<SynthesisResult> {
    if (this.active.has(session.id)) {
      return { ok: false, reason: "실행 중에는 병렬 종합을 시작할 수 없습니다. 작업 완료 또는 /stop 후 다시 시도하세요." };
    }
    const providers: ProviderKind[] = ["claude", "codex", "agy"];
    const settled = await Promise.allSettled(
      providers.map((provider) => this.runSilentReadOnly(session, provider, prompt))
    );
    const candidates: JudgeCandidate[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === "fulfilled" && result.value.trim()) {
        candidates.push({ provider: providers[index]!, text: result.value.trim() });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: "후보 제공자가 모두 응답하지 못했습니다." };
    }
    const candidateProviders = candidates.map((c) => c.provider);

    // 후보가 하나뿐이면 심사·종합 없이 그대로 반환한다.
    if (candidates.length === 1) {
      return {
        ok: true,
        answer: candidates[0]!.text,
        candidates: candidateProviders,
        synthesizedBy: candidates[0]!.provider
      };
    }

    const verdict = await this.judgeCandidates(session, prompt, candidates);
    const winner = candidates[verdict.winner - 1] ?? candidates[0]!;

    // 승자 기반 통합: 승자 provider에게 후보들을 주고 최종본을 합치게 한다(읽기 전용).
    const synthPrompt = buildSynthesisPrompt(prompt, candidates, verdict);
    let answer = winner.text;
    try {
      answer = (await this.runSilentReadOnly(session, winner.provider, synthPrompt)).trim() || winner.text;
    } catch (error) {
      // 종합 실패 시 승자 답을 그대로 쓴다(품질은 낮아도 답은 보존).
      console.error("Synthesis merge failed:", safeErrorMessage(error, this.oauthTokens));
    }

    return {
      ok: true,
      answer,
      candidates: candidateProviders,
      verdict,
      synthesizedBy: winner.provider
    };
  }

  // 후보들을 심사한다. Claude Opus 4.8 high 우선, 실패 시 Codex 5.5 high 폴백,
  // 그마저 실패하면 1번 후보.
  private async judgeCandidates(
    session: SessionRecord,
    question: string,
    candidates: JudgeCandidate[]
  ): Promise<JudgeVerdict> {
    const judgePrompt = buildJudgePrompt(question, candidates);

    try {
      const controller = new AbortController();
      const run: ActiveRun = {
        controller,
        input: new MessageQueue(),
        pendingTurns: 0,
        startedAt: Date.now(),
        codexTimers: new Map(),
        codexStarts: new Map(),
        mcpFailures: new Map()
      };
      const text = await this.runReadOnlyClaude(
        session,
        controller,
        run,
        judgePrompt,
        this.tokenPool.select(),
        false,
        SYNTH_JUDGE_CLAUDE_MODEL,
        SYNTH_JUDGE_CLAUDE_THINKING,
        SYNTH_JUDGE_CLAUDE_EFFORT
      );
      const parsed = parseJudgeResponse(text, candidates.length);
      if (parsed) return { ...parsed, judge: "claude" };
    } catch (error) {
      console.error("Claude synthesis judge failed:", safeErrorMessage(error, this.oauthTokens));
    }

    // 판관은 Opus 4.8 high로 고정한다. Opus 판정이 실패하면 다른 모델로 폴백하지 않고
    // 첫 후보를 그대로 채택한다(투명성을 위해 judge: "fallback"으로 표기).
    return { winner: 1, reason: "심사자(Opus 4.8)를 사용할 수 없어 첫 후보를 선택했습니다.", judge: "fallback" };
  }

  // provider 하나에 같은 프롬프트를 읽기 전용·새 맥락으로 1회 실행해 최종 텍스트만 받는다.
  // 텔레그램 토픽·active 맵·렌더러에 흘리지 않는다(병렬 종합 전용 조용한 실행).
  private async runSilentReadOnly(
    session: SessionRecord,
    provider: ProviderKind,
    prompt: string,
    options: SilentReadOnlyOptions = {}
  ): Promise<string> {
    if (provider === "claude") {
      const controller = new AbortController();
      const run: ActiveRun = {
        controller,
        input: new MessageQueue(),
        pendingTurns: 0,
        startedAt: Date.now(),
        codexTimers: new Map(),
        codexStarts: new Map(),
        mcpFailures: new Map()
      };
      return this.runReadOnlyClaude(
        session,
        controller,
        run,
        prompt,
        this.tokenPool.select(),
        false,
        options.claudeModelOverride,
        options.claudeThinkingOverride,
        options.claudeEffortOverride
      );
    }
    if (provider === "codex") {
      const codexHome = this.codexAccountPool.select();
      requireCodexSubscriptionAuth(codexHome);
      const codex = new Codex({
        env: buildCodexEnvironment(codexHome),
        config: codexSharedResourceConfig()
      });
      const thread = codex.startThread({
        model: options.codexModelOverride ?? session.codexModel ?? DEFAULT_CODEX_MODEL,
        modelReasoningEffort: options.codexReasoningOverride
          ?? (session.codexReasoning as CodexReasoningEffort | null)
          ?? DEFAULT_CODEX_REASONING,
        workingDirectory: session.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "read-only",
        approvalPolicy: "never"
      });
      const result = await thread.run(prompt);
      return result.finalResponse.trim();
    }
    // agy: 새 plan(읽기 전용) interactive 세션 한 턴. 종합용 임시 세션이므로 사용자 세션의
    // agyConversationId를 건드리지 않도록 conversationId 없이 새로 만들고 끝나면 닫는다.
    const geminiApiKey = this.options.geminiApiKey ?? process.env["GEMINI_API_KEY"];
    if (!geminiApiKey) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
    const client = new AgyInteractiveSession({
      pythonPath: this.options.agySdkPython ?? join(
        homedir(),
        ".local",
        "share",
        "telegram-claude-orchestrator",
        "agy-sdk",
        "bin",
        "python"
      ),
      bridgePath: resolve(process.cwd(), "scripts", "agy-sdk-bridge.py"),
      cwd: session.cwd,
      model: session.agyModel ?? DEFAULT_AGY_MODEL,
      thinkingLevel: session.agyThinkingLevel ?? DEFAULT_AGY_THINKING_LEVEL,
      permissionMode: "plan",
      conversationId: null,
      systemInstructions: buildProviderBootstrap(session, this.options.claudeMemoryDir),
      connectorRegistry: join(homedir(), ".claude", "shared-resources", "connectors.json"),
      skillsPaths: [
        join(homedir(), ".claude", "skills"),
        join(homedir(), ".codex", "skills"),
        join(homedir(), ".gemini", "config", "skills")
      ],
      env: {
        ...process.env,
        GEMINI_API_KEY: geminiApiKey,
        PYTHONUNBUFFERED: "1"
      }
    });
    try {
      const result = await client.runTurn(prompt);
      return result.response.trim();
    } finally {
      client.interrupt();
    }
  }

  private async safeRename(session: SessionRecord, title: string): Promise<void> {
    await this.transport.renameTopic(session.chatId, session.topicId, title).catch((error) => {
      console.error("Telegram topic rename failed:", safeErrorMessage(error));
    });
  }
}
