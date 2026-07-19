import { randomBytes } from "node:crypto";
import {
  GENERAL_TOPIC_ID,
  GUI_MAX_ATTACHMENT_BYTES,
  markedChannelId,
  nextRawHistoryCursor,
  normalizeForumTopics,
  normalizeTelegramMessage,
  rawMessageChatId,
  safeTelegramErrorCode,
  type GuiAuthState,
  type GuiAttachment,
  type GuiMessage,
  type GuiReplyPanel,
  type GuiTelegramUpdate,
  type GuiTopic,
  type HistoryCursor,
  type TopicCursor
} from "./protocol.js";
import {
  readTelegramSession,
  removeTelegramSession,
  writeTelegramSession
} from "./telegram-session.js";

const MAX_INDEXED_MESSAGES = 10_000;
const MAX_INDEXED_ATTACHMENTS = 2_048;
const TELEGRAM_MEDIA_REQUEST_TIMEOUT_MS = 30_000;

export const GUI_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export const GUI_ALLOWED_UPLOAD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
] as const;

export type TelegramUploadMimeType = typeof GUI_ALLOWED_UPLOAD_MIME_TYPES[number];

export interface TelegramUploadInput {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  caption?: string;
}

export interface TelegramUploadMetadata {
  name: string;
  mimeType: TelegramUploadMimeType;
  caption?: string;
}

const ALLOWED_UPLOAD_MIME_TYPES = new Set<string>(GUI_ALLOWED_UPLOAD_MIME_TYPES);
const IMAGE_UPLOAD_MIME_TYPES = new Set<TelegramUploadMimeType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);
const UPLOAD_INPUT_KEYS = new Set<PropertyKey>(["name", "mimeType", "bytes", "caption"]);

export function validateTelegramUploadMetadata(
  name: unknown,
  mimeType: unknown,
  caption?: unknown
): TelegramUploadMetadata {
  if (typeof name !== "string") throw new Error("Telegram upload filename must be a string");
  const nameBytes = Buffer.byteLength(name, "utf8");
  if (nameBytes < 1 || nameBytes > 255) {
    throw new Error("Telegram upload filename must contain 1-255 UTF-8 bytes");
  }
  if (name === "." || name === ".." || /[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new Error("Telegram upload filename must be a safe basename");
  }
  if (typeof mimeType !== "string" || !ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
    throw new Error("Telegram upload MIME type is not allowed");
  }
  if (caption !== undefined && (typeof caption !== "string" || caption.length > 1024)) {
    throw new Error("Telegram upload caption must contain at most 1024 characters");
  }
  return {
    name,
    mimeType: mimeType as TelegramUploadMimeType,
    ...(caption !== undefined ? { caption } : {})
  };
}

function validateTelegramUploadInput(input: TelegramUploadInput): TelegramUploadMetadata & {
  bytes: Uint8Array;
  forceDocument: boolean;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Telegram upload input must be an object");
  }
  for (const key of Reflect.ownKeys(input)) {
    if (!UPLOAD_INPUT_KEYS.has(key)) throw new Error("Telegram upload input contains an unsupported field");
  }
  const metadata = validateTelegramUploadMetadata(input.name, input.mimeType, input.caption);
  if (!(input.bytes instanceof Uint8Array)) {
    throw new Error("Telegram upload bytes must be a Uint8Array");
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > GUI_MAX_UPLOAD_BYTES) {
    throw new Error(`Telegram upload must contain 1-${GUI_MAX_UPLOAD_BYTES} bytes`);
  }
  return {
    ...metadata,
    bytes: input.bytes,
    forceDocument: !IMAGE_UPLOAD_MIME_TYPES.has(metadata.mimeType)
  };
}

export interface TelegramUserIdentity {
  id: string;
  bot: boolean;
}

export interface ResolvedForumPeer {
  peer: unknown;
  forum: boolean;
  megagroup: boolean;
}

export interface TopicPage {
  topics: GuiTopic[];
  nextCursor: TopicCursor | null;
}

export interface MessagePage {
  messages: GuiMessage[];
  nextCursor: HistoryCursor | null;
}

export class HistoryInvalidatedError extends Error {
  readonly code = "HISTORY_INVALIDATED";

  constructor() {
    super("Telegram history authority changed while it was loading");
    this.name = "HistoryInvalidatedError";
  }
}

