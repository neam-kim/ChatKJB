import { describe, expect, it } from "vitest";
import { formatSessionStatus } from "../src/bot.js";
import type { SessionRecord } from "../src/types.js";

function session(status: SessionRecord["status"]): SessionRecord {
  return {
    id: "session",
    sdkSessionId: "sdk-session",
    chatId: -1001,
    topicId: 42,
    projectName: "test",
    cwd: "/tmp",
    title: "test session",
    status,
    permissionMode: "default",
    usageSnapshot: null,
    createdAt: 0,
    updatedAt: 0
  };
}

describe("session status formatting", () => {
  it("distinguishes a live active run from a stored status", () => {
    expect(formatSessionStatus(session("running"), true)).toContain("작업: 실행 중");
    expect(formatSessionStatus(session("running"), false)).toContain("작업: 실행 중인 작업 없음");
  });

  it("shows queued and approval states", () => {
    expect(formatSessionStatus(session("queued"), false)).toContain("작업: 대기 중");
    expect(formatSessionStatus(session("waiting_approval"), false)).toContain("작업: 승인 대기 중");
  });
});
