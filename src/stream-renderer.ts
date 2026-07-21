import { InlineKeyboard } from "grammy";
import { createHash } from "node:crypto";
import { formatRunningStatus, readGitBranch } from "./dashboard.js";
import {
  activityFromTool,
  emptyRemainingPlan,
  TaskLedger,
  waitReasonFromSessionStatus,
  type LedgerEntryKind,
  type RemainingPlan,
  type WaitReason
} from "./session/progress-model.js";
import { safeErrorMessage } from "./telegram-transport.js";
import type { MessageTransport, SessionRecord, SessionStatus, UsageSnapshot } from "./types.js";
import { resolveUploadPath } from "./upload-path.js";
import { formatUsageSnapshot } from "./usage.js";
import { stripUserInputRequestBlocks } from "./user-input-protocol.js";

// 에이전트가 파일 전송을 요청할 때 응답 본문에 출력하는 마커. ChatKJB가 감지해 해당 파일을
// 사용자에게 전송하고 마커는 표시에서 제거한다. 경로는 세션 프로젝트(cwd) 기준 상대경로다.
const SEND_FILE_MARKER = /\[\[SEND_FILE:\s*([^\]\n]+?)\s*\]\]/g;

function elapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function chunks(text: string, size = 3900): string[] {
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > size) {
    let boundary = remaining.lastIndexOf("\n", size);
    if (boundary < size / 2) boundary = size;
    result.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).replace(/^\n/, "");
  }
  if (remaining) result.push(remaining);
  return result;
}

export interface StreamRendererOptions {
  /**
   * Read-only session status lookup so flush can show live wait reasons
   * (waiting_approval / waiting_limit) without hardcoding.
   */
  resolveStatus?: () => SessionStatus | null | undefined;
  /** Optional live counts for subagent / tool waits. */
  resolveWaitOverrides?: () => { openSubagents?: number; toolWaiting?: boolean; };
}

export class StreamRenderer {
  private static readonly heartbeatMs = 30_000;
  private static readonly maxRememberedTexts = 64;
  private readonly startedAt = Date.now();
  /** @deprecated Prefer TaskLedger; kept for finish() tool-call count and legacy tests. */
  private readonly events: string[] = [];
  private readonly ledger = new TaskLedger();
  private statusMessageId: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private lastRendered = "";
  private partialText = "";
  private currentActivity = "세션 시작";
  private remainingPlan: RemainingPlan = emptyRemainingPlan(true);
  private waitOverride: WaitReason | null = null;
  private readonly sentTextDigests = new Set<string>();
  private readonly sentTextOrder: string[] = [];
  private readonly deliveredFiles = new Set<string>();
  private flushInFlight: Promise<void> | null = null;
  private flushQueued = false;
  private typingInFlight = false;
  private usageSnapshot: UsageSnapshot | null;
  private finished = false;
  private readonly branch: string | null;
  private readonly resolveStatus: (() => SessionStatus | null | undefined) | undefined;
  private readonly resolveWaitOverrides: (() => {
    openSubagents?: number;
    toolWaiting?: boolean;
  }) | undefined;

  constructor(
    private readonly session: SessionRecord,
    private readonly transport: MessageTransport,
    private readonly debounceMs: number,
    options: StreamRendererOptions = {}
  ) {
    this.usageSnapshot = session.usageSnapshot;
    this.branch = readGitBranch(session.cwd);
    this.resolveStatus = options.resolveStatus;
    this.resolveWaitOverrides = options.resolveWaitOverrides;
  }

  async start(queued = false): Promise<void> {
    const keyboard = new InlineKeyboard().text("중단", `stop:${this.session.id}`);
    this.currentActivity = queued
      ? "같은 프로젝트의 앞선 작업을 기다리는 중"
      : "세션 시작";
    this.statusMessageId = await this.sendText(
      this.renderStatusText(queued ? "queued" : "running"),
      "status",
      keyboard
    );
    if (!queued) {
      this.heartbeatTimer = setInterval(() => {
        this.requestFlush();
      }, StreamRenderer.heartbeatMs);
      this.sendTyping();
      this.typingTimer = setInterval(() => {
        this.sendTyping();
      }, 4000);
    }
  }

  tool(toolName: string, input: Record<string, unknown>): void {
    const target = input.file_path ?? input.path ?? input.command ?? input.query ?? "";
    const targetText = target ? String(target).slice(0, 180) : "";
    this.currentActivity = activityFromTool(toolName, targetText || undefined);
    this.appendLedger("tool", `${toolName}${targetText ? `: ${targetText}` : ""}`);
  }

  note(message: string): void {
    this.appendLedger("note", message);
  }

