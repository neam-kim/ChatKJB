import { InlineKeyboard } from "grammy";
import type { MessageTransport, SessionRecord, UsageSnapshot } from "./types.js";
import { formatUsageSnapshot } from "./usage.js";

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

export class StreamRenderer {
  private static readonly heartbeatMs = 30_000;
  private readonly startedAt = Date.now();
  private readonly events: string[] = [];
  private statusMessageId: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private typingTimer: NodeJS.Timeout | null = null;
  private lastRendered = "";
  private partialText = "";
  private readonly sentTexts = new Set<string>();
  private usageSnapshot: UsageSnapshot | null;
  private finished = false;

  constructor(
    private readonly session: SessionRecord,
    private readonly transport: MessageTransport,
    private readonly debounceMs: number
  ) {
    this.usageSnapshot = session.usageSnapshot;
  }

  async start(queued = false): Promise<void> {
    const keyboard = new InlineKeyboard().text("중단", `stop:${this.session.id}`);
    const providerLabel =
      this.session.provider === "codex" ? "Codex"
      : this.session.provider === "agy" ? "agy"
      : "Claude";
    this.statusMessageId = await this.transport.sendText(
      this.session.chatId,
      this.session.topicId,
      queued
        ? "[QUEUED] 같은 프로젝트의 앞선 작업을 기다리는 중"
        : `[RUNNING] ${providerLabel} 세션 시작`,
      keyboard
    );
    if (!queued) {
      this.heartbeatTimer = setInterval(() => {
        void this.flush();
      }, StreamRenderer.heartbeatMs);
      void this.transport.sendChatAction(this.session.chatId, this.session.topicId, "typing").catch(() => undefined);
      this.typingTimer = setInterval(() => {
        void this.transport.sendChatAction(this.session.chatId, this.session.topicId, "typing").catch(() => undefined);
      }, 4000);
    }
  }

  tool(toolName: string, input: Record<string, unknown>): void {
    const target = input.file_path ?? input.path ?? input.command ?? input.query ?? "";
    this.note(`${toolName}${target ? `: ${String(target).slice(0, 180)}` : ""}`);
  }

  note(message: string): void {
    this.events.push(message);
    if (this.events.length > 8) this.events.shift();
    this.schedule();
  }

  // 실행 중 자라나는 답변 본문을 상태 메시지에 미리보기로 보여 준다(codex/agy 라이브 스트리밍).
  // 누적 전체 텍스트를 받아 저장하고, 실제 갱신은 기존 디바운스(schedule)로 throttle 한다.
  partial(fullTextSoFar: string): void {
    const next = fullTextSoFar.trimEnd();
    if (!next || next === this.partialText) return;
    this.partialText = next;
    this.schedule();
  }

  async text(text: string): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const key = clean.replace(/\s+/g, " ");
    if (this.sentTexts.has(key)) return;
    this.sentTexts.add(key);
    for (const part of chunks(clean)) {
      await this.transport.sendText(this.session.chatId, this.session.topicId, part);
    }
  }

  usage(snapshot: UsageSnapshot): void {
    this.usageSnapshot = snapshot;
    if (this.finished) return;
    this.schedule();
  }

  dispose(): void {
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
    this.dispose();
    this.finished = true;
    const heading = status === "done" ? "[DONE]" : status === "aborted" ? "[ABORTED]" : "[ERROR]";
    const usage = this.usageSnapshot ? `\n${formatUsageSnapshot(this.usageSnapshot)}` : "";
    const statusText = `${heading} ${elapsed(this.startedAt)}${usage}\n도구 호출: ${this.events.length}`;
    if (this.statusMessageId !== null) {
      await this.transport.editText(this.session.chatId, this.statusMessageId, statusText);
    }
    await this.transport.sendText(
      this.session.chatId,
      this.session.topicId,
      `${heading} 작업 종료 · ${elapsed(this.startedAt)}`
    );
    if (summary.trim()) {
      if (summary.length > 10_000) {
        await this.transport.sendDocument(
          this.session.chatId,
          this.session.topicId,
          "claude-result.md",
          summary,
          "결과가 길어 파일로 첨부했습니다."
        );
      } else {
        await this.text(summary);
      }
    }
  }

  private schedule(): void {
    if (this.finished) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.finished || this.statusMessageId === null) return;
    const recent = this.events.map((event) => `- ${event}`).join("\n");
    const usage = this.usageSnapshot ? `\n${formatUsageSnapshot(this.usageSnapshot)}` : "";
    // 자라나는 답변 본문이 있으면 끝부분을 미리보기로 보여 준다(전체는 완료 시 정식 메시지로 전송).
    const preview = this.partialText
      ? `\n\n${this.partialText.length > 1200 ? `…${this.partialText.slice(-1200)}` : this.partialText}`
      : "";
    const text = `[RUNNING] ${elapsed(this.startedAt)}${usage}\n${recent || "응답 대기 중"}${preview}`;
    if (text === this.lastRendered) return;
    this.lastRendered = text;
    const keyboard = new InlineKeyboard().text("중단", `stop:${this.session.id}`);
    await this.transport
      .editText(this.session.chatId, this.statusMessageId, text, keyboard)
      .catch(() => undefined);
  }
}
