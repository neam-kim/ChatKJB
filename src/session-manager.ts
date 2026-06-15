import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  deleteSession as deleteClaudeSession,
  query,
  renameSession,
  type HookCallback,
  type Options,
  type Query,
  type ThinkingConfig,
  type SDKUserMessage,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { Codex, type ThreadItem, type Usage } from "@openai/codex-sdk";
import {
  isRetryableMcpError,
  loadMcpServersWithTimeouts,
  mcpCallKey,
  mcpServerName
} from "./mcp-policy.js";
import {
  buildPlanPrompt,
  buildReviewPrompt,
  formatStructuredReview,
  parseAcceptanceCriteria,
  parsePlanReview
} from "./plan-verification.js";
import { PermissionBroker } from "./permission-broker.js";
import { StateStore } from "./store.js";
import { StreamRenderer } from "./stream-renderer.js";
import { safeErrorMessage } from "./telegram-transport.js";
import type {
  MessageTransport,
  PlanEvidenceKind,
  ProjectConfig,
  SessionRecord,
  UsageSnapshot
} from "./types.js";
import {
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "./usage.js";

const execFileAsync = promisify(execFile);
const MAX_PLAN_EXECUTION_ATTEMPTS = 3;
export interface CodexModelOption {
  id: string;
  label: string;
}
export const CODEX_MODELS: CodexModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5" }
];
export const DEFAULT_CODEX_MODEL = "gpt-5.5";
// 하위 호환: 상태 표시 등에서 참조하는 기본 모델 별칭.
export const CODEX_MODEL = DEFAULT_CODEX_MODEL;

export function resolveCodexModel(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return CODEX_MODELS.find((option) => option.id.toLowerCase() === value)?.id;
}

export function codexModelLabel(id: string | null | undefined): string {
  if (!id) return codexModelLabel(DEFAULT_CODEX_MODEL);
  return CODEX_MODELS.find((option) => option.id === id)?.label ?? id;
}

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export interface CodexReasoningOption {
  id: CodexReasoningEffort;
  label: string;
}
export const CODEX_REASONING_OPTIONS: CodexReasoningOption[] = [
  { id: "minimal", label: "최소 (Minimal)" },
  { id: "low", label: "낮음 (Low)" },
  { id: "medium", label: "보통 (Medium)" },
  { id: "high", label: "높음 (High)" },
  { id: "xhigh", label: "매우 높음 (xHigh)" }
];
export const DEFAULT_CODEX_REASONING: CodexReasoningEffort = "high";
// 하위 호환: 상태 표시 등에서 참조하는 기본 추론 강도 별칭.
export const CODEX_REASONING_EFFORT: CodexReasoningEffort = DEFAULT_CODEX_REASONING;

export function resolveCodexReasoning(input: string): CodexReasoningEffort | undefined {
  const value = input.trim().toLowerCase();
  return CODEX_REASONING_OPTIONS.find((option) => option.id === value)?.id;
}

export function codexReasoningLabel(id: string | null | undefined): string {
  return CODEX_REASONING_OPTIONS.find((option) => option.id === id)?.label
    ?? "높음 (High)";
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8";
export const CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
export interface ClaudeModelOption {
  id: string;
  label: string;
  aliases: string[];
}
export const CLAUDE_MODELS: ClaudeModelOption[] = [
  {
    id: "claude-opus-4-8",
    label: "Opus 4.8",
    aliases: ["opus", "opus-4-8"]
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    aliases: ["sonnet", "sonnet-4-6"]
  },
  {
    id: "claude-fable-5",
    label: "Fable 5",
    aliases: ["fable", "fable-5"]
  }
];

export function resolveModel(input: string): string | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  return CLAUDE_MODELS.find((option) =>
    option.aliases.includes(value) || option.id.toLowerCase() === value
  )?.id;
}

export function modelLabel(id: string): string {
  return CLAUDE_MODELS.find((option) => option.id === id)?.label ?? id;
}

export const CLAUDE_THINKING = { type: "adaptive" } as const;

