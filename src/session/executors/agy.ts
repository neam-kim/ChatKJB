import { InlineKeyboard } from "grammy";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgyCliSession, type AgyCliSessionOptions } from "../../agy-cli.js";
import type { AgyInteractiveTurnResult, AgyLiveStatus } from "../../agy-interactive.js";
import {
  agyModelLabel,
  agyThinkingOptionsForModel,
  normalizeAgyModelForCatalog,
  resolveAgyCliModel
} from "../../model-catalog.js";
import { syncSharedResourcesCached } from "../../resource-sync.js";
import { MessageQueue } from "../../session-collectors.js";
import { agyPermissionArgs } from "../../session-environment.js";
import {
  buildOrchestratedTurnPrompt,
  buildProviderBootstrap,
  buildUserMessage
} from "../../session-prompts.js";
import { promptForRequest, type RunRequest } from "../prompt-builders.js";
import { agyFailureFromLog, agyRequestsProceed } from "../provider-progress.js";
import { StreamRenderer } from "../../stream-renderer.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { SessionRecord } from "../../types.js";
import {
  queueRequestedUserInput,
  type ActiveRun,
  type BaseExecutorHost
} from "./shared.js";

export type AgySessionClient = Pick<
  AgyCliSession,
  "alive" | "runTurn" | "getStatus" | "interrupt" | "close"
>;

export interface AgyExecutorDependencies {
  createSession(options: AgyCliSessionOptions): AgySessionClient;
  syncResources: typeof syncSharedResourcesCached;
}

const DEFAULT_DEPENDENCIES: AgyExecutorDependencies = {
  createSession: (options) => new AgyCliSession(options),
  syncResources: syncSharedResourcesCached
};

export interface AgyRunContext {
  request: RunRequest;
  session: SessionRecord;
  renderer: StreamRenderer;
  controller: AbortController;
  input: MessageQueue;
  run: ActiveRun;
  timedOut: boolean;
  turnTimeout?: NodeJS.Timeout | undefined;
  lastResponse: string;
  agyConversationId: string | null;
  bootstrapInjected: boolean;
}

export interface AgyLiveStatusResult {
  status: AgyLiveStatus | null;
  error: string | null;
}

/**
 * Antigravity CLI의 대화 수명주기와 실행 중 자원을 한곳에서 관리한다.
 * SessionManager는 예약·제공자 전환만 조정하고 CLI 프로세스 세부사항은 알지 않는다.
 */
export class AgyExecutor {
  private readonly interactiveSessions = new Map<
    string,
    { client: AgySessionClient; signature: string }
  >();

  constructor(
    private readonly host: BaseExecutorHost,
    private readonly dependencies: AgyExecutorDependencies = DEFAULT_DEPENDENCIES
  ) {}

  dispose(): void {
    for (const sessionId of [...this.interactiveSessions.keys()]) {
      this.closeInteractiveSession(sessionId);
    }
  }

  interrupt(sessionId: string): void {
    this.interactiveSessions.get(sessionId)?.client.interrupt();
  }

  closeInteractiveSession(sessionId: string): void {
    const existing = this.interactiveSessions.get(sessionId);
    if (!existing) return;
    this.interactiveSessions.delete(sessionId);
    existing.client.close();
  }

  async getLiveStatus(session: SessionRecord): Promise<AgyLiveStatusResult> {
    const existing = this.interactiveSessions.get(session.id)?.client;
    if (existing) {
      try {
        return { status: await existing.getStatus(), error: null };
      } catch (error) {
        return { status: null, error: safeErrorMessage(error) };
      }
    }
    return {
      status: {
        isIdle: true,
        turnCount: session.agyConversationId ? null : 0,
        conversationId: session.agyConversationId
      },
      error: null
    };
  }

  resetContext(sessionId: string): void {
    this.closeInteractiveSession(sessionId);
  }

  async summarizeForHandoff(session: SessionRecord, prompt: string): Promise<string> {
    if (!session.agyConversationId) return "";
    const client = this.getInteractiveSession(session, "plan");
    try {
      const result = await client.runTurn(prompt);
      return result.response.trim();
    } finally {
      this.closeInteractiveSession(session.id);
    }
  }

  async runOneOff(
    session: SessionRecord,
    prompt: string,
    permissionMode: SessionRecord["permissionMode"],
    signal?: AbortSignal
  ): Promise<string> {
    const tempSession: SessionRecord = {
      ...session,
      permissionMode,
      agyConversationId: null
    };
    const client = this.getInteractiveSession(tempSession, permissionMode);
    try {
      const result = await client.runTurn(this.buildPrompt(tempSession, prompt, true, false), signal);
      return result.response.trim();
    } finally {
      this.closeInteractiveSession(tempSession.id);
    }
  }

  async execute(request: RunRequest): Promise<void> {
    const ctx = this.prepareRun(request);
    if (!ctx) return;
    try {
      const client = await this.startRun(ctx);
      await this.runTurnLoop(ctx, client);
      await this.finalizeRun(ctx);
    } catch (error) {
      await this.handleRunError(error, ctx);
    } finally {
      this.cleanupRun(ctx);
    }
  }

