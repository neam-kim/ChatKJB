import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InlineKeyboard } from "grammy";
import { PermissionBroker } from "../src/permission-broker.js";
import { StateStore } from "../src/store.js";
import type { MessageTransport, SessionRecord } from "../src/types.js";

class FakeTransport implements MessageTransport {
  messages: Array<{ id: number; text: string; keyboard?: InlineKeyboard }> = [];
  failEdits = false;

  async sendText(
    _chatId: number,
    _topicId: number,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<number> {
    const id = this.messages.length + 1;
    this.messages.push({ id, text, ...(keyboard ? { keyboard } : {}) });
    return id;
  }

  async editText(
    _chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<void> {
    if (this.failEdits) throw new Error("Telegram unavailable");
    const message = this.messages.find((item) => item.id === messageId);
    if (message) {
      message.text = text;
      if (keyboard) message.keyboard = keyboard;
      else delete message.keyboard;
    }
  }

  async createTopic(): Promise<number> {
    return 1;
  }

  async renameTopic(): Promise<void> {}

  async deleteTopic(): Promise<void> {}

  async sendDocument(): Promise<void> {}

  async sendChatAction(): Promise<void> {}

  async sendFile(): Promise<void> {}
}

const cleanup: Array<{ store: StateStore; directory: string }> = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-permission-"));
  const store = new StateStore(join(directory, "state.sqlite"));
  store.syncProjects([{ name: "test", cwd: directory, defaultMode: "default" }]);
  const now = Date.now();
  const session: SessionRecord = {
    id: "session-1",
    sdkSessionId: "session-1",
    chatId: -1001,
    topicId: 10,
    projectName: "test",
    cwd: directory,
    title: "test",
    status: "running",
    permissionMode: "default",
    model: null,
    thinking: null,
    claudeEffort: null,
    codexReasoning: null,
    goalCondition: null,
    leanMode: true,
    usageSnapshot: null,
    createdAt: now,
    updatedAt: now
  };
  store.createSession(session);
  const transport = new FakeTransport();
  const broker = new PermissionBroker(store, transport, 5000);
  cleanup.push({ store, directory });
  return { store, session, transport, broker };
}

function callbackData(transport: FakeTransport, label: string): string {
  const keyboard = transport.messages.at(-1)?.keyboard;
  const button = keyboard?.inline_keyboard.flat().find((item) => item.text.includes(label));
  if (!button || !("callback_data" in button)) throw new Error(`Missing ${label} button`);
  return button.callback_data;
}

afterEach(() => {
  for (const item of cleanup.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

describe("PermissionBroker", () => {
  it("remembers only the SDK-provided scoped rule for the session", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.request(session, "Edit", { file_path: "a.ts" }, {
      signal: controller.signal,
      toolUseID: "tool-1",
      suggestions: [{
        type: "addRules",
        rules: [{ toolName: "Edit", ruleContent: "/project/a.ts" }],
        behavior: "allow",
        destination: "localSettings"
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await broker.handleCallback(callbackData(transport, "항상 허용"));
    await expect(decision).resolves.toMatchObject({
      behavior: "allow",
      updatedPermissions: [{
        type: "addRules",
        rules: [{ toolName: "Edit", ruleContent: "/project/a.ts" }],
        destination: "session"
      }]
    });
  });

  it("does not offer tool-wide session approval", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    void broker.request(session, "Edit", { file_path: "a.ts" }, {
      signal: controller.signal,
      toolUseID: "tool-broad",
      suggestions: [{
        type: "addRules",
        rules: [{ toolName: "Edit" }],
        behavior: "allow",
        destination: "localSettings"
      }]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const labels = transport.messages.at(-1)?.keyboard?.inline_keyboard.flat()
      .map((item) => item.text);
    expect(labels).not.toContain("이 세션에서 항상 허용");
    controller.abort();
  });

  it("does not restore running state while aborting an approval", async () => {
    const { store, session, broker } = setup();
    const controller = new AbortController();
    const decision = broker.request(session, "Edit", { file_path: "a.ts" }, {
      signal: controller.signal,
      toolUseID: "tool-abort"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.abort();

    await expect(decision).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(store.getSession(session.id)?.status).toBe("waiting_approval");
  });

  it("collects single and multi-select AskUserQuestion answers", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.request(session, "AskUserQuestion", {
      questions: [
        {
          question: "형식은?",
          options: [{ label: "요약" }, { label: "상세" }],
          multiSelect: false
        },
        {
          question: "포함할 항목은?",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: true
        }
      ]
    }, {
      signal: controller.signal,
      toolUseID: "tool-2"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await broker.handleCallback(callbackData(transport, "상세"));
    await broker.handleCallback(callbackData(transport, "A"));
    await broker.handleCallback(callbackData(transport, "B"));
    await broker.handleCallback(callbackData(transport, "선택 완료"));

    await expect(decision).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "형식은?": "상세",
          "포함할 항목은?": ["A", "B"]
        }
      }
    });
  });

  it("returns an approved plan decision", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.requestPlanDecision(session, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await broker.handleCallback(callbackData(transport, "승인"));

    await expect(decision).resolves.toEqual({ action: "approve" });
  });

  it("returns a rejected plan decision", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.requestPlanDecision(session, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await broker.handleCallback(callbackData(transport, "거절"));

    await expect(decision).resolves.toEqual({ action: "reject" });
  });

  it("returns free text as a plan change request", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.requestPlanDecision(session, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await broker.handleCallback(callbackData(transport, "기타-직접 입력"));
    await broker.handleTextInput(session.id, "테스트 단계를 먼저 실행해 주세요.");

    await expect(decision).resolves.toEqual({
      action: "change",
      text: "테스트 단계를 먼저 실행해 주세요."
    });
  });

  it("releases the SDK approval even when the Telegram edit fails", async () => {
    const { session, transport, broker } = setup();
    const controller = new AbortController();
    const decision = broker.request(session, "Edit", { file_path: "a.ts" }, {
      signal: controller.signal,
      toolUseID: "tool-3"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    transport.failEdits = true;

    await broker.handleCallback(callbackData(transport, "허용"));
    await expect(decision).resolves.toMatchObject({ behavior: "allow" });
  });
});