export interface TelegramAttachmentDownload {
  kind: GuiAttachment["kind"];
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface QrLoginCallbacks {
  signal: AbortSignal;
  onQrCode(token: Uint8Array, expiresAt: number): Promise<void>;
  onPassword(hint?: string): Promise<string>;
  onError(error: Error): Promise<boolean>;
}

export interface TelegramUserAdapter {
  connect(): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  signInWithQrCode(callbacks: QrLoginCallbacks): Promise<TelegramUserIdentity>;
  getMe(): Promise<TelegramUserIdentity>;
  saveSession(): string;
  resolveForumPeer(chatId: number): Promise<ResolvedForumPeer>;
  getForumTopics(peer: unknown, cursor: TopicCursor, limit: number): Promise<unknown>;
  getGeneralHistory(peer: unknown, cursor: HistoryCursor, limit: number): Promise<unknown>;
  getTopicHistory(peer: unknown, topicId: number, cursor: HistoryCursor, limit: number): Promise<unknown>;
  sendText(peer: unknown, input: {
    text: string;
    replyToMessageId?: number;
    topMessageId?: number;
  }): Promise<unknown>;
  sendFile(peer: unknown, input: TelegramUploadMetadata & {
    bytes: Uint8Array;
    forceDocument: boolean;
    replyToMessageId?: number;
    topMessageId?: number;
  }): Promise<unknown>;
  downloadMedia(message: unknown, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array>;
  pressCallback(peer: unknown, messageId: number, data: Uint8Array): Promise<unknown>;
  markGeneralRead(peer: unknown, maxMessageId: number): Promise<void>;
  markTopicRead(peer: unknown, topicId: number, maxMessageId: number): Promise<void>;
  setTyping(peer: unknown, topicId: number, active: boolean): Promise<void>;
  addRawUpdateHandler(handler: (update: unknown) => void): void;
  catchUp(): Promise<void>;
  logOut(): Promise<boolean | void>;
  disconnect(): Promise<void>;
}

export interface TelegramUserClientOptions {
  apiId: number;
  apiHash: string;
  chatId: number;
  allowedUserIds: readonly number[];
  sessionPath: string;
  adapterFactory?: (storedSession: string) => Promise<TelegramUserAdapter>;
  onAuthState?: (state: GuiAuthState) => void;
  onQrCode?: (token: Uint8Array, expiresAt: number) => void;
  onUpdate?: (update: GuiTelegramUpdate) => void;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function abortError(): Error {
  const error = new Error("Telegram login was cancelled");
  error.name = "AbortError";
  return error;
}

async function revokeTelegramSession(adapter: TelegramUserAdapter): Promise<void> {
  if (await adapter.logOut() === false) {
    throw new Error("Telegram server did not revoke the user session");
  }
}

function stringId(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value && typeof value === "object" && "toString" in value) {
    return String((value as { toString(): string; }).toString());
  }
  return "";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export class TelegramUserClient {
  private adapter: TelegramUserAdapter | null = null;
  private peer: unknown = null;
  private scopeAuthorized = false;
  private startTask: Promise<void> | null = null;
  private startAbort: AbortController | null = null;
  private loginTask: Promise<void> | null = null;
  private lifecycleClosing = false;
  private closeTask: Promise<void> | null = null;
  private closeMode: "stop" | "logout" | null = null;
  private closeFailure: unknown;
  private closeRevocationComplete = false;
  private loginAbort: AbortController | null = null;
  private passwordResolve: ((password: string) => void) | null = null;
  private passwordReject: ((error: Error) => void) | null = null;
  private topicIds = new Set<number>([GENERAL_TOPIC_ID]);
  private readonly messageTopics = new Map<number, number>();
  private readonly callbackAllowlist = new Map<number, Set<string>>();
  private readonly attachmentByToken = new Map<string, {
    messageId: number;
    revision: string;
    sourceMessage: unknown;
    metadata: Omit<GuiAttachment, "token" | "size" | "width" | "height">;
  }>();
  private readonly attachmentByMessage = new Map<number, { token: string; revision: string; }>();
  private readonly deletedMessageIds = new Set<number>();
  private readonly liveMessageRevisions = new Map<number, string>();
  private authorityEpoch = 0;
  private topicRefreshEpoch = 0;
  private topicStaging: {
    authorityEpoch: number;
    refreshEpoch: number;
    ids: Set<number>;
    expectedCursor: TopicCursor | null;
  } | null = null;
  private readonly allowedUserIds: ReadonlySet<string>;

  constructor(private readonly options: TelegramUserClientOptions) {
    positiveInteger(options.apiId, "apiId");
    if (!/^[a-f0-9]{32}$/i.test(options.apiHash)) throw new Error("apiHash has an invalid format");
    if (!Number.isSafeInteger(options.chatId) || options.chatId >= 0) throw new Error("chatId must be a marked Telegram group ID");
    if (options.allowedUserIds.length === 0) throw new Error("at least one allowed Telegram user is required");
    const allowed = options.allowedUserIds.map((id) => positiveInteger(id, "allowedUserId"));
    this.allowedUserIds = new Set(allowed.map(String));
  }

  private authState(state: GuiAuthState): void {
    this.options.onAuthState?.(state);
  }

  start(): Promise<void> {
    if (this.lifecycleClosing) {
      return Promise.reject(new Error("Telegram user client is stopping"));
    }
    if (this.startTask) return this.startTask;
    if (this.adapter) return Promise.resolve();
    const controller = new AbortController();
    this.startAbort = controller;
    const task = this.runStart(controller);
    const tracked = task.finally(() => {
      if (this.startTask === tracked) this.startTask = null;
      if (this.startAbort === controller) this.startAbort = null;
    });
    this.startTask = tracked;
    return tracked;
  }

  private async runStart(controller: AbortController): Promise<void> {
    this.authState({ state: "connecting" });
    let adapter: TelegramUserAdapter | null = null;
    let adapterWasInstalled = false;
    let stored = "";
    try {
      stored = await readTelegramSession(this.options.sessionPath);
      if (controller.signal.aborted && this.closeMode !== "logout") throw abortError();
      adapter = await this.createAdapter(stored);
      if (controller.signal.aborted && this.closeMode !== "logout") throw abortError();
      this.adapter = adapter;
      adapterWasInstalled = true;
      adapter.addRawUpdateHandler((update) => this.handleRawUpdate(update));
      await adapter.connect();
      if (controller.signal.aborted) throw abortError();
      if (!await adapter.checkAuthorization()) {
        if (controller.signal.aborted) throw abortError();
        this.authState({ state: "signed_out" });
        return;
      }
      await this.finishAuthorization(adapter, await adapter.getMe(), false, controller.signal);
    } catch (error) {
      if (adapter) {
        if (this.adapter === adapter) {
          if (controller.signal.aborted && this.closeMode === "logout") {
            await this.revokeAdapterForClose(adapter, adapter.saveSession() || stored);
          }
          await this.resetAdapter(adapter);
        }
        else if (!adapterWasInstalled) await adapter.disconnect().catch(() => undefined);
      }
      if (controller.signal.aborted) {
        this.authState({ state: "signed_out" });
        return;
      }
      this.authState({ state: "error", errorCode: safeTelegramErrorCode(error) });
      throw error;
    }
  }

  beginQrLogin(): Promise<void> {
    if (this.lifecycleClosing) {
      return Promise.reject(new Error("Telegram user client is stopping"));
    }
    if (this.startTask) {
      return Promise.reject(new Error("Telegram user client is still starting"));
    }
    if (this.loginTask) {
      return Promise.reject(new Error("Telegram QR login is already in progress"));
    }
    const task = this.runQrLogin();
    const tracked = task.finally(() => {
      if (this.loginTask === tracked) this.loginTask = null;
    });
    this.loginTask = tracked;
    return tracked;
  }

  private async runQrLogin(): Promise<void> {
    const adapter = this.requireAdapter();
    this.loginAbort?.abort();
    const controller = new AbortController();
    this.loginAbort = controller;
    this.authState({ state: "connecting" });
    let ephemeralLogin = false;
    let qrIdentityReturned = false;
    try {
      const authorized = await adapter.checkAuthorization();
      if (controller.signal.aborted) throw abortError();
      if (authorized) {
        await this.finishAuthorization(adapter, await adapter.getMe(), false, controller.signal);
        return;
      }
      ephemeralLogin = true;
      const identity = await adapter.signInWithQrCode({
        signal: controller.signal,
        onQrCode: async (token, expiresAt) => {
          this.authState({ state: "waiting_qr" });
          this.options.onQrCode?.(Uint8Array.from(token), expiresAt);
        },
        onPassword: async (hint) => {
          this.authState({ state: "waiting_password", ...(hint ? { passwordHint: hint } : {}) });
          return await new Promise<string>((resolve, reject) => {
            const clear = () => {
              controller.signal.removeEventListener("abort", rejectOnAbort);
              this.passwordResolve = null;
              this.passwordReject = null;
            };
            const rejectOnAbort = () => {
              clear();
              reject(abortError());
            };
            this.passwordResolve = (password) => {
              clear();
              resolve(password);
            };
            this.passwordReject = (error) => {
              clear();
              reject(error);
            };
            if (controller.signal.aborted) rejectOnAbort();
            else controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
          });
        },
        onError: async (error) => {
          this.authState({ state: "error", errorCode: safeTelegramErrorCode(error) });
          return true;
        }
      });
      qrIdentityReturned = true;
      await this.finishAuthorization(adapter, identity, true, controller.signal);
    } catch (error) {
      if (ephemeralLogin) await this.discardEphemeralAdapter(adapter, qrIdentityReturned);
      else {
        if (controller.signal.aborted && this.closeMode === "logout" && this.adapter === adapter) {
          try {
            await revokeTelegramSession(adapter);
            this.closeRevocationComplete = true;
          } catch (logoutError) {
            this.closeFailure ??= logoutError;
          }
        }
        await this.resetAdapter(adapter);
      }
      if (controller.signal.aborted) {
        this.authState({ state: "signed_out" });
        return;
      }
      this.authState({ state: "error", errorCode: safeTelegramErrorCode(error) });
      throw error;
    } finally {
      this.passwordResolve = null;
      this.passwordReject = null;
      if (this.loginAbort === controller) this.loginAbort = null;
    }
  }

  submitPassword(password: string): void {
    if (!this.passwordResolve) throw new Error("Telegram is not waiting for a 2FA password");
    if (!password) throw new Error("Telegram 2FA password cannot be empty");
    const resolve = this.passwordResolve;
    this.passwordResolve = null;
    resolve(password);
  }

  cancelLogin(): void {
    this.passwordReject?.(abortError());
    this.loginAbort?.abort();
    this.loginAbort = null;
    this.passwordResolve = null;
    this.passwordReject = null;
  }

  private async finishAuthorization(
    adapter: TelegramUserAdapter,
    identity: TelegramUserIdentity,
    persist: boolean,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (identity.bot || !this.allowedUserIds.has(identity.id)) {
      await this.discardUnauthorizedAdapter(adapter);
      throw new Error("Telegram account is not authorized for ChatKJB Terminal");
    }
    const resolved = await adapter.resolveForumPeer(this.options.chatId);
    if (!resolved.forum || !resolved.megagroup) {
      throw new Error("Configured Telegram chat is not a forum supergroup");
    }
    if (signal?.aborted) throw abortError();
    if (persist) await writeTelegramSession(this.options.sessionPath, adapter.saveSession());
    await adapter.catchUp();
    if (signal?.aborted) throw abortError();
    if (this.adapter !== adapter) throw new Error("Telegram authorization was superseded");
    this.peer = resolved.peer;
    this.scopeAuthorized = true;
    this.authState({ state: "ready" });
    this.requestReconciliation();
  }

  async listTopics(cursor: TopicCursor = { offsetDate: 0, offsetId: 0, offsetTopic: 0 }, limit = 50): Promise<TopicPage> {
    const adapter = this.requireReadyAdapter();
    const authorityEpoch = this.authorityEpoch;
    const firstPage = cursor.offsetDate === 0 && cursor.offsetId === 0 && cursor.offsetTopic === 0;
    let staging = this.topicStaging;
    if (firstPage) {
      staging = {
        authorityEpoch,
        refreshEpoch: ++this.topicRefreshEpoch,
        ids: new Set<number>([GENERAL_TOPIC_ID]),
        expectedCursor: null
      };
      this.topicStaging = staging;
    } else if (
      !staging
      || staging.authorityEpoch !== authorityEpoch
      || !this.sameTopicCursor(staging.expectedCursor, cursor)
    ) {
      this.topicStaging = null;
      throw new HistoryInvalidatedError();
    }
    const bounded = Math.min(100, positiveInteger(limit, "limit"));
    let page: TopicPage;
    let rawTopicCount = 0;
    try {
      const rawPage = await adapter.getForumTopics(this.peer, cursor, bounded);
      const rawTopics = record(rawPage)?.["topics"];
      rawTopicCount = Array.isArray(rawTopics) ? rawTopics.length : 0;
      page = normalizeForumTopics(rawPage);
    } catch (error) {
      if (this.topicStaging === staging) this.topicStaging = null;
      throw error;
    }
    if (
      !this.scopeAuthorized
      || this.adapter !== adapter
      || this.authorityEpoch !== authorityEpoch
      || this.topicStaging !== staging
    ) throw new HistoryInvalidatedError();
    for (const topic of page.topics) staging.ids.add(topic.id);
    const terminalPage = !page.nextCursor || rawTopicCount < bounded;
    if (!terminalPage) {
      staging.expectedCursor = page.nextCursor;
    } else {
      this.topicIds = new Set(staging.ids);
      this.topicStaging = null;
    }
    return { topics: page.topics, nextCursor: terminalPage ? null : page.nextCursor };
  }

  async listMessages(
    topicId: number,
    cursor: HistoryCursor = { offsetId: 0, offsetDate: 0 },
    limit = 50
  ): Promise<MessagePage> {
    this.requireKnownTopic(topicId);
    const adapter = this.requireReadyAdapter();
    const authorityEpoch = this.authorityEpoch;
    const bounded = Math.min(100, positiveInteger(limit, "limit"));
    const raw = topicId === GENERAL_TOPIC_ID
      ? await adapter.getGeneralHistory(this.peer, cursor, bounded)
      : await adapter.getTopicHistory(this.peer, topicId, cursor, bounded);
    if (!this.scopeAuthorized || this.adapter !== adapter || this.authorityEpoch !== authorityEpoch) {
      throw new HistoryInvalidatedError();
    }
    const result = record(raw);
    const source = Array.isArray(result?.["messages"]) ? result["messages"] : [];
    const messages = source.flatMap((message): GuiMessage[] => {
      if (rawMessageChatId(message) !== this.options.chatId) return [];
      const normalized = normalizeTelegramMessage(message, this.topicIds);
      if (!normalized || normalized.topicId !== topicId) return [];
      if (this.deletedMessageIds.has(normalized.id)) return [];
      const revision = this.attachmentRevision(message, normalized);
      const liveRevision = this.liveMessageRevisions.get(normalized.id);
      if (liveRevision !== undefined && liveRevision !== revision) return [];
      this.indexMessage(normalized, message);
      return [normalized];
    });
    return { messages, nextCursor: nextRawHistoryCursor(source) };
  }

  async findGeneralReplyPanel(): Promise<GuiReplyPanel | null> {
    const adapter = this.requireReadyAdapter();
    const authorityEpoch = this.authorityEpoch;
    const peer = this.peer;
    let cursor: HistoryCursor = { offsetId: 0, offsetDate: 0 };
    for (let page = 0; page < 10; page += 1) {
      const raw = await adapter.getGeneralHistory(peer, cursor, 100);
      if (
        !this.scopeAuthorized
        || this.adapter !== adapter
        || this.peer !== peer
        || this.authorityEpoch !== authorityEpoch
      ) throw new HistoryInvalidatedError();
      const result = record(raw);
      const source = Array.isArray(result?.["messages"]) ? result["messages"].slice(0, 100) : [];
      const panels = source.flatMap((message): GuiReplyPanel[] => {
        if (rawMessageChatId(message) !== this.options.chatId) return [];
        const normalized = normalizeTelegramMessage(message, this.topicIds);
        if (!normalized || normalized.topicId !== GENERAL_TOPIC_ID || !normalized.replyPanel) return [];
        return [normalized.replyPanel];
      }).sort((left, right) => right.messageId - left.messageId);
      if (panels[0]) return panels[0];
      if (source.length < 100) return null;
      const nextCursor = nextRawHistoryCursor(source);
      if (!nextCursor || (nextCursor.offsetId === cursor.offsetId && nextCursor.offsetDate === cursor.offsetDate)) {
        return null;
      }
      cursor = nextCursor;
    }
    return null;
  }

  async sendText(topicId: number, text: string, replyToMessageId?: number): Promise<void> {
    this.requireKnownTopic(topicId);
    if (!text.trim() || text.length > 4096) throw new Error("Telegram text must contain 1-4096 characters");
    const adapter = this.requireReadyAdapter();
    if (replyToMessageId !== undefined) positiveInteger(replyToMessageId, "replyToMessageId");
    if (topicId === GENERAL_TOPIC_ID) {
      await adapter.sendText(this.peer, {
        text,
        ...(replyToMessageId ? { replyToMessageId } : {})
      });
      return;
    }
    await adapter.sendText(this.peer, {
      text,
      replyToMessageId: replyToMessageId ?? topicId,
      ...(replyToMessageId && replyToMessageId !== topicId ? { topMessageId: topicId } : {})
    });
  }

  async sendFile(topicId: number, input: TelegramUploadInput): Promise<void> {
    this.requireKnownTopic(topicId);
    const upload = validateTelegramUploadInput(input);
    const adapter = this.requireReadyAdapter();
    await adapter.sendFile(this.peer, {
      ...upload,
      ...(topicId === GENERAL_TOPIC_ID
        ? {}
        : { replyToMessageId: topicId, topMessageId: topicId })
    });
  }

  async downloadAttachment(token: string, signal?: AbortSignal): Promise<TelegramAttachmentDownload> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Telegram attachment reference is invalid");
    const authority = this.attachmentByToken.get(token);
    if (!authority) throw new Error("Telegram attachment is not available");
    const adapter = this.requireReadyAdapter();
    const bytes = await adapter.downloadMedia(authority.sourceMessage, GUI_MAX_ATTACHMENT_BYTES, signal);
    if (
      !(bytes instanceof Uint8Array)
      || bytes.byteLength < 1
      || bytes.byteLength > GUI_MAX_ATTACHMENT_BYTES
      || this.attachmentByToken.get(token) !== authority
      || !this.scopeAuthorized
    ) throw new Error("Telegram attachment is not available");
    return { ...authority.metadata, bytes };
  }

