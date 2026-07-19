import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionRecord } from "./types.js";

export interface TopicDeletionSource {
  start(handler: (topicIds: readonly number[]) => Promise<void>): Promise<void>;
  findDeletedTopicIds(topicIds: readonly number[]): Promise<number[]>;
  stop(): Promise<void>;
}

export interface TopicSessionStore {
  getSessionByTopic(chatId: number, topicId: number): SessionRecord | undefined;
  listSessions(limit?: number): SessionRecord[];
}

export interface TopicSessionDeleter {
  deleteSession(session: SessionRecord): Promise<void>;
}

export interface TeleprotoTopicDeletionConfig {
  apiId: number;
  apiHash: string;
  botToken: string;
  chatId: number;
  sessionPath: string;
}

function stringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value && typeof value === "object" && "toString" in value) {
    return String((value as { toString: () => string; }).toString());
  }
  return "";
}

export function botApiChatIdFromChannelId(channelId: unknown): number | null {
  const value = stringValue(channelId);
  if (!/^\d+$/.test(value)) return null;
  const id = BigInt(value);
  if (id <= 0n || id > 997_852_516_352n) return null;
  const chatId = Number(-(1_000_000_000_000n + id));
  return Number.isSafeInteger(chatId) ? chatId : null;
}

export function topicIdsFromDeleteChannelUpdate(
  update: unknown,
  expectedChatId: number
): number[] {
  if (!update || typeof update !== "object") return [];
  const candidate = update as {
    className?: unknown;
    channelId?: unknown;
    messages?: unknown;
  };
  if (candidate.className !== "UpdateDeleteChannelMessages") return [];
  if (botApiChatIdFromChannelId(candidate.channelId) !== expectedChatId) return [];
  if (!Array.isArray(candidate.messages)) return [];
  return [...new Set(candidate.messages.filter(
    (value): value is number => Number.isInteger(value) && Number(value) > 0
  ))];
}

async function readSession(path: string): Promise<string> {
  try {
    const info = await stat(path);
    const permissions = info.mode & 0o777;
    if (permissions !== 0o600) {
      throw new Error(
        `MTProto session permissions must be 0600, received ${permissions.toString(8)}: ${path}`
      );
    }
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeSession(path: string, value: string): Promise<void> {
  if (!value) throw new Error("MTProto authorization did not produce a persistent session");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${value}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class TeleprotoTopicDeletionSource implements TopicDeletionSource {
  private client: import("teleproto").TelegramClient | null = null;
  private teleproto: typeof import("teleproto") | null = null;
  private started = false;

  constructor(private readonly config: TeleprotoTopicDeletionConfig) {}

  async start(handler: (topicIds: readonly number[]) => Promise<void>): Promise<void> {
    if (this.started) return;
    const teleproto = await import("teleproto");
    const { Logger, LogLevel } = await import("teleproto/extensions/Logger.js");
    const storedSession = await readSession(this.config.sessionPath);
    const session = new teleproto.sessions.StringSession(storedSession);
    const logger = new Logger(LogLevel.NONE);
    const client = new teleproto.TelegramClient(
      session,
      this.config.apiId,
      this.config.apiHash,
      {
        autoReconnect: true,
        connectionRetries: 5,
        reconnectRetries: 20,
        requestRetries: 5,
        sequentialUpdates: true,
        baseLogger: logger,
        deviceModel: "ChatKJB",
        appVersion: "0.1.0",
        langCode: "ko",
        systemLangCode: "ko"
      }
    );
    const rawHandler = (update: unknown): void => {
      const topicIds = topicIdsFromDeleteChannelUpdate(update, this.config.chatId);
      if (topicIds.length === 0) return;
      void handler(topicIds).catch((error: unknown) => {
        console.error("MTProto topic deletion handler failed:", error);
      });
    };
    client.addEventHandler(
      rawHandler,
      new teleproto.events.Raw({ types: [teleproto.Api.UpdateDeleteChannelMessages] })
    );

    try {
      await client.start({ botAuthToken: this.config.botToken });
      const me = await client.getMe();
      const expectedBotId = this.config.botToken.split(":", 1)[0] ?? "";
      if (stringValue(me.id) !== expectedBotId) {
        throw new Error("MTProto session belongs to a different Telegram bot");
      }
      await writeSession(this.config.sessionPath, session.save());
    } catch (error) {
      await client.disconnect().catch(() => undefined);
      throw error;
    }

    this.teleproto = teleproto;
    this.client = client;
    this.started = true;
  }

  async findDeletedTopicIds(topicIds: readonly number[]): Promise<number[]> {
    if (!this.client || !this.teleproto || topicIds.length === 0) return [];
    // Teleproto resolves a bot's known channel ID with the MTProto-defined zero
    // access hash when no full hash is cached. messages.getDialogs is user-only
    // and must not be used by this bot-authenticated connection.
    const peer = await this.client.getInputEntity(this.config.chatId);

    const deleted: number[] = [];
    const uniqueIds = [...new Set(topicIds.filter((id) => Number.isInteger(id) && id > 0))];
    for (let offset = 0; offset < uniqueIds.length; offset += 100) {
      const chunk = uniqueIds.slice(offset, offset + 100);
      const result = await this.client.invoke(
        new this.teleproto.Api.messages.GetForumTopicsByID({ peer, topics: chunk })
      );
      for (const topic of result.topics) {
        if (topic.className === "ForumTopicDeleted" && chunk.includes(topic.id)) {
          deleted.push(topic.id);
        }
      }
    }
    return [...new Set(deleted)];
  }

  async stop(): Promise<void> {
    this.started = false;
    const client = this.client;
    this.client = null;
    this.teleproto = null;
    if (client) await client.disconnect();
  }
}

export class TelegramTopicDeletionMonitor {
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    chatId: number;
    store: TopicSessionStore;
    sessions: TopicSessionDeleter;
    source: TopicDeletionSource;
    additionalTopicIds?: () => readonly number[];
    beforeDelete?: (topicId: number) => void;
  }) {}

  private trackedTopicIds(): number[] {
    return [...new Set([
      ...this.options.store.listSessions(10_000)
        .filter((session) => session.chatId === this.options.chatId)
        .map((session) => session.topicId),
      ...(this.options.additionalTopicIds?.() ?? [])
    ].filter((topicId) => Number.isInteger(topicId) && topicId > 0))];
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.source.start((topicIds) => this.enqueue(topicIds));
    try {
      const deleted = await this.options.source.findDeletedTopicIds(this.trackedTopicIds());
      await this.deleteTopics(deleted);
    } catch (error) {
      console.warn("MTProto topic startup reconciliation failed; live deletion updates remain active:", error);
    }
  }

  private enqueue(topicIds: readonly number[]): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        const trackedTopicIds = new Set(this.trackedTopicIds());
        const tracked = [...new Set(topicIds)].filter((topicId) => trackedTopicIds.has(topicId));
        if (tracked.length === 0) return;
        // Telegram's forum protocol defines deletion of a tracked root message
        // (root message ID === topic ID) as the authoritative topic-deleted signal.
        await this.deleteTopics(tracked);
      });
    return this.tail;
  }

  private async deleteTopics(topicIds: readonly number[]): Promise<void> {
    for (const topicId of [...new Set(topicIds)]) {
      this.options.beforeDelete?.(topicId);
      const session = this.options.store.getSessionByTopic(this.options.chatId, topicId);
      if (!session) continue;
      await this.options.sessions.deleteSession(session);
      console.log(`Telegram topic ${topicId} was deleted; removed local session ${session.id}.`);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.options.source.stop();
    await this.tail.catch(() => undefined);
  }
}