  /** Record a user/system decision (e.g. /steer) in the cockpit ledger. */
  decision(message: string): void {
    this.currentActivity = `조향 반영: ${message.slice(0, 80)}`;
    this.appendLedger("decision", message);
  }

  setActivity(activity: string): void {
    const clean = activity.trim();
    if (!clean) return;
    this.currentActivity = clean.slice(0, 200);
    this.schedule();
  }

  setRemainingPlan(plan: RemainingPlan): void {
    this.remainingPlan = plan;
    this.schedule();
  }

  /** Explicit wait reason override (e.g. subagent) until cleared with null. */
  setWaitReason(reason: WaitReason | null): void {
    this.waitOverride = reason;
    this.schedule();
  }

  // 실행 중 자라나는 답변 본문을 상태 메시지에 미리보기로 보여 준다(codex/agy 라이브 스트리밍).
  // 누적 전체 텍스트를 받아 저장하고, 실제 갱신은 기존 디바운스(schedule)로 throttle 한다.
  partial(fullTextSoFar: string): void {
    const next = stripUserInputRequestBlocks(fullTextSoFar).trimEnd();
    if (!next || next === this.partialText) return;
    this.partialText = next;
    if (!this.currentActivity || this.currentActivity === "세션 시작" || this.currentActivity === "응답 대기 중") {
      this.currentActivity = "응답 작성 중";
    }
    this.schedule();
  }

  async text(text: string): Promise<void> {
    // 선택형 UI 제어 블록은 사용자 본문이나 파일 전송 마커로 해석되기 전에 제거한다.
    const delivered = await this.deliverMarkedFiles(stripUserInputRequestBlocks(text));
    const clean = delivered.trim();
    if (!clean) return;
    const key = clean.replace(/\s+/g, " ");
    if (!this.rememberText(key)) return;
    for (const part of chunks(clean)) {
      await this.sendText(part, "progress");
    }
  }

  private appendLedger(kind: LedgerEntryKind, message: string): void {
    this.events.push(message);
    this.ledger.append(kind, message);
    if (kind !== "decision") {
      // Keep activity in sync with latest meaningful note when not a pure decision.
      if (kind === "tool" || kind === "subagent" || kind === "command" || kind === "file") {
        // activity already set by tool()/callers
      } else if (message.trim()) {
        this.currentActivity = message.slice(0, 200);
      }
    }
    this.schedule();
  }

  private async sendText(
    text: string,
    kind: "status" | "progress" | "terminal",
    keyboard?: InlineKeyboard
  ): Promise<number> {
    try {
      const messageId = await this.transport.sendText(
        this.session.chatId,
        this.session.topicId,
        text,
        keyboard
      );
      console.log(
        `[telegram] session=${this.session.id} ${kind} delivered message=${messageId} chars=${text.length}`
      );
      return messageId;
    } catch (error) {
      console.error(
        `[telegram] session=${this.session.id} ${kind} delivery failed chars=${text.length}: ${safeErrorMessage(error)}`
      );
      throw error;
    }
  }