  async pressCallback(messageId: number, callbackData: string): Promise<unknown> {
    positiveInteger(messageId, "messageId");
    const allowed = this.callbackAllowlist.get(messageId);
    if (!allowed?.has(callbackData)) throw new Error("Callback is not present on the Telegram message");
    const data = Buffer.from(callbackData, "base64url");
    if (data.length === 0 || data.length > 64) throw new Error("Callback data has an invalid size");
    return await this.requireReadyAdapter().pressCallback(this.peer, messageId, data);
  }

  async markRead(topicId: number, maxMessageId: number): Promise<void> {
    this.requireKnownTopic(topicId);
    positiveInteger(maxMessageId, "maxMessageId");
    const adapter = this.requireReadyAdapter();
    if (topicId === GENERAL_TOPIC_ID) await adapter.markGeneralRead(this.peer, maxMessageId);
    else await adapter.markTopicRead(this.peer, topicId, maxMessageId);
  }

  async setTyping(topicId: number, active: boolean): Promise<void> {
    this.requireKnownTopic(topicId);
    await this.requireReadyAdapter().setTyping(this.peer, topicId, active);
  }

  logOut(): Promise<void> {
    return this.close("logout");
  }

  stop(): Promise<void> {
    return this.close("stop");
  }

  private close(mode: "stop" | "logout"): Promise<void> {
    if (this.closeTask) {
      if (this.closeMode === "logout" || this.closeMode === mode) return this.closeTask;
      return Promise.reject(new Error("Telegram user client stop is already in progress; retry logout"));
    }
    this.lifecycleClosing = true;
    this.closeMode = mode;
    this.closeFailure = undefined;
    this.closeRevocationComplete = false;
    this.clearAuthorizationState();
    const task = this.runClose(mode);
    const tracked = task.finally(() => {
      if (this.closeTask === tracked) this.closeTask = null;
      this.closeMode = null;
      this.closeFailure = undefined;
      this.closeRevocationComplete = false;
      this.lifecycleClosing = false;
    });
    this.closeTask = tracked;
    return tracked;
  }

