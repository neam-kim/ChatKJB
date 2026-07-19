// 스트리밍 텍스트 수집기와 비동기 입력 큐. SessionManager 본체에서 분리한 자기완결 클래스
// 모음으로 클래스 상태(this)에 의존하지 않는다. session-manager.ts가 이 모듈을 재export하므로
// 기존 import 경로("./session-manager.js")는 변하지 않는다.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

type GrokMessageKind = "progress" | "final";

/**
 * Grok streaming-json의 토큰 조각을 사용자에게 보낼 완결된 진행문으로 합친다.
 * `[PROGRESS] … [/PROGRESS]`를 우선 사용하고, 구형 출력은 다음 시작 표지까지를
 * 하나의 메시지로 취급한다. 따라서 JSON text 이벤트가 글자·단어 단위여도 Telegram
 * 말풍선이 조각나지 않는다.
 */
export class GrokProgressCollector {
  private pending = "";
  private kind: GrokMessageKind | null = null;

  accept(textEvent: string): string[] {
    this.pending += textEvent;
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(force: boolean): string[] {
    const messages: string[] = [];
    while (true) {
      if (this.kind === null) {
        const next = this.nextOpening();
        if (!next) {
          if (force) this.emit(messages, this.pending);
          if (force) this.pending = "";
          return messages;
        }
        this.emit(messages, this.pending.slice(0, next.index));
        this.pending = this.pending.slice(next.index + next.token.length);
        this.kind = next.kind;
        continue;
      }

      const closingToken = this.kind === "progress" ? "[/PROGRESS]" : "[/FINAL]";
      const closingIndex = this.pending.toUpperCase().indexOf(closingToken);
      const next = this.nextOpening();
      if (closingIndex >= 0 && (!next || closingIndex < next.index)) {
        this.emit(messages, this.pending.slice(0, closingIndex));
        this.pending = this.pending.slice(closingIndex + closingToken.length);
        this.kind = null;
        continue;
      }
      if (next) {
        this.emit(messages, this.pending.slice(0, next.index));
        this.pending = this.pending.slice(next.index + next.token.length);
        this.kind = next.kind;
        continue;
      }
      if (force) {
        this.emit(messages, this.pending);
        this.pending = "";
        this.kind = null;
      }
      return messages;
    }
  }

  private nextOpening(): { index: number; token: string; kind: GrokMessageKind; } | null {
    const match = /\[(PROGRESS|FINAL)\]\s*/i.exec(this.pending);
    if (!match || match.index === undefined) return null;
    return {
      index: match.index,
      token: match[0],
      kind: match[1]?.toLowerCase() === "final" ? "final" : "progress"
    };
  }

  private emit(messages: string[], text: string): void {
    const clean = text
      .replace(/\[\/(?:PROGRESS|FINAL)\]/gi, "")
      .trim();
    if (clean) messages.push(clean);
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

  /** 중단·삭제·서비스 종료에서는 더 이상 소비되지 않을 예약 입력을 즉시 폐기한다. */
  cancel(): void {
    this.values.length = 0;
    this.close();
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
