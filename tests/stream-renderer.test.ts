import { describe, expect, it } from "vitest";
import { StreamRenderer } from "../src/stream-renderer.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

describe("StreamRenderer text deduplication", () => {
  it("sends equivalent completed text only once", async () => {
    const sent: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return sent.length;
      },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: "session",
      sdkSessionId: "sdk-session",
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: "/tmp",
      title: "test",
      status: "running",
      permissionMode: "auto",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "claude",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const renderer = new StreamRenderer(session, transport, 1);

    await renderer.text("완료된 답변입니다.");
    await renderer.text("  완료된   답변입니다.  ");

    expect(sent).toEqual(["완료된 답변입니다."]);
    renderer.dispose();
  });

  it("sends a new terminal notification even when the final answer was already streamed", async () => {
    const sent: string[] = [];
    const edited: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return sent.length;
      },
      async editText(_chatId, _messageId, text) {
        edited.push(text);
      },
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: "session",
      sdkSessionId: "sdk-session",
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: "/tmp",
      title: "test",
      status: "running",
      permissionMode: "auto",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "claude",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const renderer = new StreamRenderer(session, transport, 1);

    await renderer.start();
    await renderer.finish("done", "");

    expect(edited.at(-1)).toContain("[DONE]");
    expect(sent.at(-1)).toContain("[DONE] 작업 종료");
  });

  it("streams a growing partial answer into the running status message", async () => {
    const edited: string[] = [];
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText(_chatId, _messageId, text) { edited.push(text); },
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: "session",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: "/tmp",
      title: "test",
      status: "running",
      permissionMode: "auto",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "agy",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: "conv-1",
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const renderer = new StreamRenderer(session, transport, 1);

    await renderer.start();
    renderer.partial("부분");
    renderer.partial("부분 답변이 자라는 중");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(edited.some((text) => text.includes("부분 답변이 자라는 중"))).toBe(true);
    renderer.dispose();
  });

  it("labels the running message with the active provider", async () => {
    const sent: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) {
        sent.push(text);
        return sent.length;
      },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: "session",
      sdkSessionId: null,
      chatId: -1001,
      topicId: 42,
      projectName: "test",
      cwd: "/tmp",
      title: "test",
      status: "running",
      permissionMode: "auto",
      model: null,
      thinking: null,
      claudeEffort: null,
      provider: "codex",
      codexModel: null,
      codexReasoning: null,
      codexThreadId: null,
      agyModel: null,
      agyThinkingLevel: null,
      agyConversationId: null,
      agyUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const renderer = new StreamRenderer(session, transport, 1);

    await renderer.start();

    expect(sent[0]).toBe("[RUNNING] Codex 세션 시작");
    renderer.dispose();
  });
});