  private async runClose(mode: "stop" | "logout"): Promise<void> {
    const startTask = this.startTask;
    this.startAbort?.abort();
    const loginTask = this.loginTask;
    this.cancelLogin();
    await Promise.all([
      startTask?.catch(() => undefined),
      loginTask?.catch(() => undefined)
    ]);
    let adapter = this.adapter;
    this.adapter = null;
    this.clearAuthorizationState();
    let failure = this.closeFailure;
    let retryAdapter = false;
    if (mode === "logout" && !adapter && !failure && !this.closeRevocationComplete) {
      retryAdapter = true;
      try {
        const stored = await readTelegramSession(this.options.sessionPath);
        if (stored) {
          adapter = await this.createAdapter(stored);
          await adapter.connect();
          if (await adapter.checkAuthorization()) await revokeTelegramSession(adapter);
          this.closeRevocationComplete = true;
        }
      } catch (error) {
        failure ??= error;
      }
    }
    if (adapter) {
      if (mode === "logout" && !retryAdapter) {
        try {
          await revokeTelegramSession(adapter);
          this.closeRevocationComplete = true;
        } catch (error) {
          failure ??= error;
        }
      }
      await adapter.disconnect().catch(() => undefined);
    }
    if (mode === "logout" && !failure) {
      try {
        await removeTelegramSession(this.options.sessionPath);
      } catch (error) {
        failure ??= error;
      }
    }
    if (mode === "logout" && !failure) {
      this.authState({ state: "signed_out" });
    }
    if (mode === "logout" && failure) {
      this.authState({ state: "error", errorCode: "TELEGRAM_LOGOUT_FAILED" });
    }
    if (failure) throw failure;
  }

