import { describe, expect, it, vi } from "vitest";
import {
  botApiChatIdFromChannelId,
  TelegramTopicDeletionMonitor,
  topicIdsFromDeleteChannelUpdate,
  type TopicDeletionSource,
  type TopicSessionStore
} from "../src/telegram-topic-deletion.js";
import type { SessionRecord } from "../src/types.js";

const TEST_CHAT_ID = -1_000_000_000_123;

function session(id: string, topicId: number): SessionRecord {
  return {
    id,
    sdkSessionId: null,
    chatId: TEST_CHAT_ID,
    topicId,
    projectName: "test",
    cwd: "/tmp",
    title: id,
    status: "done",
    permissionMode: "default",
    provider: "claude",
    model: null,
    thinking: null,
    claudeEffort: null,
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
    createdAt: 0,
    updatedAt: 0
  };
}

class FakeSource implements TopicDeletionSource {
  handler: ((topicIds: readonly number[]) => Promise<void>) | null = null;
  readonly deleted = new Set<number>();
  readonly findCalls: number[][] = [];
  stopped = false;

  async start(handler: (topicIds: readonly number[]) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async findDeletedTopicIds(topicIds: readonly number[]): Promise<number[]> {
    this.findCalls.push([...topicIds]);
    return topicIds.filter((id) => this.deleted.has(id));
  }

  async emit(topicIds: readonly number[]): Promise<void> {
    await this.handler?.(topicIds);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function monitorSetup(initial: SessionRecord[], additionalTopicIds?: () => readonly number[]) {
  const records = new Map(initial.map((item) => [item.topicId, item]));
  const store: TopicSessionStore = {
    getSessionByTopic(chatId, topicId) {
      const value = records.get(topicId);
      return value?.chatId === chatId ? value : undefined;
    },
    listSessions(limit = 100) {
      return [...records.values()].slice(0, limit);
    }
  };
  const source = new FakeSource();
  const deleted: string[] = [];
  const beforeDelete = vi.fn();
  const monitor = new TelegramTopicDeletionMonitor({
    chatId: TEST_CHAT_ID,
    store,
    source,
    ...(additionalTopicIds ? { additionalTopicIds } : {}),
    beforeDelete,
    sessions: {
      async deleteSession(value) {
        deleted.push(value.id);
        records.delete(value.topicId);
      }
    }
  });
  return { monitor, source, deleted, beforeDelete, records };
}

describe("MTProto topic deletion update parsing", () => {
  it("converts an MTProto channel ID to the matching Bot API chat ID", () => {
    expect(botApiChatIdFromChannelId({ toString: () => "123" })).toBe(TEST_CHAT_ID);
    expect(botApiChatIdFromChannelId("0")).toBeNull();
    expect(botApiChatIdFromChannelId("invalid")).toBeNull();
  });

  it("accepts only delete-channel updates from the configured supergroup", () => {
    const update = {
      className: "UpdateDeleteChannelMessages",
      channelId: { toString: () => "123" },
      messages: [42, 77, 42, -1, "42"]
    };
    expect(topicIdsFromDeleteChannelUpdate(update, TEST_CHAT_ID)).toEqual([42, 77]);
    expect(topicIdsFromDeleteChannelUpdate(update, -100999)).toEqual([]);
    expect(topicIdsFromDeleteChannelUpdate({ ...update, className: "UpdateDeleteMessages" }, -100123))
      .toEqual([]);
  });
});

describe("TelegramTopicDeletionMonitor", () => {
  it("reconciles topics deleted while the daemon was offline", async () => {
    const setup = monitorSetup([session("removed", 42), session("kept", 77)]);
    setup.source.deleted.add(42);

    await setup.monitor.start();

    expect(setup.source.findCalls).toEqual([[42, 77]]);
    expect(setup.deleted).toEqual(["removed"]);
    expect(setup.records.has(77)).toBe(true);
    expect(setup.beforeDelete).toHaveBeenCalledWith(42);
    await setup.monitor.stop();
    expect(setup.source.stopped).toBe(true);
  });

  it("removes a session when a live deletion contains its root message ID", async () => {
    const setup = monitorSetup([session("live", 42)]);
    await setup.monitor.start();

    await setup.source.emit([999, 42]);

    expect(setup.source.findCalls).toEqual([[42]]);
    expect(setup.deleted).toEqual(["live"]);
    await setup.source.emit([42]);
    expect(setup.deleted).toEqual(["live"]);
    await setup.monitor.stop();
  });

  it("preserves the session when Telegram reports an ordinary message deletion", async () => {
    const setup = monitorSetup([session("kept", 42)]);
    await setup.monitor.start();

    await setup.source.emit([99]);

    expect(setup.deleted).toEqual([]);
    expect(setup.records.has(42)).toBe(true);
    await setup.monitor.stop();
  });

  it("cleans tracked pending topics even when no session record exists", async () => {
    const setup = monitorSetup([], () => [88]);
    await setup.monitor.start();

    await setup.source.emit([88]);

    expect(setup.beforeDelete).toHaveBeenCalledWith(88);
    expect(setup.deleted).toEqual([]);
    await setup.monitor.stop();
  });
});
