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

  it("redacts streamed Markdown text without changing its ordinary content", async () => {
    const sent: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) { sent.push(text); return sent.length; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument() {},
      async sendChatAction() {},
      async sendFile() {}
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      "streamed-private-key-material",
      "-----END PRIVATE KEY-----"
    ].join("\n");

    await renderer.text([
      "**완료** 일반 설명입니다.",
      "OPENAI_API_KEY=streamed-api-secret-value-1234567890",
      pem,
      '{"private_key":"service-account-private-value","project_id":"safe-project"}'
    ].join("\n"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("**완료** 일반 설명입니다.");
    expect(sent[0]).toContain('"project_id":"safe-project"');
    expect(sent[0]).not.toContain("streamed-api-secret-value");
    expect(sent[0]).not.toContain("streamed-private-key-material");
    expect(sent[0]).not.toContain("service-account-private-value");
    renderer.dispose();
  });

  it("redacts a live partial answer before it is edited into the status message", async () => {
    vi.useFakeTimers();
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
    const renderer = new StreamRenderer(makeSession(), transport, 1);

    await renderer.start();
    renderer.partial('진행 중 {"client_secret":"live-client-secret"}');
    await vi.advanceTimersByTimeAsync(1);

    expect(edited.at(-1)).toContain("[REDACTED]");
    expect(edited.at(-1)).not.toContain("live-client-secret");
    renderer.dispose();
  });

  it("redacts long final summaries before sending them as documents", async () => {
    const documents: string[] = [];
    const transport: MessageTransport = {
      async sendText() { return 1; },
      async editText() {},
      async createTopic() { return 1; },
      async renameTopic() {},
      async deleteTopic() {},
      async sendDocument(_chatId, _topicId, _filename, content) { documents.push(content); },
      async sendChatAction() {},
      async sendFile() {}
    };
    const renderer = new StreamRenderer(makeSession(), transport, 1);

    await renderer.finish("done", `SECRET=long-document-secret\n${"x".repeat(11_000)}`);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toContain("SECRET=[REDACTED]");
    expect(documents[0]).not.toContain("long-document-secret");
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
    expect(sent[0]).toContain("① 현재 단계·행동");
    expect(sent[0]).toContain("② 대기 사유");
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

  it("renders cockpit four panes and live wait reason from status callback", async () => {
    vi.useFakeTimers();
    let status: SessionRecord["status"] = "running";
    const edited: string[] = [];
    const transport: MessageTransport = {
      async sendText(_chatId, _topicId, text) {
        edited.push(text);
        return 1;
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
    const renderer = new StreamRenderer(makeSession(), transport, 1, {
      resolveStatus: () => status
    });
    await renderer.start();
    renderer.tool("Read", { file_path: "src/a.ts" });
    renderer.decision("조향: 테스트 추가");
    renderer.setRemainingPlan({
      items: ["남은 작업"],
      completed: 0,
      total: 1,
      percent: 0,
      degraded: false,
      label: "0/1 완료 (0%) · ETA 미제공"
    });
    await vi.advanceTimersByTimeAsync(5);
    const mid = edited.at(-1) ?? "";
    expect(mid).toContain("① 현재 단계·행동");
    expect(mid).toContain("② 대기 사유");
    expect(mid).toContain("③ 지금까지 한 일");
    expect(mid).toContain("④ 남은 계획·진행률");
    expect(mid).toContain("조향: 테스트 추가");
    expect(mid).toContain("Read");

    status = "waiting_approval";
    renderer.flushNow();
    await vi.advanceTimersByTimeAsync(5);
    const waiting = edited.at(-1) ?? "";
    expect(waiting).toContain("사용자 승인 필요");

    // Unchanged content must not re-edit (rate-limit guard).
    const before = edited.length;
    renderer.flushNow();
    await vi.advanceTimersByTimeAsync(5);
    expect(edited.length).toBe(before);
    renderer.dispose();
  });

  it("keeps ledger beyond the old 8-event hard cap", async () => {
    vi.useFakeTimers();
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
    const renderer = new StreamRenderer(makeSession(), transport, 1);
    await renderer.start();
    for (let i = 0; i < 20; i += 1) {
      renderer.note(`event-${i}`);
    }
    await vi.advanceTimersByTimeAsync(5);
    const text = edited.at(-1) ?? "";
    // Display is capped, but recent events survive (not only last 8 of a shift-queue).
    expect(text).toContain("event-19");
    expect(text).toContain("event-10");
    renderer.dispose();
  });
});