  private async createAdapter(storedSession: string): Promise<TelegramUserAdapter> {
    const factory = this.options.adapterFactory ?? ((session) => createTeleprotoUserAdapter({
      apiId: this.options.apiId,
      apiHash: this.options.apiHash,
      storedSession: session
    }));
    return await factory(storedSession);
  }

  private handleRawUpdate(update: unknown): void {
    if (!this.scopeAuthorized) return;
    const value = record(update);
    if (!value) return;
    const className = value["className"];
    if (className === "ChatKjbConnectionRestored") {
      this.requestReconciliation();
      return;
    }
    if (className === "UpdateChannelTooLong") {
      if (markedChannelId(value["channelId"]) === this.options.chatId) {
        this.requestReconciliation();
      }
      return;
    }
    if (className === "UpdateDeleteChannelMessages") {
      if (markedChannelId(value["channelId"]) !== this.options.chatId) return;
      const ids = Array.isArray(value["messages"])
        ? value["messages"].filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0)
        : [];
      const byTopic = new Map<number, number[]>();
      let needsReconcile = false;
      for (const id of ids) {
        this.deletedMessageIds.delete(id);
        this.deletedMessageIds.add(id);
        this.liveMessageRevisions.delete(id);
        while (this.deletedMessageIds.size > MAX_INDEXED_MESSAGES) {
          const oldest = this.deletedMessageIds.values().next().value as number | undefined;
          if (oldest === undefined) break;
          this.deletedMessageIds.delete(oldest);
        }
        let classified = false;
        if (this.topicIds.has(id) && id !== GENERAL_TOPIC_ID) {
          this.topicIds.delete(id);
          this.topicStaging?.ids.delete(id);
          this.options.onUpdate?.({ type: "topic_delete", topicId: id });
          classified = true;
        }
        const topicId = this.messageTopics.get(id);
        if (topicId === undefined) {
          if (!classified) needsReconcile = true;
          continue;
        }
        const topicMessages = byTopic.get(topicId) ?? [];
        topicMessages.push(id);
        byTopic.set(topicId, topicMessages);
        this.removeIndexedMessage(id);
      }
      for (const [topicId, messageIds] of byTopic) {
        this.options.onUpdate?.({ type: "message_delete", topicId, messageIds });
      }
      if (needsReconcile) this.requestReconciliation();
      return;
    }
    if (className !== "UpdateNewChannelMessage" && className !== "UpdateEditChannelMessage") return;
    const message = value["message"];
    if (rawMessageChatId(message) !== this.options.chatId) return;
    const messageValue = record(message);
    const action = record(messageValue?.["action"]);
    if (
      messageValue?.["className"] === "MessageService"
      && ["MessageActionTopicCreate", "MessageActionTopicEdit"].includes(String(action?.["className"] ?? ""))
    ) {
      this.requestReconciliation();
      return;
    }
    const normalized = normalizeTelegramMessage(message, this.topicIds);
    if (!normalized) return;
    if (!this.topicIds.has(normalized.topicId)) {
      this.requestReconciliation();
      return;
    }
    this.deletedMessageIds.delete(normalized.id);
    this.liveMessageRevisions.delete(normalized.id);
    this.liveMessageRevisions.set(normalized.id, this.attachmentRevision(message, normalized));
    while (this.liveMessageRevisions.size > MAX_INDEXED_MESSAGES) {
      const oldest = this.liveMessageRevisions.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.liveMessageRevisions.delete(oldest);
    }
    this.indexMessage(normalized, message);
    this.options.onUpdate?.({ type: "message_upsert", message: normalized });
  }