  async runTurn(
    ctx: AgyRunContext,
    client: Pick<AgySessionClient, "runTurn">,
    turnPrompt: string
  ): Promise<string> {
    if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
    ctx.timedOut = false;
    ctx.turnTimeout = undefined;
    if (this.host.options.providerTurnTimeoutMs) {
      ctx.turnTimeout = setTimeout(() => {
        ctx.timedOut = true;
        ctx.controller.abort();
      }, this.host.options.providerTurnTimeoutMs);
    }

    let result!: AgyInteractiveTurnResult;
    try {
      result = await client.runTurn(turnPrompt, ctx.controller.signal);
    } finally {
      if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
    }
    if (ctx.timedOut || ctx.controller.signal.aborted) throw new Error("turn aborted");
    if (result.conversationId && result.conversationId !== ctx.agyConversationId) {
      ctx.agyConversationId = result.conversationId;
      this.host.store.updateSession(ctx.session.id, { agyConversationId: result.conversationId });
    }
    const response = result.response.trim();
    if (!response) {
      throw new Error("Antigravity가 성공 종료와 함께 빈 응답을 반환했습니다.");
    }
    return response;
  }

  async finalizeRun(ctx: AgyRunContext): Promise<void> {
    if (ctx.request.operation === "compact") {
      this.closeInteractiveSession(ctx.session.id);
      this.host.store.updateSession(ctx.session.id, {
        status: "done",
        agyConversationId: null,
        handoffSummary: ctx.lastResponse
      });
      await ctx.renderer.finish(
        "done",
        "컨텍스트 압축 완료: 다음 턴은 압축 요약으로 새 Antigravity 대화에서 이어집니다."
      );
    } else {
      this.host.store.updateSession(ctx.session.id, { status: "done" });
      await ctx.renderer.finish(
        "done",
        ctx.lastResponse || "Antigravity가 텍스트 응답 없이 작업을 마쳤습니다."
      );
    }
    await this.host.safeRename(ctx.session, `[DONE] ${ctx.session.title}`);
  }

  private getInteractiveSession(
    session: SessionRecord,
    permissionMode: SessionRecord["permissionMode"] = session.permissionMode
  ): AgySessionClient {
    const model = resolveAgyCliModel(
      this.host.options.modelCatalog,
      session.agyModel,
      session.agyThinkingLevel
    );
    const signature = JSON.stringify({ cwd: session.cwd, model, permissionMode });
    const existing = this.interactiveSessions.get(session.id);
    if (existing?.signature === signature && existing.client.alive) return existing.client;
    if (existing) this.closeInteractiveSession(session.id);

    const cliEnv = { ...process.env };
    delete cliEnv["GEMINI_API_KEY"];
    delete cliEnv["GOOGLE_API_KEY"];
    const client = this.dependencies.createSession({
      executable: this.host.options.agyExecutable ?? join(homedir(), ".local", "bin", "agy"),
      cwd: session.cwd,
      model,
      permissionArgs: agyPermissionArgs(permissionMode),
      conversationId: session.agyConversationId,
      env: cliEnv,
      printTimeoutMs: this.host.options.codexMcpTimeoutMs
    });
    this.interactiveSessions.set(session.id, { client, signature });
    return client;
  }

  private buildPrompt(
    session: SessionRecord,
    prompt: string,
    includeBootstrap = true,
    includeInteractiveProtocols = true
  ): string {
    const turnPrompt = buildOrchestratedTurnPrompt(prompt);
    if (!includeBootstrap) return turnPrompt;
    return [
      buildProviderBootstrap(session, this.host.options.claudeMemoryDir, {
        includeInteractiveProtocols
      }),
      turnPrompt
    ].join("\n\n");
  }

  private prepareRun(request: RunRequest): AgyRunContext | null {
    if (this.host.deleting.has(request.session.id)) return null;
    let session = this.host.store.getSession(request.session.id);
    if (!session) return null;
    request = this.host.applyHandoffSummary(request, session);
    session = this.host.store.getSession(request.session.id) ?? session;

    const renderer = new StreamRenderer(
      session,
      this.host.transport,
      this.host.options.debounceMs
    );
    const controller = new AbortController();
    const input = new MessageQueue();
    // conversationId는 저장소와 계정 재시작을 가로질러 유지된다. 별도 Set을 쌓지 않고
    // 새 native 대화에서만 bootstrap을 넣어 재시작 뒤 중복 주입도 막는다.
    const bootstrapInjected = request.operation !== "native_command"
      && session.agyConversationId === null;
    input.push(buildUserMessage(
      request.operation === "native_command"
        ? promptForRequest(request)
        : this.buildPrompt(session, promptForRequest(request), bootstrapInjected)
    ));
    const run: ActiveRun = {
      controller,
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
      controller,
      input,
      run,
      timedOut: false,
      lastResponse: "",
      agyConversationId: session.agyConversationId,
      bootstrapInjected
    };
  }

