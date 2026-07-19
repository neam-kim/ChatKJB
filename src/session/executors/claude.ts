import {
  query,
  renameSession,
  type HookCallback,
  type Options,
  type Query,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { appLocale } from "../../localization.js";
import { isRetryableMcpError, mcpCallKey, mcpServerName } from "../../mcp-policy.js";
import { DEFAULT_CLAUDE_MODEL, normalizeThinkingForModel } from "../../model-catalog.js";
import type { PermissionBroker } from "../../permission-broker.js";
import { loadClaudeConnectors } from "../../connectors.js";
import { MessageQueue, StreamingTextCollector } from "../../session-collectors.js";
import { buildClaudeEnvironment } from "../../session-environment.js";
import {
  assistantBlocks,
  buildUserMessage,
  resultSummary
} from "../../session-prompts.js";
import {
  isOverloadedError,
  isRateLimitError,
  readUsageSnapshot
} from "../../session-usage.js";
import {
  buildClaudeSystemPromptAppend,
  limitResumeRequest,
  promptForClaudeRequest,
  resolveClaudeEffort,
  resolveThinkingConfig,
  type RunRequest
} from "../prompt-builders.js";
import { resultFailureText } from "../provider-progress.js";
import { StreamRenderer } from "../../stream-renderer.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { TokenPool } from "../../token-pool.js";
import type { SessionRecord, UsageSnapshot } from "../../types.js";
import { mergeUsageSnapshots, snapshotFromRateLimitInfo } from "../../usage.js";
import {
  queueRequestedUserInput,
  type ActiveRun,
  type BaseExecutorHost
} from "./shared.js";

const MAX_OVERLOAD_RETRIES = 5;
const OVERLOAD_RETRY_BASE_MS = 5_000;
const OVERLOAD_RETRY_CAP_MS = 60_000;

export interface ClaudeRunContext {
  request: RunRequest;
  session: SessionRecord;
  renderer: StreamRenderer;
  run: ActiveRun;
  abortController: AbortController;
  input: MessageQueue;
  oauthToken: string;
  tokenIndex: number;
  claudeModel: string;
  sdkQuery?: Query;
  sdkSessionId: string | null;
  latestUsage: UsageSnapshot | null;
  currentTokenUsage: UsageSnapshot | null;
  lastAssistantText: string;
  compactSummary: string;
  finalStatus: "done" | "error";
  lastActivityAt: number;
  idleTimedOut: boolean;
  idleWatchdog?: NodeJS.Timeout;
  streamingText: StreamingTextCollector;
  streamedAssistantTexts: string[];
  hasDeliveredAssistantText: boolean;
  rateLimitRejected: boolean;
  receivedMessageCount: number;
  receivedResult: boolean;
}

interface ClaudeHooks {
  startCodexHeartbeat: (toolName: string, toolUseId: string) => void;
  postToolUse: HookCallback;
  postToolUseFailure: HookCallback;
  stop: HookCallback;
}

class ClaudeStreamEndedWithoutResultError extends Error {
  constructor(readonly receivedMessageCount: number) {
    super("Claude SDK stream ended before a result message was received.");
    this.name = "ClaudeStreamEndedWithoutResultError";
  }
}

export interface ClaudeExecutorHost extends BaseExecutorHost {
  permissions: PermissionBroker;
  tokenPool: TokenPool;
  oauthTokens: string[];
  selectToken: (session: SessionRecord, claudeModel: string) => string;
  markRateLimited: (oauthToken: string, error: unknown) => void;
  enqueue: (request: RunRequest) => void;
  scheduleLimitResume: (
    session: SessionRecord,
    request: RunRequest,
    resumeSessionId: string | null,
    resumeAt: number
  ) => void;
  handleGoalCompletion: (session: SessionRecord, request: RunRequest) => void;
}

export interface ClaudeExecutorDependencies {
  createQuery: typeof query;
  renameSdkSession: typeof renameSession;
}

const DEFAULT_DEPENDENCIES: ClaudeExecutorDependencies = {
  createQuery: query,
  renameSdkSession: renameSession
};

/** Claude SDK 턴과 그에 딸린 watchdog·MCP·재시도 자원을 전담한다. */
export class ClaudeExecutor {
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleWatchdogs = new Set<NodeJS.Timeout>();
  private disposed = false;

  constructor(
    private readonly host: ClaudeExecutorHost,
    private readonly dependencies: ClaudeExecutorDependencies = DEFAULT_DEPENDENCIES
  ) {}

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const timer of this.idleWatchdogs) clearInterval(timer);
    this.idleWatchdogs.clear();
  }

  cancelRetry(sessionId: string): boolean {
    const timer = this.retryTimers.get(sessionId);
    if (!timer) return false;
    clearTimeout(timer);
    this.retryTimers.delete(sessionId);
    return true;
  }

  async execute(request: RunRequest): Promise<void> {
    const ctx = this.prepareRun(request);
    if (!ctx) return;
    try {
      if (!await this.startTurn(ctx)) return;
      for await (const message of ctx.sdkQuery!) {
        ctx.receivedMessageCount += 1;
        if (await this.handleStreamMessage(message, ctx)) break;
      }
      if (!ctx.receivedResult) {
        throw new ClaudeStreamEndedWithoutResultError(ctx.receivedMessageCount);
      }
      await this.finalizeTurn(ctx);
    } catch (error) {
      await this.handleRunError(error, ctx);
    } finally {
      this.cleanupRun(ctx);
    }
  }

  private prepareRun(request: RunRequest): ClaudeRunContext | null {
    if (this.host.deleting.has(request.session.id)) return null;
    let session = this.host.store.getSession(request.session.id);
    if (!session) return null;
    const claudeModel = session.model ?? DEFAULT_CLAUDE_MODEL;

    // 토큰 선택은 실패할 수 있으므로 active 등록보다 먼저 수행한다.
    const oauthToken = this.host.selectToken(session, claudeModel);
    const tokenIndex = this.host.tokenPool.indexOf(oauthToken);
    request = this.host.applyHandoffSummary(request, session);
    session = this.host.store.getSession(request.session.id) ?? session;
    const renderer = new StreamRenderer(
      session,
      this.host.transport,
      this.host.options.debounceMs
    );
    const abortController = new AbortController();
    const input = new MessageQueue();
    input.push(buildUserMessage(promptForClaudeRequest(request)));
    const run: ActiveRun = {
      controller: abortController,
      input,
      pendingTurns: 1,
      startedAt: Date.now(),
      codexTimers: new Map(),
      codexStarts: new Map(),
      mcpFailures: new Map()
    };
    this.host.active.set(session.id, run);
    return {
      request,
      session,
      renderer,
      run,
      abortController,
      input,
      oauthToken,
      tokenIndex,
      claudeModel,
      sdkSessionId: request.resumeSessionId ?? session.sdkSessionId,
      latestUsage: session.usageSnapshot,
      currentTokenUsage: null,
      lastAssistantText: "",
      compactSummary: "",
      // SDK result가 실제로 success를 알려 주기 전까지는 완료로 가정하지 않는다.
      finalStatus: "error",
      lastActivityAt: Date.now(),
      idleTimedOut: false,
      streamingText: new StreamingTextCollector(),
      streamedAssistantTexts: [],
      hasDeliveredAssistantText: false,
      rateLimitRejected: false,
      receivedMessageCount: 0,
      receivedResult: false
    };
  }

  private buildQueryOptions(ctx: ClaudeRunContext, hooks: ClaudeHooks): Options {
    const { startCodexHeartbeat, postToolUse, postToolUseFailure, stop } = hooks;
    const thinking = normalizeThinkingForModel(
      this.host.options.modelCatalog,
      ctx.claudeModel,
      ctx.session.thinking
    );
    const effort = resolveClaudeEffort(ctx.session.claudeEffort);
    return {
      cwd: ctx.session.cwd,
      abortController: ctx.abortController,
      model: ctx.claudeModel,
      thinking: resolveThinkingConfig(thinking),
      ...(effort ? { effort } : {}),
      permissionMode: ctx.session.permissionMode,
      allowedTools: ["Read", "Glob", "Grep", "WebSearch", "Task"],
      settingSources: ["user"],
      skills: "all",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: buildClaudeSystemPromptAppend(ctx.session, {
          mcpMaxAttempts: this.host.options.mcpMaxAttempts,
          claudeMemoryDir: this.host.options.claudeMemoryDir
        })
      },
      env: buildClaudeEnvironment(
        ctx.oauthToken,
        process.env,
        this.host.options.mcpToolTimeoutMs
      ),
      mcpServers: loadClaudeConnectors(
        this.host.options.mcpToolTimeoutMs,
        this.host.options.codexMcpTimeoutMs,
        this.host.options.longRunningMcpServers
      ),
      hooks: {
        PostToolUse: [{ hooks: [postToolUse] }],
        PostToolUseFailure: [{ hooks: [postToolUseFailure] }],
        Stop: [{ hooks: [stop] }]
      },
      includePartialMessages: true,
      canUseTool: async (toolName, toolInput, permissionOptions) => {
        const result = await this.host.permissions.request(
          this.host.store.getSession(ctx.session.id) ?? ctx.session,
          toolName,
          toolInput,
          permissionOptions
        );
        if (result.behavior === "allow") {
          startCodexHeartbeat(toolName, permissionOptions.toolUseID);
        }
        return result;
      },
      ...(ctx.request.resumeSessionId ? { resume: ctx.request.resumeSessionId } : {}),
      ...(ctx.request.forkSession ? { forkSession: true } : {}),
      ...(!ctx.request.resumeSessionId && !ctx.request.forkSession
        ? { sessionId: ctx.session.id }
        : {}),
      ...(this.host.options.claudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.host.options.claudeCodeExecutable }
        : {})
    };
  }

  private startIdleWatchdog(ctx: ClaudeRunContext): void {
    ctx.lastActivityAt = Date.now();
    ctx.idleWatchdog = setInterval(() => {
      if (this.host.store.getSession(ctx.session.id)?.status === "waiting_approval") return;
      if (Date.now() - ctx.lastActivityAt <= this.host.options.turnIdleTimeoutMs) return;
      ctx.idleTimedOut = true;
      ctx.abortController.abort();
      ctx.run.query?.close();
    }, Math.min(30_000, this.host.options.turnIdleTimeoutMs));
    this.idleWatchdogs.add(ctx.idleWatchdog);
  }

  private handleRateLimitEvent(message: SDKMessage, ctx: ClaudeRunContext): void {
    if (message.type !== "rate_limit_event") return;
    if (message.rate_limit_info.status === "rejected") ctx.rateLimitRejected = true;
    ctx.currentTokenUsage = mergeUsageSnapshots(
      ctx.currentTokenUsage,
      snapshotFromRateLimitInfo(message.rate_limit_info)
    );
    ctx.latestUsage = ctx.currentTokenUsage;
    this.host.store.updateSession(ctx.session.id, { usageSnapshot: ctx.latestUsage });
    ctx.renderer.usage(ctx.latestUsage);
    this.host.tokenPool.observe(ctx.oauthToken, ctx.currentTokenUsage);
  }

  private handleCompactBoundary(message: SDKMessage, ctx: ClaudeRunContext): void {
    if (message.type === "system" && message.subtype === "compact_boundary") {
      const before = message.compact_metadata.pre_tokens.toLocaleString(appLocale());
      const after = message.compact_metadata.post_tokens?.toLocaleString(appLocale());
      ctx.compactSummary = after
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
  }

  private async renderAssistantBlocks(message: SDKMessage, ctx: ClaudeRunContext): Promise<void> {
    for (const block of assistantBlocks(message)) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        ctx.renderer.tool(
          block.name,
          block.input && typeof block.input === "object"
            ? block.input as Record<string, unknown>
            : {}
        );
      }
      if (block.type === "text" && typeof block.text === "string") {
        ctx.lastAssistantText = block.text.trim();
        const streamedIndex = ctx.streamedAssistantTexts.indexOf(ctx.lastAssistantText);
        if (streamedIndex >= 0) {
          ctx.streamedAssistantTexts.splice(streamedIndex, 1);
        } else if (
          !isRateLimitError(ctx.lastAssistantText)
          && !isOverloadedError(ctx.lastAssistantText)
        ) {
          await ctx.renderer.text(block.text);
          ctx.hasDeliveredAssistantText = true;
        }
      }
    }
  }

  private async handleResultMessage(message: SDKMessage, ctx: ClaudeRunContext): Promise<boolean> {
    if (message.type !== "result") return false;
    ctx.receivedResult = true;
    ctx.sdkSessionId = message.session_id;
    const serverUsage = await readUsageSnapshot(ctx.sdkQuery!);
    if (serverUsage) {
      ctx.currentTokenUsage = serverUsage;
      ctx.latestUsage = serverUsage;
      ctx.renderer.usage(serverUsage);
    }
    this.host.tokenPool.observe(ctx.oauthToken, ctx.currentTokenUsage);
    const failureText = resultFailureText(message, ctx.rateLimitRejected);
    if (failureText) throw new Error(failureText);
    ctx.lastAssistantText = await queueRequestedUserInput(
      this.host,
      ctx.session,
      ctx.run,
      ctx.input,
      ctx.abortController.signal,
      ctx.lastAssistantText
    );
    ctx.run.pendingTurns = Math.max(0, ctx.run.pendingTurns - 1);
    ctx.finalStatus = message.subtype === "success" ? "done" : "error";
    this.host.store.updateSession(ctx.session.id, {
      sdkSessionId: ctx.sdkSessionId,
      usageSnapshot: ctx.latestUsage,
      status: ctx.run.pendingTurns === 0 ? ctx.finalStatus : "running"
    });
    if (ctx.run.pendingTurns === 0) {
      ctx.input.cancel();
      await ctx.renderer.finish(
        ctx.finalStatus,
        ctx.request.operation === "compact" && ctx.compactSummary
          ? ctx.compactSummary
          : resultSummary(message, ctx.hasDeliveredAssistantText)
      );
      return true;
    }
    ctx.renderer.note(`예약 메시지 ${ctx.run.pendingTurns}개 처리 대기`);
    return false;
  }

  private async handleStreamMessage(message: SDKMessage, ctx: ClaudeRunContext): Promise<boolean> {
    if (this.host.deleting.has(ctx.session.id)) return false;
    ctx.lastActivityAt = Date.now();
    const completedStreamText = ctx.streamingText.accept(message);
    if (completedStreamText) {
      ctx.streamedAssistantTexts.push(completedStreamText);
      if (!isRateLimitError(completedStreamText) && !isOverloadedError(completedStreamText)) {
        await ctx.renderer.text(completedStreamText);
        ctx.hasDeliveredAssistantText = true;
      }
    }
    if (message.type === "system" && message.subtype === "init") {
      ctx.sdkSessionId = message.session_id;
      this.host.store.updateSession(ctx.session.id, { sdkSessionId: ctx.sdkSessionId });
    }
    this.handleRateLimitEvent(message, ctx);
    this.handleCompactBoundary(message, ctx);
    await this.renderAssistantBlocks(message, ctx);
    return this.handleResultMessage(message, ctx);
  }

  private async finalizeTurn(ctx: ClaudeRunContext): Promise<void> {
    if (ctx.idleTimedOut || ctx.abortController.signal.aborted) {
      throw new Error("turn aborted");
    }
    if (ctx.sdkSessionId) {
      await this.dependencies.renameSdkSession(
        ctx.sdkSessionId,
        ctx.session.title,
        { dir: ctx.session.cwd }
      ).catch(() => undefined);
    }
    const current = this.host.store.getSession(ctx.session.id);
    if (current?.status === "running") {
      this.host.store.updateSession(ctx.session.id, { status: ctx.finalStatus });
      await ctx.renderer.finish(ctx.finalStatus, ctx.compactSummary);
    }
    await this.host.safeRename(
      ctx.session,
      `${ctx.finalStatus === "done" ? "[DONE]" : "[ERROR]"} ${ctx.session.title}`
    );
    if (ctx.finalStatus === "done") {
      const latest = this.host.store.getSession(ctx.session.id);
      if (latest) this.host.handleGoalCompletion(latest, ctx.request);
    }
  }

  private async handleRunError(error: unknown, ctx: ClaudeRunContext): Promise<void> {
    if (this.host.deleting.has(ctx.session.id) || !this.host.store.getSession(ctx.session.id)) return;
    if (ctx.idleTimedOut) {
      console.error(
        `Claude run failed (session=${ctx.session.id}, token=#${ctx.tokenIndex + 1}):`,
        safeErrorMessage(error, this.host.oauthTokens)
      );
      const minutes = Math.round(this.host.options.turnIdleTimeoutMs / 60_000);
      this.host.store.updateSession(ctx.session.id, { status: "error" });
      await ctx.renderer.finish(
        "error",
        `${minutes}분간 어떤 진행도 없어 작업을 중단했습니다. `
        + "MCP 서버 또는 SDK가 응답하지 않는(먹통) 상태일 수 있습니다."
      );
      await this.host.safeRename(ctx.session, `[STALL] ${ctx.session.title}`);
      return;
    }
    // 서비스 재시작 정리 abort는 새 데몬의 자동 복구가 이어받도록 running 상태를 남긴다.
    if (ctx.run.serviceShutdownRequested && ctx.abortController.signal.aborted) return;
    if (await this.recoverEmptyResumeStream(error, ctx)) return;
    console.error(
      `Claude run failed (session=${ctx.session.id}, token=#${ctx.tokenIndex + 1}):`,
      safeErrorMessage(error, this.host.oauthTokens)
    );
    if (ctx.abortController.signal.aborted) {
      this.host.store.updateSession(ctx.session.id, { status: "aborted" });
      await ctx.renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
      await this.host.safeRename(ctx.session, `[STOP] ${ctx.session.title}`);
      return;
    }
    if (isRateLimitError(error) && await this.handleRateLimit(error, ctx)) return;
    if (isOverloadedError(error) && await this.handleOverload(ctx)) return;

    this.host.store.updateSession(ctx.session.id, { status: "error" });
    await ctx.renderer.finish("error", String(error));
    await this.host.safeRename(ctx.session, `[ERROR] ${ctx.session.title}`);
  }

  private async recoverEmptyResumeStream(
    error: unknown,
    ctx: ClaudeRunContext
  ): Promise<boolean> {
    if (!(error instanceof ClaudeStreamEndedWithoutResultError)) return false;
    const recoveryCount = ctx.request.claudeEmptyStreamRecoveryCount ?? 0;
    const resumeSessionId = ctx.request.resumeSessionId ?? ctx.session.sdkSessionId;
    const isUserPrompt = !ctx.request.operation || ctx.request.operation === "prompt";
    if (
      error.receivedMessageCount !== 0
      || !resumeSessionId
      || recoveryCount >= 1
      || !isUserPrompt
      || ctx.abortController.signal.aborted
    ) {
      return false;
    }

    console.warn(
      `Claude resume stream ended without messages; forking once (session=${ctx.session.id}).`
    );
    ctx.renderer.note(
      "Claude 재개 응답이 비어 있어 기존 문맥을 새 세션으로 분기해 1회 자동 복구합니다."
    );
    await this.host.safeRename(ctx.session, `[RECOVER] ${ctx.session.title}`);
    this.host.store.updateSession(ctx.session.id, { status: "queued" });
    const recoveryRequest: RunRequest = { ...ctx.request };
    delete recoveryRequest.limitResume;
    this.host.enqueue({
      ...recoveryRequest,
      prompt:
        "[Claude SDK 자동 복구]\n"
        + "직전 재개 프로세스가 아래 요청에 응답하기 전에 결과 없이 종료되었습니다. "
        + "이미 대화에 기록된 같은 요청을 중복 작업하지 말고, 한 번만 이어서 완료하십시오.\n\n"
        + `[USER_REQUEST]\n${ctx.request.prompt}\n[/USER_REQUEST]`,
      resumeSessionId,
      forkSession: true,
      claudeEmptyStreamRecoveryCount: recoveryCount + 1
    });
    return true;
  }

  private cleanupRun(ctx: ClaudeRunContext): void {
    ctx.renderer.dispose();
    ctx.input.cancel();
    if (ctx.idleWatchdog) {
      clearInterval(ctx.idleWatchdog);
      this.idleWatchdogs.delete(ctx.idleWatchdog);
    }
    for (const timer of ctx.run.codexTimers.values()) clearInterval(timer);
    ctx.run.codexTimers.clear();
    ctx.run.codexStarts.clear();
    ctx.sdkQuery?.close();
    ctx.run.query?.close();
    if (this.host.active.get(ctx.session.id) === ctx.run) {
      this.host.active.delete(ctx.session.id);
    }
  }

  private async startTurn(ctx: ClaudeRunContext): Promise<boolean> {
    await this.host.safeRename(ctx.session, `[RUNNING] ${ctx.session.title}`);
    await ctx.renderer.start(false);
    if (
      this.host.tokenPool.size > 1
      && ctx.tokenIndex > 0
      && ctx.session.claudeTokenIndex === ctx.tokenIndex
    ) {
      ctx.renderer.note(`선택한 계정 토큰 #${ctx.tokenIndex + 1}로 실행합니다.`);
    } else if (this.host.tokenPool.size > 1 && ctx.tokenIndex > 0) {
      ctx.renderer.note(`기본 토큰 한도 도달 → 계정 토큰 #${ctx.tokenIndex + 1}로 전환해 실행합니다.`);
    }
    if (this.host.deleting.has(ctx.session.id)) return false;
    this.host.store.updateSession(ctx.session.id, { status: "running" });

    const hooks = this.buildHooks(ctx.session, ctx.run, ctx.renderer);
    ctx.sdkQuery = this.dependencies.createQuery({
      prompt: ctx.input,
      options: this.buildQueryOptions(ctx, hooks)
    });
    ctx.run.query = ctx.sdkQuery;
    this.startIdleWatchdog(ctx);
    return true;
  }

  private buildHooks(
    session: SessionRecord,
    run: ActiveRun,
    renderer: StreamRenderer
  ): ClaudeHooks {
    const heartbeatInFlight = new Set<string>();
    let stopDeferralNoted = false;
    const startCodexHeartbeat = (toolName: string, toolUseId: string): void => {
      const serverName = mcpServerName(toolName)?.toLowerCase();
      if (!serverName || !this.host.options.longRunningMcpServers.has(serverName)) return;
      const timer = setInterval(() => {
        if (heartbeatInFlight.has(toolUseId)) return;
        heartbeatInFlight.add(toolUseId);
        void this.host.transport.sendText(
          session.chatId,
          session.topicId,
          `[MCP RUNNING] ${toolName} 작업이 계속 진행 중입니다. 완료 또는 실제 연결 실패까지 기다립니다.`
        ).catch(() => undefined).finally(() => {
          heartbeatInFlight.delete(toolUseId);
        });
      }, this.host.options.codexMcpHeartbeatMs);
      run.codexTimers.set(toolUseId, timer);
      run.codexStarts.set(toolUseId, Date.now());
    };
    const clearToolTimer = (toolUseId: string): void => {
      const timer = run.codexTimers.get(toolUseId);
      if (timer) clearInterval(timer);
      run.codexTimers.delete(toolUseId);
      run.codexStarts.delete(toolUseId);
      heartbeatInFlight.delete(toolUseId);
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
      if (failedAttempts < this.host.options.mcpMaxAttempts) {
        renderer.note(
          `MCP ${server} 재시도 ${failedAttempts + 1}/${this.host.options.mcpMaxAttempts}`
        );
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext:
              `[MCP_RETRY ${failedAttempts + 1}/${this.host.options.mcpMaxAttempts}] `
              + "일시적 MCP 연결 오류입니다. 같은 도구와 같은 입력을 병렬 실행하지 말고 즉시 한 번만 다시 호출하세요."
          }
        };
      }
      await this.host.transport.sendText(
        session.chatId,
        session.topicId,
        `[MCP FAILED] ${server} 서버의 ${hookInput.tool_name} 호출이 `
        + `${this.host.options.mcpMaxAttempts}회 모두 실패했습니다.\n${hookInput.error}`
      ).catch(() => undefined);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUseFailure",
          additionalContext:
            `[MCP_FAILED] ${this.host.options.mcpMaxAttempts}회 모두 실패했습니다. `
            + "같은 호출은 더 재시도하지 말고 사용자에게 실패 원인과 가능한 대안을 설명하세요."
        }
      };
    };
    const stop: HookCallback = async (hookInput) => {
      if (hookInput.hook_event_name !== "Stop") return {};
      const backgroundTasks = hookInput.background_tasks ?? [];
      if (hookInput.stop_hook_active || backgroundTasks.length === 0) return {};
      if (!stopDeferralNoted) {
        stopDeferralNoted = true;
        renderer.note(
          `Claude 하위 작업 ${backgroundTasks.length}개가 진행 중이므로 결과 통합 전 종료를 보류합니다.`
        );
      }
      const taskSummary = backgroundTasks
        .slice(0, 5)
        .map((task) => `${task.id}: ${task.description} (${task.status})`)
        .join("\n");
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext:
            "아직 완료되지 않은 하위 작업이 있으므로 현재 턴을 종료하지 마십시오. "
            + "하위 작업이 끝나기를 기다려 결과를 수집·통합하고, 남은 검증까지 마친 뒤 최종 응답하십시오.\n"
            + taskSummary
        }
      };
    };
    return { startCodexHeartbeat, postToolUse, postToolUseFailure, stop };
  }

  private async handleRateLimit(error: unknown, ctx: ClaudeRunContext): Promise<boolean> {
    this.host.markRateLimited(ctx.oauthToken, error);
    const attempts = (ctx.request.autoSwitchCount ?? 0) + 1;
    const nextToken = this.host.tokenPool.select(Date.now(), ctx.claudeModel);
    const canAutoSwitch = this.host.tokenPool.size > 1
      && attempts < this.host.tokenPool.size
      && !this.host.tokenPool.isExhausted(nextToken);
    if (canAutoSwitch) {
      const nextIndex = this.host.tokenPool.indexOf(nextToken);
      await this.host.transport.sendText(
        ctx.session.chatId,
        ctx.session.topicId,
        `토큰 #${ctx.tokenIndex + 1} 한도 도달 → 계정 토큰 #${nextIndex + 1}로 자동 전환해 이어서 실행합니다.`
      ).catch(() => undefined);
      await this.host.safeRename(ctx.session, `[SWITCH] ${ctx.session.title}`);
      const resumeId = ctx.sdkSessionId ?? ctx.request.resumeSessionId;
      this.host.store.updateSession(ctx.session.id, { status: "queued" });
      this.host.enqueue({
        ...limitResumeRequest(ctx.request, false),
        ...(resumeId ? { resumeSessionId: resumeId } : {}),
        autoSwitchCount: attempts
      });
      return true;
    }
    const resumeAt = this.host.tokenPool.recoversAt();
    if (resumeAt !== null) {
      ctx.renderer.note(
        this.host.tokenPool.size > 1
          ? "모든 계정 토큰이 한도에 도달했습니다. Claude 회복 시각에 자동 재개를 예약합니다."
          : "계정 토큰이 한도에 도달했습니다. Claude 회복 시각에 자동 재개를 예약합니다."
      );
      this.host.scheduleLimitResume(ctx.session, ctx.request, ctx.sdkSessionId, resumeAt);
      return true;
    }
    return false;
  }

  private async handleOverload(ctx: ClaudeRunContext): Promise<boolean> {
    const attempt = (ctx.request.retryCount ?? 0) + 1;
    if (attempt > MAX_OVERLOAD_RETRIES) {
      ctx.renderer.note(`과부하가 ${MAX_OVERLOAD_RETRIES}회 재시도 후에도 풀리지 않았습니다.`);
      return false;
    }
    const delayMs = Math.min(
      OVERLOAD_RETRY_BASE_MS * 2 ** (attempt - 1),
      OVERLOAD_RETRY_CAP_MS
    );
    await this.host.transport.sendText(
      ctx.session.chatId,
      ctx.session.topicId,
      `서버 과부하(Overloaded)로 일시 중단 → ${Math.round(delayMs / 1000)}초 후 자동 재시도합니다. (${attempt}/${MAX_OVERLOAD_RETRIES})`
    ).catch(() => undefined);
    await this.host.safeRename(ctx.session, `[RETRY] ${ctx.session.title}`);
    const resumeId = ctx.sdkSessionId ?? ctx.request.resumeSessionId;
    const retryRequest: RunRequest = {
      ...ctx.request,
      ...(resumeId ? { resumeSessionId: resumeId } : {}),
      retryCount: attempt
    };
    this.host.store.updateSession(ctx.session.id, { status: "queued" });
    this.cancelRetry(ctx.session.id);
    const timer = setTimeout(() => {
      if (this.retryTimers.get(ctx.session.id) !== timer) return;
      this.retryTimers.delete(ctx.session.id);
      if (this.disposed || this.host.deleting.has(ctx.session.id)) return;
      this.host.enqueue(retryRequest);
    }, delayMs);
    timer.unref();
    this.retryTimers.set(ctx.session.id, timer);
    return true;
  }
}