  private requestReconciliation(): void {
    this.authorityEpoch += 1;
    this.topicStaging = null;
    this.messageTopics.clear();
    this.callbackAllowlist.clear();
    this.clearAttachmentAuthorities();
    this.options.onUpdate?.({ type: "reconcile_required" });
  }

  private indexMessage(message: GuiMessage, sourceMessage: unknown): void {
    if (this.messageTopics.has(message.id)) this.messageTopics.delete(message.id);
    this.messageTopics.set(message.id, message.topicId);
    const callbacks = new Set<string>();
    for (const row of message.buttons) {
      for (const button of row) {
        if (button.kind === "callback" && button.callbackData && !button.requiresPassword) {
          callbacks.add(button.callbackData);
        }
      }
    }
    if (callbacks.size > 0) this.callbackAllowlist.set(message.id, callbacks);
    else this.callbackAllowlist.delete(message.id);
    if (message.attachment) {
      const revision = this.attachmentRevision(sourceMessage, message);
      const previous = this.attachmentByMessage.get(message.id);
      let token = previous?.revision === revision ? previous.token : "";
      if (!token) {
        if (previous) this.attachmentByToken.delete(previous.token);
        token = randomBytes(32).toString("base64url");
        this.attachmentByMessage.set(message.id, { token, revision });
      }
      message.attachment = { ...message.attachment, token };
      this.attachmentByToken.delete(token);
      this.attachmentByToken.set(token, {
        messageId: message.id,
        revision,
        sourceMessage,
        metadata: {
          kind: message.attachment.kind,
          name: message.attachment.name,
          mimeType: message.attachment.mimeType
        }
      });
      while (this.attachmentByToken.size > MAX_INDEXED_ATTACHMENTS) {
        const oldestToken = this.attachmentByToken.keys().next().value as string | undefined;
        if (!oldestToken) break;
        const oldest = this.attachmentByToken.get(oldestToken);
        this.attachmentByToken.delete(oldestToken);
        if (oldest && this.attachmentByMessage.get(oldest.messageId)?.token === oldestToken) {
          this.attachmentByMessage.delete(oldest.messageId);
        }
      }
    } else {
      this.removeAttachmentAuthority(message.id);
    }
    while (this.messageTopics.size > MAX_INDEXED_MESSAGES) {
      const oldest = this.messageTopics.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.removeIndexedMessage(oldest);
    }
  }

  private attachmentRevision(sourceMessage: unknown, message: GuiMessage): string {
    const source = record(sourceMessage);
    const media = record(source?.["media"]);
    const mediaObject = record(media?.["photo"]) ?? record(media?.["document"]);
    return [
      message.id,
      message.editedAt ?? message.sentAt,
      stringId(mediaObject?.["id"]),
      message.attachment?.kind,
      message.attachment?.mimeType,
      message.attachment?.size
    ].join(":");
  }