export type ThinkingLevel = "adaptive" | "high" | "off";
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "adaptive";
export interface ThinkingOption {
  id: ThinkingLevel;
  label: string;
}
export const THINKING_OPTIONS: ThinkingOption[] = [
  { id: "adaptive", label: "자동 (Adaptive)" },
  { id: "high", label: "깊게 (High)" },
  { id: "off", label: "끄기 (Off)" }
];

export function resolveThinkingConfig(level: string | null | undefined): ThinkingConfig {
  switch (level) {
    case "off":
      return { type: "disabled" };
    case "high":
      return { type: "enabled", budgetTokens: 31999 };
    case "adaptive":
    default:
      return { type: "adaptive" };
  }
}

export function thinkingLabel(level: string | null | undefined): string {
  return THINKING_OPTIONS.find((option) => option.id === level)?.label
    ?? "자동 (Adaptive)";
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

interface RunRequest {
  session: SessionRecord;
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  operation?: "prompt" | "compact";
}

interface PlanRequest {
  session: SessionRecord;
  instruction: string;
  codexModel?: string | undefined;
  codexReasoning?: CodexReasoningEffort | undefined;
}

interface SessionManagerOptions {
  debounceMs: number;
  claudeCodeOauthToken: string;
  claudeCodeExecutable?: string;
  mcpToolTimeoutMs: number;
  mcpMaxAttempts: number;
  codexMcpTimeoutMs: number;
  codexMcpHeartbeatMs: number;
  longRunningMcpServers: ReadonlySet<string>;
  turnIdleTimeoutMs: number;
  claudeMemoryDir: string;
  deleteClaudeSession?: typeof deleteClaudeSession;
}

interface ActiveRun {
  controller: AbortController;
  input: MessageQueue;
  pendingTurns: number;
  startedAt: number;
  query?: Query;
  codexTimers: Map<string, NodeJS.Timeout>;
  codexStarts: Map<string, number>;
  mcpFailures: Map<string, number>;
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

function codexEvidence(item: ThreadItem): {
  kind: PlanEvidenceKind;
  summary: string;
  details: Record<string, unknown>;
} | null {
  if (item.type === "command_execution") {
    return {
      kind: "command",
      summary: `${item.status}: ${item.command.split("\n")[0]?.slice(0, 500) ?? ""}`,
      details: {
        command: item.command,
        status: item.status,
        exitCode: item.exit_code ?? null,
        output: item.aggregated_output.slice(-20_000)
      }
    };
  }
  if (item.type === "file_change") {
    return {
      kind: "file_change",
      summary: `${item.status}: ${item.changes.map((change) => change.path).join(", ").slice(0, 1000)}`,
      details: { status: item.status, changes: item.changes }
    };
  }
  if (item.type === "todo_list") {
    const completed = item.items.filter((todo) => todo.completed).length;
    return {
      kind: "todo",
      summary: `${completed}/${item.items.length} 완료`,
      details: { items: item.items }
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      kind: "mcp",
      summary: `${item.status}: ${item.server}/${item.tool}`,
      details: {
        server: item.server,
        tool: item.tool,
        status: item.status,
        error: item.error?.message ?? null
      }
    };
  }
  if (item.type === "web_search") {
    return {
      kind: "web_search",
      summary: item.query.slice(0, 1000),
      details: { query: item.query }
    };
  }
  if (item.type === "agent_message") {
    return {
      kind: "agent_result",
      summary: item.text.slice(0, 2000),
      details: { text: item.text.slice(0, 20_000) }
    };
  }
  if (item.type === "error") {
    return {
      kind: "error",
      summary: item.message.slice(0, 2000),
      details: { message: item.message.slice(0, 20_000) }
    };
  }
  return null;
}

function formatCodexUsage(usage: Usage | null): string {
  if (!usage) return "사용량 정보 없음";
  return [
    `입력 ${usage.input_tokens.toLocaleString("ko-KR")}`,
    `캐시 ${usage.cached_input_tokens.toLocaleString("ko-KR")}`,
    `출력 ${usage.output_tokens.toLocaleString("ko-KR")}`,
    `추론 ${usage.reasoning_output_tokens.toLocaleString("ko-KR")}`
  ].join(" · ");
}

function addCodexUsage(current: Usage | null, next: Usage): Usage {
  if (!current) return next;
  return {
    input_tokens: current.input_tokens + next.input_tokens,
    cached_input_tokens: current.cached_input_tokens + next.cached_input_tokens,
    output_tokens: current.output_tokens + next.output_tokens,
    reasoning_output_tokens:
      current.reasoning_output_tokens + next.reasoning_output_tokens
  };
}

function summarize(text: string, length = 1200): string {
  const clean = text.trim();
  return clean.length <= length ? clean : `${clean.slice(0, length)}\n...`;
}

export function buildCodexEnvironment(
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
  return result;
}

export function requireCodexSubscriptionAuth(
  source: NodeJS.ProcessEnv = process.env
): void {
  const codexHome = source.CODEX_HOME?.trim() || join(homedir(), ".codex");
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

export function buildMemoryPrompt(focus?: string): string {
  const clean = focus?.replace(/\s+/g, " ").trim().slice(0, 1000);
  const scope = clean
    ? `사용자가 지정한 저장 초점: ${clean}`
    : "현재 세션 전체에서 앞으로도 반복해서 유용할 내용을 검토한다.";
  return [
    "[EXPLICIT_MEMORY_UPDATE]",
    "사용자가 /memory 명령으로 전역 장기 메모리 업데이트를 명시적으로 승인했다.",
    scope,
    `메모리는 시스템 프롬프트에 지정된 전역 메모리 디렉터리에만 기록한다.`,
    "기존 MEMORY.md와 관련 메모리 파일을 먼저 읽고, 중복 없이 최소 범위로 갱신한다.",
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
  for (const filename of ["CLAUDE.md", "AGENTS.md"]) {
    try {
      const content = readFileSync(join(cwd, filename), "utf8").trim();
      if (content) sections.push(`[${filename}]\n${content.slice(0, 100_000)}`);
    } catch {
      // Project instruction files are optional.
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

  constructor(
    private readonly store: StateStore,
    private readonly transport: MessageTransport,
    private readonly permissions: PermissionBroker,
    private readonly options: SessionManagerOptions
  ) {}

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
    leanMode = true
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
      model: model ?? null,
      thinking: thinking ?? null,
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
    if (!session.sdkSessionId || this.active.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({ session: this.store.getSession(session.id) ?? session, prompt, resumeSessionId: session.sdkSessionId });
    return true;
  }

  compact(session: SessionRecord, focus?: string): boolean {
    if (!session.sdkSessionId || this.active.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueue({
      session: this.store.getSession(session.id) ?? session,
      prompt: buildCompactCommand(focus),
      resumeSessionId: session.sdkSessionId,
      operation: "compact"
    });
    return true;
  }

  stop(sessionId: string): boolean {
    const run = this.active.get(sessionId);
    if (!run) return false;
    run.input.close();
    run.controller.abort();
    // close()는 hang된 for-await가 풀리길 기다리지 않고 CLI 서브프로세스를 즉시
    // 강제 종료한다 — in-flight MCP 호출/transport와 서브에이전트까지 함께 정리되어
    // 종료 후 MCP 호출이 남아 가로막는 문제를 막는다. finally의 close()는 멱등 백업.
    run.query?.close();
    return true;
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

  runPlanPipeline(
    session: SessionRecord,
    instruction: string,
    options?: { codexModel?: string; codexReasoning?: CodexReasoningEffort }
  ): boolean {
    const clean = instruction.trim();
    if (!clean || this.active.has(session.id) || this.sessionTasks.has(session.id)) return false;
    this.store.updateSession(session.id, { status: "queued" });
    this.enqueuePlan({
      session: this.store.getSession(session.id) ?? session,
      instruction: clean,
      codexModel: options?.codexModel,
      codexReasoning: options?.codexReasoning
    });
    return true;
  }

  async deleteSession(session: SessionRecord): Promise<void> {
    this.deleting.add(session.id);
    const wasActive = this.active.has(session.id);
    this.stop(session.id);
    this.store.deleteSession(session.id);

    const task = this.sessionTasks.get(session.id);
    if (wasActive && task) await task.catch(() => undefined);

    const sdkSessionId = session.sdkSessionId ?? session.id;
    const removeClaudeSession = this.options.deleteClaudeSession ?? deleteClaudeSession;
    await removeClaudeSession(sdkSessionId, { dir: session.cwd }).catch((error) => {
      console.error("Claude session deletion failed:", safeErrorMessage(error));
    });
    if (!task || wasActive) this.deleting.delete(session.id);
  }

  steer(sessionId: string, prompt: string): boolean {
    const run = this.active.get(sessionId);
    const clean = prompt.trim();
    if (!run || !clean) return false;
    run.pendingTurns += 1;
    if (run.input.push(buildUserMessage(clean, "now"))) return true;
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

  private enqueue(request: RunRequest): void {
    const cwd = request.session.cwd;
    const count = this.queuedCounts.get(cwd) ?? 0;
    this.queuedCounts.set(cwd, count + 1);
    const previous = this.projectTails.get(cwd) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(request))
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

  private enqueuePlan(request: PlanRequest): void {
    const cwd = request.session.cwd;
    const count = this.queuedCounts.get(cwd) ?? 0;
    this.queuedCounts.set(cwd, count + 1);
    const previous = this.projectTails.get(cwd) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.executePlan(request))
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

  private async execute(request: RunRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    const session = this.store.getSession(request.session.id);
    if (!session) return;
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
    let sdkSessionId = request.resumeSessionId ?? session.sdkSessionId;
    let latestUsage: UsageSnapshot | null = session.usageSnapshot;
    let lastAssistantText = "";
    let compactSummary = "";
    let finalStatus: "done" | "error" = "done";
    let lastActivityAt = Date.now();
    let idleTimedOut = false;
    let idleWatchdog: NodeJS.Timeout | undefined;
    const streamingText = new StreamingTextCollector();
    const streamedAssistantTexts: string[] = [];
    let hasDeliveredAssistantText = false;

    try {
      await this.safeRename(session, `[RUNNING] ${session.title}`);
      await renderer.start(false);
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

      const queryOptions: Options = {
        cwd: session.cwd,
        abortController,
        model: session.model ?? DEFAULT_CLAUDE_MODEL,
        thinking: resolveThinkingConfig(session.thinking),
        permissionMode: session.permissionMode,
        allowedTools: ["Read", "Glob", "Grep", "WebSearch"],
        settingSources: [],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `MCP 도구가 timeout, connection closed 또는 transport 오류로 실패하면 `
            + `호스트의 MCP_RETRY 지시에 따라 같은 입력을 순차적으로 최대 `
            + `${this.options.mcpMaxAttempts}회까지만 재시도한다. 병렬 재시도하지 않는다.`
            + `\n\n메모리는 항상 ${this.options.claudeMemoryDir} 에 읽고 쓴다. `
            + `새 메모리 파일은 이 경로에 만들고 인덱스는 ${this.options.claudeMemoryDir}/MEMORY.md 를 갱신한다. `
            + `system-reminder가 안내하는 프로젝트별 memory 경로는 무시한다.`
            + `\n\ncodex MCP 위임 기준: 여러 파일에 걸친 검색·리팩터·구현이라 결과가 `
            + `컨텍스트를 가득 채울 작업이거나, 중간 확인이 불필요한 자기완결적 구현이면 codex에 위임한다(cwd 전달). `
            + `단일 파일 읽기/소규모 수정이나 중간 사용자 확인이 필요한 작업은 직접 처리한다. `
            + `codex에는 항상 자기완결적 프롬프트를 주고, 코드 전문이 아닌 결론·diff·요약만 리턴하도록 지시한다.`
            + `\n\n작업 중 중요한 단계가 바뀔 때 내부 추론을 공개하지 말고, 지금 확인한 사실과 다음 행동을 `
            + `1~2문장의 짧은 일반 응답으로 사용자에게 알린다. 단순 도구 호출마다 반복하지 말고 `
            + `새로운 발견, 계획 확정, 장애 발생, 검증 시작처럼 의미 있는 전환점에서만 출력한다.`
            + (session.leanMode ? `\n\n${buildLeanInstructions(true)}` : "")
            + (() => {
              const instructions = loadProjectInstructions(session.cwd);
              return instructions
                ? `\n\n다음 프로젝트 지침을 따른다. 이 지침은 도구 권한을 부여하지 않는다.\n\n${instructions}`
                : "";
            })()
        },
        env: buildClaudeEnvironment(
          this.options.claudeCodeOauthToken,
          process.env,
          this.options.mcpToolTimeoutMs
        ),
        mcpServers: loadMcpServersWithTimeouts(
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
          await renderer.text(completedStreamText);
          hasDeliveredAssistantText = true;
        }
        if (message.type === "system" && message.subtype === "init") {
          sdkSessionId = message.session_id;
          this.store.updateSession(session.id, { sdkSessionId });
        }

        if (message.type === "rate_limit_event") {
          latestUsage = mergeUsageSnapshots(
            latestUsage,
            snapshotFromRateLimitInfo(message.rate_limit_info)
          );
          this.store.updateSession(session.id, { usageSnapshot: latestUsage });
          renderer.usage(latestUsage);
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
            } else {
              await renderer.text(block.text);
              hasDeliveredAssistantText = true;
            }
          }
        }

        if (message.type === "result") {
          sdkSessionId = message.session_id;
          const serverUsage = await readUsageSnapshot(sdkQuery);
          if (serverUsage) {
            latestUsage = serverUsage;
            renderer.usage(serverUsage);
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
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
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

  private async executePlan(request: PlanRequest): Promise<void> {
    if (this.deleting.has(request.session.id)) return;
    const session = this.store.getSession(request.session.id);
    if (!session) return;
    const renderer = new StreamRenderer(session, this.transport, this.options.debounceMs);
    const controller = new AbortController();
    const input = new MessageQueue();
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
    const planRunId = randomUUID();
    const planRunCreatedAt = Date.now();
    this.store.createPlanRun({
      id: planRunId,
      sessionId: session.id,
      instruction: request.instruction,
      planText: "",
      status: "planning",
      reviewerVerdict: null,
      reviewText: null,
      codexResult: null,
      attemptCount: 0,
      createdAt: planRunCreatedAt,
      updatedAt: planRunCreatedAt,
      completedAt: null
    });
    let timedOut = false;
    let overallTimeout: NodeJS.Timeout | undefined;

    try {
      await this.safeRename(session, `[PLAN] ${session.title}`);
      await renderer.start(false);
      this.store.updateSession(session.id, { status: "running" });

      renderer.note("Claude 구현 계획 작성 중");
      let plan = await this.runReadOnlyClaude(
        session,
        controller,
        run,
        buildPlanPrompt(request.instruction),
        true
      );
      let criteria = parseAcceptanceCriteria(plan);
      if (criteria.length === 0) {
        renderer.note("완료 기준 형식 보정 중");
        plan = await this.runReadOnlyClaude(
          session,
          controller,
          run,
          buildPlanPrompt(
            request.instruction,
            plan,
            "계획 마지막의 [ACCEPTANCE_CRITERIA] 블록이 누락됐습니다. 계획 내용은 유지하고 독립 검증 가능한 기준을 추가하세요."
          ),
          true
        );
        criteria = parseAcceptanceCriteria(plan);
      }
      if (criteria.length === 0) {
        throw new Error("계획에 구조화된 완료 기준이 없어 실행을 시작하지 않았습니다.");
      }
      while (true) {
        this.store.updatePlanRun(planRunId, {
          planText: plan,
          status: "awaiting_approval"
        });
        this.store.replacePlanCriteria(planRunId, criteria);
        await renderer.text(`[PLAN]\n${plan}`);
        const decision = await this.permissions.requestPlanDecision(session, controller.signal);
        if (controller.signal.aborted) throw new Error("Plan approval aborted");
        if (decision.action === "approve") break;
        if (decision.action === "reject") {
          run.pendingTurns = 0;
          this.store.updatePlanRun(planRunId, {
            status: "rejected",
            completedAt: Date.now()
          });
          this.store.updateSession(session.id, { status: "done" });
          await renderer.finish("done", "사용자가 계획을 거절해 파이프라인을 종료했습니다.");
          await this.safeRename(session, `[STOP] ${session.title}`);
          return;
        }

        renderer.note("Claude 계획 재작성 중");
        plan = await this.runReadOnlyClaude(
          session,
          controller,
          run,
          buildPlanPrompt(request.instruction, plan, decision.text ?? ""),
          true
        );
        criteria = parseAcceptanceCriteria(plan);
        if (criteria.length === 0) {
          throw new Error("수정된 계획에 구조화된 완료 기준이 없어 실행을 시작하지 않았습니다.");
        }
      }

      this.store.updatePlanRun(planRunId, { status: "executing" });
      requireCodexSubscriptionAuth();
      overallTimeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        run.query?.close();
      }, this.options.codexMcpTimeoutMs);
      const codexModel = request.codexModel ?? DEFAULT_CODEX_MODEL;
      const codexReasoning = request.codexReasoning ?? DEFAULT_CODEX_REASONING;
      renderer.note(
        `Codex 계획 실행 시작 (${codexModelLabel(codexModel)} · ${codexReasoningLabel(codexReasoning)})`
      );
      run.codexStarts.set("plan-codex", Date.now());
      const codex = new Codex({ env: buildCodexEnvironment() });
      const thread = codex.startThread({
        model: codexModel,
        modelReasoningEffort: codexReasoning,
        workingDirectory: session.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "never"
      });
      let finalResponse = "";
      let codexUsage: Usage | null = null;
      let finalReview: ReturnType<typeof parsePlanReview> | null = null;
      let codexPrompt =
        `다음 구현 계획을 현재 작업 디렉터리에서 끝까지 실행하세요. `
        + `필요한 파일을 수정하고 관련 테스트와 타입 검사를 실제로 실행하세요. `
        + `각 완료 기준을 어떤 명령과 결과로 검증했는지 최종 응답에 명시하세요.`
        + (session.leanMode ? `\n\n${buildLeanInstructions(true)}` : "")
        + `\n\n${plan}`;

      for (let attempt = 1; attempt <= MAX_PLAN_EXECUTION_ATTEMPTS; attempt += 1) {
        this.store.updatePlanRun(planRunId, {
          status: "executing",
          attemptCount: attempt
        });
        renderer.note(`Codex 실행 ${attempt}/${MAX_PLAN_EXECUTION_ATTEMPTS}`);
        run.codexStarts.set("plan-codex", Date.now());
        const streamed = await thread.runStreamed(codexPrompt, { signal: controller.signal });
        let attemptResponse = "";
        let codexCompleted = false;
        try {
          for await (const event of streamed.events) {
            if (event.type === "item.completed") {
              if (event.item.type === "agent_message") attemptResponse = event.item.text;
              const progress = codexProgress(event.item);
              if (progress) renderer.note(progress);
              const recorded = codexEvidence(event.item);
              if (recorded) {
                this.store.addPlanEvidence({
                  id: randomUUID(),
                  planRunId,
                  criterionId: null,
                  kind: recorded.kind,
                  source: "codex",
                  summary: `시도 ${attempt}: ${recorded.summary}`,
                  details: { attempt, ...recorded.details },
                  createdAt: Date.now()
                });
              }
            } else if (event.type === "turn.completed") {
              codexUsage = addCodexUsage(codexUsage, event.usage);
              codexCompleted = true;
            } else if (event.type === "turn.failed") {
              throw new Error(`Codex 실행 실패: ${event.error.message}`);
            } else if (event.type === "error") {
              throw new Error(`Codex 스트림 오류: ${event.message}`);
            }
          }
        } finally {
          run.codexStarts.delete("plan-codex");
        }
        if (!codexCompleted) throw new Error("Codex 실행이 완료 이벤트 없이 종료되었습니다.");
        finalResponse = attemptResponse || finalResponse;
        this.store.updatePlanRun(planRunId, { codexResult: finalResponse });

        const changes = await this.captureGitChanges(session.cwd);
        this.store.addPlanEvidence({
          id: randomUUID(),
          planRunId,
          criterionId: null,
          kind: "git_status",
          source: "orchestrator",
          summary: `시도 ${attempt}: ${changes.status || "변경 없음"}`,
          details: { attempt, status: changes.status },
          createdAt: Date.now()
        });
        this.store.addPlanEvidence({
          id: randomUUID(),
          planRunId,
          criterionId: null,
          kind: "git_diff",
          source: "orchestrator",
          summary: `시도 ${attempt}: ${changes.diff ? "git diff 캡처 완료" : "git diff 없음"}`,
          details: { attempt, diff: changes.diff.slice(0, 200_000) },
          createdAt: Date.now()
        });
        renderer.note(`Claude 완료 검토 ${attempt}/${MAX_PLAN_EXECUTION_ATTEMPTS}`);
        this.store.updatePlanRun(planRunId, { status: "reviewing" });
        const evidence = this.store.listPlanEvidence(planRunId);
        const reviewText = await this.runReadOnlyClaude(
          session,
          controller,
          run,
          buildReviewPrompt(plan, finalResponse, criteria, evidence, changes.status, changes.diff)
        );
        const review = parsePlanReview(reviewText, criteria.length);
        finalReview = review;
        const storedCriteria = this.store.listPlanCriteria(planRunId);
        for (const criterion of review.criteria) {
          const stored = storedCriteria[criterion.ordinal - 1];
          if (!stored) continue;
          this.store.updatePlanCriterion(stored.id, criterion.status, criterion.evidence);
          this.store.addPlanEvidence({
            id: randomUUID(),
            planRunId,
            criterionId: stored.id,
            kind: "review",
            source: "claude",
            summary: `시도 ${attempt} ${criterion.status}: ${criterion.evidence}`,
            details: {
              attempt,
              ordinal: criterion.ordinal,
              status: criterion.status,
              description: stored.description
            },
            createdAt: Date.now()
          });
        }
        this.store.addPlanEvidence({
          id: randomUUID(),
          planRunId,
          criterionId: null,
          kind: "review",
          source: "claude",
          summary: `시도 ${attempt} ${review.verdict}: ${review.summary}`,
          details: {
            attempt,
            verdict: review.verdict,
            blockers: review.blockers,
            criteria: review.criteria,
            raw: reviewText.slice(0, 20_000)
          },
          createdAt: Date.now()
        });
        this.store.updatePlanRun(planRunId, {
          reviewerVerdict: review.verdict,
          reviewText
        });
        if (review.approved || attempt === MAX_PLAN_EXECUTION_ATTEMPTS) break;

        await renderer.text(
          `[검증 실패 ${attempt}/${MAX_PLAN_EXECUTION_ATTEMPTS}]\n`
          + `${formatStructuredReview(review)}\n\n`
          + "같은 Codex 스레드에서 차단 문제를 수정하고 다시 검증합니다."
        );
        const failedCriteria = review.criteria
          .filter((criterion) => criterion.status !== "pass")
          .map((criterion) => `${criterion.ordinal}. ${criterion.status}: ${criterion.evidence}`)
          .join("\n");
        codexPrompt = [
          "독립 검토에서 구현이 거절되었습니다. 설명만 하지 말고 현재 작업 디렉터리의 파일을 직접 수정하세요.",
          "아래 차단 문제와 실패 기준만 해결하되 기존에 통과한 동작을 회귀시키지 마세요.",
          "수정 후 관련 테스트와 타입 검사를 실제로 다시 실행하고 결과를 보고하세요.",
          "",
          "[차단 문제]",
          review.blockers.length > 0 ? review.blockers.map((item) => `- ${item}`).join("\n") : "- 명시된 차단 문제 없음",
          "",
          "[실패 또는 차단된 완료 기준]",
          failedCriteria || "- 검토 형식 또는 증거가 부족함",
          "",
          "[검토 요약]",
          review.summary
        ].join("\n");
      }

      if (!finalReview) throw new Error("Claude 완료 검토 결과가 생성되지 않았습니다.");
      this.store.updatePlanRun(planRunId, {
        status: finalReview.approved ? "passed" : "failed",
        completedAt: Date.now()
      });

      run.pendingTurns = 0;
      this.store.updateSession(session.id, {
        status: finalReview.approved ? "done" : "verification_failed"
      });
      await renderer.finish(
        finalReview.approved ? "done" : "error",
        [
          finalReview.approved ? "[PLAN PIPELINE 완료]" : "[PLAN PIPELINE 검증 실패]",
          "",
          "계획 요약",
          summarize(plan),
          "",
          "Codex 실행 결과",
          summarize(finalResponse || "최종 응답 없음"),
          "",
          "Claude 검토",
          formatStructuredReview(finalReview),
          "",
          `Codex 사용량: ${formatCodexUsage(codexUsage)}`
        ].join("\n")
      );
      await this.safeRename(
        session,
        `${finalReview.approved ? "[DONE]" : "[REVIEW FAILED]"} ${session.title}`
      );
    } catch (error) {
      if (this.deleting.has(session.id) || !this.store.getSession(session.id)) return;
      const aborted = controller.signal.aborted && !timedOut;
      this.store.updatePlanRun(planRunId, {
        status: aborted ? "aborted" : "failed",
        reviewText: safeErrorMessage(error),
        completedAt: Date.now()
      });
      this.store.updateSession(session.id, { status: aborted ? "aborted" : "error" });
      await renderer.finish(
        aborted ? "aborted" : "error",
        timedOut
          ? `Plan 파이프라인이 ${Math.round(this.options.codexMcpTimeoutMs / 60_000)}분 제한을 초과해 중단되었습니다.`
          : aborted
            ? "사용자가 Plan 파이프라인을 중단했습니다."
            : `Plan 파이프라인 실패: ${safeErrorMessage(error)}`
      );
      await this.safeRename(
        session,
        `${aborted ? "[STOP]" : timedOut ? "[STALL]" : "[ERROR]"} ${session.title}`
      );
    } finally {
      if (overallTimeout) clearTimeout(overallTimeout);
      renderer.dispose();
      input.close();
      run.query?.close();
      this.active.delete(session.id);
    }
  }

  private async runReadOnlyClaude(
    session: SessionRecord,
    controller: AbortController,
    run: ActiveRun,
    prompt: string,
    allowQuestions = false
  ): Promise<string> {
    const instructions = loadProjectInstructions(session.cwd);
    const sdkQuery = query({
      prompt,
      options: {
        cwd: session.cwd,
        abortController: controller,
        model: session.model ?? DEFAULT_CLAUDE_MODEL,
        thinking: resolveThinkingConfig(session.thinking),
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
          this.options.claudeCodeOauthToken,
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

  private async captureGitChanges(cwd: string): Promise<{ status: string; diff: string }> {
    try {
      await execFileAsync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
        timeout: 5000
      });
      const [status, diff] = await Promise.all([
        execFileAsync("git", ["-C", cwd, "status", "--porcelain"], {
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024
        }),
        execFileAsync("git", ["-C", cwd, "diff"], {
          timeout: 20_000,
          maxBuffer: 10 * 1024 * 1024
        })
      ]);
      return { status: status.stdout.trim(), diff: diff.stdout.trim() };
    } catch {
      return { status: "git 저장소가 아니거나 변경 사항을 읽을 수 없습니다.", diff: "" };
    }
  }

  private async safeRename(session: SessionRecord, title: string): Promise<void> {
    await this.transport.renameTopic(session.chatId, session.topicId, title).catch((error) => {
      console.error("Telegram topic rename failed:", safeErrorMessage(error));
    });
  }
}
