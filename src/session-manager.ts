import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteSession as deleteClaudeSession,
  query,
  renameSession,
  type HookCallback,
  type Options,
  type Query,
  type SDKUserMessage,
  type SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import {
  isRetryableMcpError,
  loadMcpServersWithTimeouts,
  mcpCallKey,
  mcpServerName
} from "./mcp-policy.js";
import { PermissionBroker } from "./permission-broker.js";
import { StateStore } from "./store.js";
import { StreamRenderer } from "./stream-renderer.js";
import { safeErrorMessage } from "./telegram-transport.js";
import type { MessageTransport, ProjectConfig, SessionRecord, UsageSnapshot } from "./types.js";
import {
  mergeUsageSnapshots,
  snapshotFromRateLimitInfo,
  snapshotFromUsageResponse
} from "./usage.js";

interface RunRequest {
  session: SessionRecord;
  prompt: string;
  resumeSessionId?: string;
  forkSession?: boolean;
  operation?: "prompt" | "compact";
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
  query?: Query;
  codexTimers: Map<string, NodeJS.Timeout>;
  mcpFailures: Map<string, number>;
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
    forkSession = false
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
      codexTimers: new Map(),
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
      };

      const clearToolTimer = (toolUseId: string): void => {
        const timer = run.codexTimers.get(toolUseId);
        if (timer) clearInterval(timer);
        run.codexTimers.delete(toolUseId);
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
                : resultText(message).trim() === lastAssistantText ? "" : resultText(message)
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

  private async safeRename(session: SessionRecord, title: string): Promise<void> {
    await this.transport.renameTopic(session.chatId, session.topicId, title).catch((error) => {
      console.error("Telegram topic rename failed:", safeErrorMessage(error));
    });
  }
}