  private removeAttachmentAuthority(messageId: number): void {
    const authority = this.attachmentByMessage.get(messageId);
    if (authority) this.attachmentByToken.delete(authority.token);
    this.attachmentByMessage.delete(messageId);
  }

  private removeIndexedMessage(messageId: number): void {
    this.messageTopics.delete(messageId);
    this.callbackAllowlist.delete(messageId);
    this.removeAttachmentAuthority(messageId);
  }

  private clearAttachmentAuthorities(): void {
    this.attachmentByToken.clear();
    this.attachmentByMessage.clear();
  }

  private clearAuthorizationState(): void {
    this.authorityEpoch += 1;
    this.topicStaging = null;
    this.deletedMessageIds.clear();
    this.liveMessageRevisions.clear();
    this.scopeAuthorized = false;
    this.peer = null;
    this.topicIds.clear();
    this.topicIds.add(GENERAL_TOPIC_ID);
    this.messageTopics.clear();
    this.callbackAllowlist.clear();
    this.clearAttachmentAuthorities();
  }

  private sameTopicCursor(actual: TopicCursor | null, expected: TopicCursor): boolean {
    return actual !== null
      && actual.offsetDate === expected.offsetDate
      && actual.offsetId === expected.offsetId
      && actual.offsetTopic === expected.offsetTopic;
  }

  private async resetAdapter(adapter: TelegramUserAdapter): Promise<void> {
    if (this.adapter !== adapter) return;
    this.adapter = null;
    this.clearAuthorizationState();
    await adapter.disconnect().catch(() => undefined);
  }

  private async revokeAdapterForClose(adapter: TelegramUserAdapter, retrySession: string): Promise<void> {
    try {
      const authorized = await adapter.checkAuthorization();
      if (authorized || retrySession) await revokeTelegramSession(adapter);
      this.closeRevocationComplete = true;
    } catch (error) {
      this.closeFailure ??= error;
    }
  }

  private async discardUnauthorizedAdapter(adapter: TelegramUserAdapter): Promise<void> {
    await this.discardEphemeralAdapter(adapter, true);
  }

  private async discardEphemeralAdapter(
    adapter: TelegramUserAdapter,
    authorizationMayExist = false
  ): Promise<void> {
    if (this.adapter !== adapter) return;
    const retrySession = adapter.saveSession();
    let authorized = false;
    try {
      authorized = await adapter.checkAuthorization();
    } catch (error) {
      await this.preserveRevocationRetry(adapter, retrySession, error);
    }
    if (!authorized && !authorizationMayExist && !retrySession) {
      await this.resetAdapter(adapter);
      await removeTelegramSession(this.options.sessionPath);
      return;
    }
    try {
      await revokeTelegramSession(adapter);
    } catch (error) {
      await this.preserveRevocationRetry(adapter, retrySession, error);
    }
    await this.resetAdapter(adapter);
    await removeTelegramSession(this.options.sessionPath);
  }

  private async preserveRevocationRetry(
    adapter: TelegramUserAdapter,
    retrySession: string,
    cause: unknown
  ): Promise<never> {
    let preservationError: unknown;
    try {
      await writeTelegramSession(this.options.sessionPath, retrySession);
    } catch (error) {
      preservationError = error;
    }
    await this.resetAdapter(adapter);
    if (preservationError) {
      throw new AggregateError(
        [cause, preservationError],
        "Telegram session revocation failed and the retry session could not be preserved"
      );
    }
    throw cause;
  }

  private requireAdapter(): TelegramUserAdapter {
    if (!this.adapter) throw new Error("Telegram user client has not started");
    return this.adapter;
  }

  private requireReadyAdapter(): TelegramUserAdapter {
    if (this.lifecycleClosing) throw new Error("Telegram user client is stopping");
    if (!this.peer) throw new Error("Telegram user client is not authorized and ready");
    return this.requireAdapter();
  }