  // 응답 본문의 [[SEND_FILE: <상대경로>]] 마커를 감지해 해당 파일을 사용자에게 전송하고,
  // 마커를 제거한 본문을 돌려준다. 경로는 세션 프로젝트(cwd) 기준으로만 해석하며 프로젝트
  // 밖·절대경로는 거부한다(resolveUploadPath). 같은 파일은 세션 내 한 번만 전송한다.
  private async deliverMarkedFiles(text: string): Promise<string> {
    SEND_FILE_MARKER.lastIndex = 0;
    if (!SEND_FILE_MARKER.test(text)) return text;
    SEND_FILE_MARKER.lastIndex = 0;
    const requested: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = SEND_FILE_MARKER.exec(text)) !== null) {
      const rel = match[1]?.trim();
      if (rel) requested.push(rel);
    }
    for (const rel of requested) {
      if (this.deliveredFiles.has(rel)) continue;
      this.deliveredFiles.add(rel);
      try {
        const abs = await resolveUploadPath(this.session.cwd, rel);
        await this.transport.sendFile(this.session.chatId, this.session.topicId, abs, `첨부: ${rel}`);
      } catch (error) {
        await this.transport
          .sendText(this.session.chatId, this.session.topicId, `파일 전송 실패(${rel}): ${safeErrorMessage(error)}`)
          .catch(() => undefined);
      }
    }
    return text.replace(SEND_FILE_MARKER, "").replace(/\n{3,}/g, "\n\n");
  }

  usage(snapshot: UsageSnapshot): void {
    this.usageSnapshot = snapshot;
    if (this.finished) return;
    this.schedule();
  }

  dispose(): void {
    this.finished = true;
    this.stopTimers();
    this.releaseBuffers();
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    this.typingTimer = null;
  }

  async finish(
    status: "done" | "aborted" | "error",
    summary: string
  ): Promise<void> {
    this.finished = true;
    this.stopTimers();
    const heading = status === "done" ? "[DONE]" : status === "aborted" ? "[ABORTED]" : "[ERROR]";
    const usage = this.usageSnapshot ? `\n${formatUsageSnapshot(this.usageSnapshot)}` : "";
    const statusText = `${heading} ${elapsed(this.startedAt)}${usage}\n도구 호출: ${this.events.length}`;
    try {
      if (this.statusMessageId !== null) {
        await this.transport.editText(this.session.chatId, this.statusMessageId, statusText);
      }
      await this.sendText(`${heading} 작업 종료 · ${elapsed(this.startedAt)}`, "terminal");
      if (summary.trim()) {
        // 마커를 먼저 처리해 파일을 전송하고, 남은 본문 길이에 따라 텍스트/문서로 보낸다.
        const cleaned = (await this.deliverMarkedFiles(stripUserInputRequestBlocks(summary))).trim();
        if (cleaned) {
          if (cleaned.length > 10_000) {
            await this.transport.sendDocument(
              this.session.chatId,
              this.session.topicId,
              "claude-result.md",
              cleaned,
              "결과가 길어 파일로 첨부했습니다."
            );
          } else {
            await this.text(cleaned);
          }
        }
      }
    } finally {
      this.releaseBuffers();
    }
  }

  /**
   * Force an immediate status flush (e.g. when entering waiting_approval).
   * Survives even if debounce would otherwise delay the edit.
   */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.requestFlush();
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.requestFlush();
    }, this.debounceMs);
  }

  private requestFlush(): void {
    if (this.finished) return;
    if (this.flushInFlight) {
      this.flushQueued = true;
      return;
    }
    this.flushInFlight = this.flushOnce()
      .catch(() => undefined)
      .finally(() => {
        this.flushInFlight = null;
        if (!this.flushQueued || this.finished) return;
        this.flushQueued = false;
        this.requestFlush();
      });
  }

  private resolveWaitReason(): WaitReason {
    if (this.waitOverride) return this.waitOverride;
    const status = this.resolveStatus?.() ?? this.session.status;
    const overrides = this.resolveWaitOverrides?.();
    return waitReasonFromSessionStatus(status, overrides);
  }

  private renderStatusText(status: "queued" | "running"): string {
    const waitReason = this.resolveWaitReason();
    const recent = this.ledger.formatLines().map((line) => `- ${line}`).join("\n")
      || this.events.map((event) => `- ${event}`).join("\n");
    return formatRunningStatus({
      session: this.session,
      status,
      startedAt: this.startedAt,
      branch: this.branch,
      usageSnapshot: this.usageSnapshot,
      recentActivity: this.currentActivity || recent || "응답 대기 중",
      partialPreview: this.partialText,
      currentActivity: this.currentActivity || "응답 대기 중",
      waitReason,
      ledgerEntries: this.ledger.displayEntries(),
      remainingPlan: this.remainingPlan
    });
  }

  private async flushOnce(): Promise<void> {
    if (this.finished || this.statusMessageId === null) return;
    const text = this.renderStatusText("running");
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    const keyboard = new InlineKeyboard().text("중단", `stop:${this.session.id}`);
    await this.transport.editText(this.session.chatId, this.statusMessageId, text, keyboard);
  }

  private sendTyping(): void {
    if (this.finished || this.typingInFlight) return;
    this.typingInFlight = true;
    void this.transport.sendChatAction(this.session.chatId, this.session.topicId, "typing")
      .catch(() => undefined)
      .finally(() => {
        this.typingInFlight = false;
      });
  }

  private rememberText(text: string): boolean {
    const digest = createHash("sha256").update(text).digest("base64url");
    if (this.sentTextDigests.has(digest)) return false;
    this.sentTextDigests.add(digest);
    this.sentTextOrder.push(digest);
    if (this.sentTextOrder.length > StreamRenderer.maxRememberedTexts) {
      const oldest = this.sentTextOrder.shift();
      if (oldest) this.sentTextDigests.delete(oldest);
    }
    return true;
  }

  private releaseBuffers(): void {
    this.events.length = 0;
    this.ledger.clear();
    this.partialText = "";
    this.lastRendered = "";
    this.currentActivity = "세션 시작";
    this.remainingPlan = emptyRemainingPlan(true);
    this.waitOverride = null;
    this.sentTextDigests.clear();
    this.sentTextOrder.length = 0;
    this.deliveredFiles.clear();
    this.flushQueued = false;
  }
}
