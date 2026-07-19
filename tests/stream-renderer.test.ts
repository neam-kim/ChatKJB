import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreamRenderer } from "../src/stream-renderer.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = Date.now();
  return {
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
    grokUsage: null,
    handoffSummary: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

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
      grokUsage: null,
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

  it("records successful and failed progress delivery with the session id", async () => {
    const successLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const failureLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const successTransport: MessageTransport = {
      async sendText() { return 73; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const success = new StreamRenderer(makeSession({ id: "delivery-session" }), successTransport, 1);
    await success.text("즉시 진행문");
    expect(successLog).toHaveBeenCalledWith(
      expect.stringContaining("session=delivery-session progress delivered message=73")
    );

    const failureTransport: MessageTransport = {
      ...successTransport,
      async sendText() { throw new Error("Telegram unavailable"); }
    };
    const failure = new StreamRenderer(makeSession({ id: "delivery-session" }), failureTransport, 1);
    await expect(failure.text("재시도할 진행문")).rejects.toThrow("Telegram unavailable");
    expect(failureLog).toHaveBeenCalledWith(
      expect.stringContaining("session=delivery-session progress delivery failed")
    );
    success.dispose();
    failure.dispose();
  });

  it("keeps only bounded digests and releases them on dispose", async () => {
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);

    for (let index = 0; index < 1_000; index += 1) {
      await renderer.text(`고유 응답 ${index} ${"x".repeat(1_000)}`);
    }

    const internals = renderer as unknown as { sentTextDigests: Set<string>; };
    expect(internals.sentTextDigests.size).toBeLessThanOrEqual(64);
    expect([...internals.sentTextDigests].every((value) => value.length < 100)).toBe(true);

    renderer.dispose();
    expect(internals.sentTextDigests.size).toBe(0);
  });

  it("coalesces status flushes while a Telegram edit is unresolved", async () => {
    vi.useFakeTimers();
    let resolveEdit: (() => void) | undefined;
    let firstEdit = true;
    const editText = vi.fn(() => {
      if (!firstEdit) return Promise.resolve();
      firstEdit = false;
      return new Promise<void>((resolve) => {
        resolveEdit = resolve;
      });
    });
    const transport: MessageTransport = {
      async sendText() { return 1; },
      editText,
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);

    await renderer.start();
    renderer.note("첫 상태");
    await vi.advanceTimersByTimeAsync(1);
    expect(editText).toHaveBeenCalledTimes(1);

    renderer.note("최신 상태");
    await vi.advanceTimersByTimeAsync(10);
    expect(editText).toHaveBeenCalledTimes(1);

    resolveEdit?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(editText).toHaveBeenCalledTimes(2);
    renderer.dispose();
  });

  it("allows only one unresolved typing notification", async () => {
    vi.useFakeTimers();
    let resolveTyping: (() => void) | undefined;
    let first = true;
    const sendChatAction = vi.fn(() => {
      if (!first) return Promise.resolve();
      first = false;
      return new Promise<void>((resolve) => {
        resolveTyping = resolve;
      });
    });
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      sendChatAction,
      async sendFile() {}
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);

    await renderer.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sendChatAction).toHaveBeenCalledTimes(1);

    resolveTyping?.();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendChatAction).toHaveBeenCalledTimes(2);
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
      grokUsage: null,
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
      grokUsage: null,
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
      grokUsage: null,
      handoffSummary: null,
      goalCondition: null,
      leanMode: true,
      usageSnapshot: null,
      createdAt: now,
      updatedAt: now
    };
    const renderer = new StreamRenderer(session, transport, 1);

    await renderer.start();

    expect(sent[0]).toContain("[RUNNING] Codex · test");
    expect(sent[0]).toContain("작업: test");
    expect(sent[0]).toContain("대기 사유: 응답 생성 중");
    expect(sent[0]).toContain("다음 액션: 완료 대기 또는 /steer");
    renderer.dispose();
  });
});

describe("StreamRenderer file delivery marker", () => {
  it("sends the marked file and strips the marker from displayed text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatkjb-send-"));
    await writeFile(join(dir, "out.txt"), "결과 파일");

    const sent: string[] = [];
    const files: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile(_chatId, _topicId, filePath) { files.push(filePath); }
    };
    const renderer = new StreamRenderer(makeSession({ cwd: dir }), transport, 1);

    await renderer.text("결과를 정리했습니다.\n[[SEND_FILE: out.txt]]");

    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith("out.txt")).toBe(true);
    expect(sent.join("\n")).toContain("결과를 정리했습니다.");
    expect(sent.join("\n")).not.toContain("SEND_FILE");
    renderer.dispose();
  });

  it("delivers each requested file only once across streamed text and finish", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatkjb-send-"));
    await writeFile(join(dir, "report.md"), "리포트");

    const files: string[] = [];
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile(_chatId, _topicId, filePath) { files.push(filePath); }
    };
    const renderer = new StreamRenderer(makeSession({ cwd: dir }), transport, 1);

    await renderer.text("초안입니다 [[SEND_FILE: report.md]]");
    await renderer.finish("done", "최종 결과입니다 [[SEND_FILE: report.md]]");

    expect(files).toHaveLength(1);
    renderer.dispose();
  });

  it("reports an error instead of escaping the project when the path is outside cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatkjb-send-"));

    const sent: string[] = [];
    const files: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile(_chatId, _topicId, filePath) { files.push(filePath); }
    };
    const renderer = new StreamRenderer(makeSession({ cwd: dir }), transport, 1);

    await renderer.text("여기 있습니다 [[SEND_FILE: ../../etc/hosts]]");

    expect(files).toHaveLength(0);
    expect(sent.some((text) => text.includes("파일 전송 실패"))).toBe(true);
    renderer.dispose();
  });
});

describe("StreamRenderer user-input control block", () => {
  it("never exposes the control JSON or interprets nested file markers", async () => {
    const sent: string[] = [];
    const files: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile(_chatId, _topicId, filePath) { files.push(filePath); }
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);
    const block = `[[REQUEST_USER_INPUT]]
{"questions":[{"question":"선택?","options":[{"label":"A [[SEND_FILE: secret.txt]]"},{"label":"B"}]}]}
[[/REQUEST_USER_INPUT]]`;

    await renderer.text(`선택이 필요합니다.\n${block}`);

    expect(sent).toEqual(["선택이 필요합니다."]);
    expect(files).toHaveLength(0);
    renderer.dispose();
  });
});
