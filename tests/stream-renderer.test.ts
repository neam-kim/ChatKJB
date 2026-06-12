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
});