  private requireKnownTopic(topicId: number): void {
    positiveInteger(topicId, "topicId");
    if (!this.topicIds.has(topicId)) throw new Error("Telegram topic is not in the verified forum topic set");
  }
}

async function createTeleprotoUserAdapter(input: {
  apiId: number;
  apiHash: string;
  storedSession: string;
}): Promise<TelegramUserAdapter> {
  const teleproto = await import("teleproto");
  const { generateRandomLong, returnBigInt } = await import("teleproto/Helpers.js");
  const { Logger, LogLevel } = await import("teleproto/extensions/Logger.js");
  const { UpdateConnectionState } = await import("teleproto/network/index.js");
  const session = new teleproto.sessions.StringSession(input.storedSession);
  const client = new teleproto.TelegramClient(session, input.apiId, input.apiHash, {
    autoReconnect: true,
    connectionRetries: 5,
    reconnectRetries: 20,
    requestRetries: 5,
    sequentialUpdates: true,
    baseLogger: new Logger(LogLevel.NONE),
    deviceModel: "ChatKJB Terminal",
    appVersion: "0.1.0",
    langCode: "ko",
    systemLangCode: "ko"
  });

  return {
    async connect() {
      await client.connect();
    },
    checkAuthorization: () => client.checkAuthorization(),
    async signInWithQrCode(callbacks) {
      const user = await client.signInUserWithQrCode(
        { apiId: input.apiId, apiHash: input.apiHash },
        {
          abortSignal: callbacks.signal,
          qrCode: async ({ token, expires }) => callbacks.onQrCode(token, expires * 1000),
          password: callbacks.onPassword,
          onError: callbacks.onError
        }
      );
      return { id: stringId(user.id), bot: "bot" in user && user.bot === true };
    },
    async getMe() {
      const user = await client.getMe();
      return { id: stringId(user.id), bot: user.bot === true };
    },
    saveSession: () => session.save(),
    async resolveForumPeer(chatId) {
      for await (const dialog of client.iterDialogs({})) {
        if (stringId(dialog.id) !== String(chatId) || !dialog.entity) continue;
        const entity = dialog.entity;
        if (entity.className !== "Channel") break;
        return {
          peer: await client.getInputEntity(entity),
          forum: entity.forum === true,
          megagroup: entity.megagroup === true
        };
      }
      throw new Error("Configured Telegram forum is not visible to the user account");
    },
    getForumTopics: (peer, cursor, limit) => client.invoke(new teleproto.Api.messages.GetForumTopics({
      peer: peer as never,
      offsetDate: cursor.offsetDate,
      offsetId: cursor.offsetId,
      offsetTopic: cursor.offsetTopic,
      limit
    })),
    getGeneralHistory: (peer, cursor, limit) => client.invoke(new teleproto.Api.messages.GetHistory({
      peer: peer as never,
      offsetId: cursor.offsetId,
      offsetDate: cursor.offsetDate,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: returnBigInt(0)
    })),
    getTopicHistory: (peer, topicId, cursor, limit) => client.invoke(new teleproto.Api.messages.GetReplies({
      peer: peer as never,
      msgId: topicId,
      offsetId: cursor.offsetId,
      offsetDate: cursor.offsetDate,
      addOffset: 0,
      limit,
      maxId: 0,
      minId: 0,
      hash: returnBigInt(0)
    })),
    async sendText(peer, request) {
      const replyTo = request.replyToMessageId === undefined
        ? undefined
        : new teleproto.Api.InputReplyToMessage({
            replyToMsgId: request.replyToMessageId,
            ...(request.topMessageId !== undefined ? { topMsgId: request.topMessageId } : {})
          });
      return await client.invoke(new teleproto.Api.messages.SendMessage({
        peer: peer as never,
        message: request.text,
        randomId: generateRandomLong(),
        ...(replyTo ? { replyTo } : {})
      }));
    },
    async sendFile(peer, request) {
      const file = new teleproto.client.uploads.CustomFile(
        request.name,
        request.bytes.byteLength,
        "",
        Buffer.from(request.bytes)
      );
      await client.sendFile(peer as never, {
        file,
        ...(request.caption !== undefined ? { caption: request.caption } : {}),
        forceDocument: request.forceDocument,
        ...(request.replyToMessageId !== undefined ? { replyTo: request.replyToMessageId } : {}),
        ...(request.topMessageId !== undefined ? { topMsgId: request.topMessageId } : {})
      });
    },
    async downloadMedia(message, maxBytes, signal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let oversized = false;
      let result: string | Buffer | undefined;
      try {
        result = await client.downloadMedia(message as never, {
          signal: controller.signal,
          requestTimeout: TELEGRAM_MEDIA_REQUEST_TIMEOUT_MS,
          progressCallback(downloaded, fullSize) {
            const current = BigInt(downloaded.toString());
            const total = BigInt(fullSize.toString());
            if (current > BigInt(maxBytes) || total > BigInt(maxBytes)) {
              oversized = true;
              controller.abort();
            }
          }
        });
      } catch (error) {
        if (oversized) throw new Error("Telegram attachment exceeds the download limit");
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (
        oversized
        || !Buffer.isBuffer(result)
        || result.byteLength < 1
        || result.byteLength > maxBytes
      ) throw new Error("Telegram attachment download is invalid or too large");
      return Uint8Array.from(result);
    },
    pressCallback: (peer, messageId, data) => client.invoke(new teleproto.Api.messages.GetBotCallbackAnswer({
      peer: peer as never,
      msgId: messageId,
      data: Buffer.from(data)
    })),
    async markGeneralRead(peer, maxMessageId) {
      await client.invoke(new teleproto.Api.channels.ReadHistory({
        channel: peer as never,
        maxId: maxMessageId
      }));
    },
    async markTopicRead(peer, topicId, maxMessageId) {
      await client.invoke(new teleproto.Api.messages.ReadDiscussion({
        peer: peer as never,
        msgId: topicId,
        readMaxId: maxMessageId
      }));
    },
    async setTyping(peer, topicId, active) {
      await client.invoke(new teleproto.Api.messages.SetTyping({
        peer: peer as never,
        ...(topicId !== GENERAL_TOPIC_ID ? { topMsgId: topicId } : {}),
        action: active
          ? new teleproto.Api.SendMessageTypingAction()
          : new teleproto.Api.SendMessageCancelAction()
      }));
    },
    addRawUpdateHandler(handler) {
      client.addEventHandler((update) => {
        if (update instanceof UpdateConnectionState) {
          if (update.state === UpdateConnectionState.connected) {
            handler({ className: "ChatKjbConnectionRestored" });
          }
          return;
        }
        handler(update);
      }, new teleproto.events.Raw({ types: [
        teleproto.Api.UpdateNewChannelMessage,
        teleproto.Api.UpdateEditChannelMessage,
        teleproto.Api.UpdateDeleteChannelMessages,
        teleproto.Api.UpdateChannelTooLong,
        UpdateConnectionState
      ] }));
    },
    catchUp: () => client.catchUp(),
    async logOut() {
      return await client.logOut();
    },
    disconnect: () => client.disconnect()
  };
}
