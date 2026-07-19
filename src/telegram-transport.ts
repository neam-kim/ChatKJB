import { InputFile, type Api, type InlineKeyboard } from "grammy";
import { redactSensitiveText } from "./redaction.js";
import type { MessageTransport } from "./types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(error: unknown, attempt: number): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    error_code?: number;
    parameters?: { retry_after?: number; };
    error?: { code?: string; };
  };
  if (value.error_code === 429) {
    return Math.max(1000, (value.parameters?.retry_after ?? 1) * 1000);
  }
  if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(value.error?.code ?? "")) {
    return attempt * 1000;
  }
  return null;
}

export function safeErrorMessage(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]");
  }
  message = message
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]+/g, "sk-ant-oat01-[REDACTED]");
  return redactSensitiveText(message);
}

export class TelegramTransport implements MessageTransport {
  constructor(private readonly api: Api) {}

  private async call<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const delay = retryDelay(error, attempt);
        if (delay === null || attempt === 3) throw error;
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async sendText(
    chatId: number,
    topicId: number,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<number> {
    const message = await this.call(() => this.api.sendMessage(chatId, text, {
      message_thread_id: topicId,
      ...(keyboard ? { reply_markup: keyboard } : {})
    }));
    return message.message_id;
  }

  async editText(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard
  ): Promise<void> {
    await this.call(() => this.api.editMessageText(chatId, messageId, text, {
      ...(keyboard ? { reply_markup: keyboard } : {})
    }));
  }

  async createTopic(chatId: number, title: string): Promise<number> {
    const topic = await this.call(() => this.api.createForumTopic(chatId, title.slice(0, 128)));
    return topic.message_thread_id;
  }

  async renameTopic(chatId: number, topicId: number, title: string): Promise<void> {
    await this.call(() => this.api.editForumTopic(chatId, topicId, { name: title.slice(0, 128) }));
  }

  async deleteTopic(chatId: number, topicId: number): Promise<void> {
    await this.call(() => this.api.deleteForumTopic(chatId, topicId));
  }

  async sendDocument(
    chatId: number,
    topicId: number,
    filename: string,
    content: string,
    caption?: string
  ): Promise<void> {
    await this.call(() => this.api.sendDocument(chatId, new InputFile(Buffer.from(content), filename), {
      message_thread_id: topicId,
      ...(caption ? { caption } : {})
    }));
  }

  async sendChatAction(chatId: number, topicId: number, action: string): Promise<void> {
    await this.call(() => this.api.sendChatAction(chatId, action as "typing", {
      message_thread_id: topicId
    }));
  }

  async sendFile(chatId: number, topicId: number, filePath: string, caption?: string): Promise<void> {
    const { createReadStream } = await import("node:fs");
    const { basename } = await import("node:path");
    await this.call(() => this.api.sendDocument(
      chatId,
      new InputFile(createReadStream(filePath), basename(filePath)),
      { message_thread_id: topicId, ...(caption ? { caption } : {}) }
    ));
  }
}
