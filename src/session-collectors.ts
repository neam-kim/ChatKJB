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