  private async startRun(ctx: AgyRunContext): Promise<AgySessionClient> {
    await this.host.safeRename(ctx.session, `[RUNNING] ${ctx.session.title}`);
    await ctx.renderer.start(false);
    this.host.store.updateSession(ctx.session.id, { status: "running" });

    const agyModel = normalizeAgyModelForCatalog(
      this.host.options.modelCatalog,
      ctx.session.agyModel
    );
    if (agyModel !== ctx.session.agyModel) {
      this.host.store.updateSession(ctx.session.id, { agyModel });
      ctx.session.agyModel = agyModel;
    }
    if (
      ctx.session.agyThinkingLevel
      && !agyThinkingOptionsForModel(this.host.options.modelCatalog, agyModel)
        .some((option) => option.id === ctx.session.agyThinkingLevel)
    ) {
      ctx.renderer.note("선택한 모델이 저장된 추론 강도를 지원하지 않아 모델 기본값을 사용합니다.");
      this.host.store.updateSession(ctx.session.id, { agyThinkingLevel: null });
      ctx.session.agyThinkingLevel = null;
    }
    let connectorCount = 0;
    try {
      connectorCount = this.dependencies.syncResources().connectorCount;
    } catch (error) {
      console.error(
        `agy MCP 동기화 실패 (session=${ctx.session.id}):`,
        safeErrorMessage(error)
      );
    }
    const effectiveModel = resolveAgyCliModel(
      this.host.options.modelCatalog,
      agyModel,
      ctx.session.agyThinkingLevel
    );
    ctx.renderer.note(
      `Antigravity 실행 (${agyModelLabel(this.host.options.modelCatalog, effectiveModel)})`
      + ` · 커넥터 ${connectorCount}개 공유`
    );
    return this.getInteractiveSession(ctx.session);
  }

  private async runTurnLoop(ctx: AgyRunContext, client: AgySessionClient): Promise<void> {
    const iterator = ctx.input[Symbol.asyncIterator]();
    let pending = await iterator.next();
    while (!pending.done) {
      const content = pending.value.message.content;
      const turnPrompt = typeof content === "string" ? content : ctx.request.prompt;
      const response = await this.runTurn(ctx, client, turnPrompt);
      const visibleResponse = await queueRequestedUserInput(
        this.host,
        ctx.session,
        ctx.run,
        ctx.input,
        ctx.controller.signal,
        response
      );
      ctx.lastResponse = visibleResponse || ctx.lastResponse;
      if (agyRequestsProceed(response)) {
        await this.host.transport.sendText(
          ctx.session.chatId,
          ctx.session.topicId,
          "제시된 계획대로 계속 진행하시겠습니까?",
          new InlineKeyboard().text("진행", `agygo:${ctx.session.id}`)
        );
      }
      ctx.run.pendingTurns = Math.max(0, ctx.run.pendingTurns - 1);
      if (ctx.run.pendingTurns === 0) break;
      ctx.renderer.note(`예약 메시지 ${ctx.run.pendingTurns}개 처리 대기`);
      pending = await iterator.next();
    }
  }

  private async handleRunError(error: unknown, ctx: AgyRunContext): Promise<void> {
    if (this.host.deleting.has(ctx.session.id) || !this.host.store.getSession(ctx.session.id)) return;
    if (ctx.timedOut) {
      console.error(`agy run failed (session=${ctx.session.id}):`, safeErrorMessage(error));
      const minutes = Math.round((this.host.options.providerTurnTimeoutMs ?? 0) / 60_000);
      this.host.store.updateSession(ctx.session.id, { status: "error" });
      await ctx.renderer.finish(
        "error",
        `Antigravity 턴이 ${minutes}분 제한을 초과해 중단되었습니다.`
      );
      await this.host.safeRename(ctx.session, `[STALL] ${ctx.session.title}`);
      return;
    }
    // 서비스 재시작 정리 abort는 새 데몬의 자동 복구가 이어받도록 running 상태를 남긴다.
    if (ctx.run.serviceShutdownRequested && ctx.controller.signal.aborted) return;
    console.error(`agy run failed (session=${ctx.session.id}):`, safeErrorMessage(error));
    if (ctx.controller.signal.aborted) {
      this.host.store.updateSession(ctx.session.id, { status: "aborted" });
      await ctx.renderer.finish("aborted", "사용자가 작업을 중단했습니다.");
      await this.host.safeRename(ctx.session, `[STOP] ${ctx.session.title}`);
      return;
    }

    const message = safeErrorMessage(error);
    const failure = agyFailureFromLog(message);
    this.host.store.updateSession(ctx.session.id, { status: "error" });
    await ctx.renderer.finish(
      "error",
      failure ?? `Antigravity 실행 실패: ${message}`
    );
    await this.host.safeRename(ctx.session, `[ERROR] ${ctx.session.title}`);
  }

  private cleanupRun(ctx: AgyRunContext): void {
    if (ctx.turnTimeout) clearTimeout(ctx.turnTimeout);
    ctx.renderer.dispose();
    ctx.input.cancel();
    if (this.host.active.get(ctx.session.id) === ctx.run) {
      this.host.active.delete(ctx.session.id);
    }
    this.closeInteractiveSession(ctx.session.id);
  }
}
