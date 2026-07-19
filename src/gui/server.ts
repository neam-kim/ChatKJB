import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rename, rm, statfs } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GUI_ALLOWED_ATTACHMENT_MIME_TYPES,
  GUI_MAX_ATTACHMENT_BYTES,
  GENERAL_TOPIC_ID,
  normalizeGuiReplyPanel,
  safeHttpUrl,
  type GuiAttachment,
  type GuiAuthState,
  type GuiButton,
  type GuiMessage,
  type GuiPublicAuthState,
  type GuiReplyPanel,
  type GuiServerEvent,
  type GuiTelegramUpdate,
  type GuiTextEntity,
  type GuiTopic,
  type HistoryCursor,
  type TopicCursor
} from "./protocol.js";
import {
  HistoryInvalidatedError,
  ReadConfirmationPendingError,
  validateTelegramUploadMetadata,
  type MessagePage,
  type TelegramAttachmentDownload,
  type TelegramUploadInput,
  type TopicPage
} from "./telegram-user-client.js";

export const GUI_MAX_JSON_BYTES = 16 * 1024;
export const GUI_MAX_SSE_CONNECTIONS = 2;
export const GUI_SSE_JOURNAL_EVENTS = 512;
export const GUI_SSE_JOURNAL_BYTES = 1024 * 1024;
export const GUI_DEFAULT_PAGE_LIMIT = 50;
export const GUI_MAX_PAGE_LIMIT = 100;
export const GUI_MAX_ATTACHMENT_DOWNLOADS = 2;
export const GUI_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;
export const GUI_STANDARD_UPLOAD_BYTES = 4_000 * 512 * 1024;
export const GUI_PREMIUM_UPLOAD_BYTES = 8_000 * 512 * 1024;

const CAPABILITY_TTL_MS = 60_000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const CURSOR_TTL_MS = 15 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_REQUESTS = 240;
const RATE_MUTATIONS = 120;
// 읽음·입력중 표시처럼 화면 조작으로 자동 발생하는 요청의 별도 예산.
const RATE_BACKGROUND = 600;
const MAX_IN_FLIGHT_MUTATIONS = 8;
// Telegram 호출이 끝내 응답하지 않아도 이 시간이 지나면 동시 실행 슬롯을 반환한다.
// 이 상한이 없으면 멈춘 호출이 슬롯을 영구히 붙잡아, MAX_IN_FLIGHT_MUTATIONS번
// 누적되는 순간부터 앱을 다시 켜기 전까지 모든 전송이 MUTATION_RATE_LIMITED로 막힌다.
const MUTATION_TIMEOUT_MS = 30_000;
const ORDINARY_BODY_INACTIVITY_MS = 30_000;
const ORDINARY_BODY_ABSOLUTE_MS = 2 * 60_000;
const UPLOAD_BODY_INACTIVITY_MS = 60_000;
const UPLOAD_BODY_ABSOLUTE_MS = 30 * 60_000;
const UPLOAD_PROGRESS_INACTIVITY_MS = 10 * 60_000;
const UPLOAD_OPERATION_ABSOLUTE_MS = 24 * 60 * 60_000;
const UPLOAD_STORAGE_HEADROOM_BYTES = 256n * 1024n * 1024n;
const UPLOAD_ROOT_PREFIX = "chatkjb-gui-uploads-";
const INITIALIZATION_ORPHAN_AGE_MS = 24 * 60 * 60_000;

export function hasUploadStorageHeadroom(availableBytes: bigint, declaredBytes: number): boolean {
  return availableBytes >= 0n
    && Number.isSafeInteger(declaredBytes)
    && declaredBytes >= 1
    && availableBytes >= BigInt(declaredBytes) + UPLOAD_STORAGE_HEADROOM_BYTES;
}
const MAX_URL_BYTES = 2_048;
const HEARTBEAT_MS = 15_000;
const PUBLIC_AUTH_STATES = new Set<GuiAuthState["state"]>([
  "signed_out",
  "connecting",
  "waiting_qr",
  "waiting_password",
  "ready",
  "reconnecting",
  "error"
]);
const ATTACHMENT_MIME_TYPES = new Set<string>(GUI_ALLOWED_ATTACHMENT_MIME_TYPES);
const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const WEB_ASSETS = new Map<string, { body: Buffer; contentType: string; }>([
  ["/", { body: readFileSync(new URL("./web/index.html", import.meta.url)), contentType: "text/html; charset=utf-8" }],
  ["/assets/styles.css", { body: readFileSync(new URL("./web/styles.css", import.meta.url)), contentType: "text/css; charset=utf-8" }],
  ["/assets/app.js", { body: readFileSync(new URL("./web/app.js", import.meta.url)), contentType: "text/javascript; charset=utf-8" }],
  ["/manifest.webmanifest", { body: readFileSync(new URL("./web/manifest.webmanifest", import.meta.url)), contentType: "application/manifest+json; charset=utf-8" }]
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'"
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
} as const;

export interface GuiServerClient {
  beginQrLogin(): Promise<void>;
  submitPassword(password: string): void;
  cancelLogin(): void;
  listTopics(cursor?: TopicCursor, limit?: number): Promise<TopicPage>;
  listMessages(topicId: number, cursor?: HistoryCursor, limit?: number): Promise<MessagePage>;
  findGeneralReplyPanel(): Promise<GuiReplyPanel | null>;
  sendText(topicId: number, text: string): Promise<void>;
  sendFile(topicId: number, input: TelegramUploadInput): Promise<void>;
  uploadLimitBytes?(): number;
  downloadAttachment(token: string, signal?: AbortSignal): Promise<TelegramAttachmentDownload>;
  pressCallback(messageId: number, callbackData: string): Promise<unknown>;
  markRead(topicId: number, maxMessageId: number): Promise<void>;
  setTyping(topicId: number, active: boolean): Promise<void>;
  logOut(): Promise<void>;
}

export interface GuiServerDiagnostic {
  type: "request_rejected" | "upstream_failure" | "slow_sse_client";
  code: string;
}

export interface GuiServerOptions {
  client: GuiServerClient;
  now?: () => number;
  capabilityTtlMs?: number;
  rateLimit?: {
    windowMs: number;
    requests: number;
    mutations: number;
    // 읽음·입력중 표시 등 자동 발생 요청의 별도 예산.
    background?: number;
  };
  // Telegram 호출이 응답하지 않을 때 동시 실행 슬롯을 되돌려주는 상한.
  mutationTimeoutMs?: number;
  timeoutOverrides?: Partial<{
    ordinaryBodyInactivityMs: number;
    ordinaryBodyAbsoluteMs: number;
    uploadBodyInactivityMs: number;
    uploadBodyAbsoluteMs: number;
    uploadProgressInactivityMs: number;
    uploadOperationAbsoluteMs: number;
  }>;
  onDiagnostic?: (diagnostic: GuiServerDiagnostic) => void;
}

export interface GuiServerHandle {
  origin: string;
  takeBootstrapUrl(): string;
  publishAuthState(state: GuiAuthState): void;
  publishUpdate(update: GuiTelegramUpdate): void;
  close(): Promise<void>;
}

interface JournalEvent {
  id: string;
  sequence: number;
  frame: string;
  bytes: number;
}

interface CursorEnvelope {
  kind: "topics" | "messages";
  topicId?: number;
  cursor: TopicCursor | HistoryCursor;
  expiresAt: number;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(code);
    this.name = "HttpFailure";
  }
}

function pageFailure(error: unknown): never {
  if (error instanceof HistoryInvalidatedError) {
    throw new HttpFailure(409, "HISTORY_INVALIDATED");
  }
  throw new HttpFailure(502, "TELEGRAM_OPERATION_FAILED");
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const target = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === target) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function singleHeader(request: IncomingMessage, name: string, required = true): string | null {
  const values = rawHeaderValues(request, name);
  if (values.length === 0 && !required) return null;
  if (values.length !== 1 || values[0] === "") {
    throw new HttpFailure(400, `INVALID_${name.toUpperCase().replaceAll("-", "_")}`);
  }
  return values[0] ?? null;
}

function writeResponse(
  response: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": String(bytes(body)),
    ...headers
  });
  response.end(body);
}

function writeJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  writeResponse(response, status, JSON.stringify(value), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
}

function writeNoContent(response: ServerResponse, headers: Record<string, string> = {}): void {
  response.writeHead(204, { ...SECURITY_HEADERS, ...headers });
  response.end();
}

function writeBinary(
  response: ServerResponse,
  status: number,
  body: Uint8Array,
  headers: Record<string, string>
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Length": String(body.byteLength),
    ...headers
  });
  response.end(Buffer.from(body));
}

function writeFailure(response: ServerResponse, failure: HttpFailure): void {
  writeJson(response, failure.status, { error: { code: failure.code } }, failure.headers);
}

function positiveInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new HttpFailure(400, code);
  }
  return value;
}

function nonnegativeInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpFailure(400, code);
  }
  return value;
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpFailure(400, code);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new HttpFailure(400, code);
  return record;
}

function assertNoContentEncoding(request: IncomingMessage): void {
  if (rawHeaderValues(request, "content-encoding").length > 0) {
    throw new HttpFailure(415, "CONTENT_ENCODING_NOT_ALLOWED");
  }
}

async function readBody(
  request: IncomingMessage,
  limit: number,
  timeouts: { inactivityMs: number; absoluteMs: number; } = {
    inactivityMs: ORDINARY_BODY_INACTIVITY_MS,
    absoluteMs: ORDINARY_BODY_ABSOLUTE_MS
  }
): Promise<Buffer> {
  assertNoContentEncoding(request);
  const contentLength = singleHeader(request, "content-length", false);
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > limit) {
      throw new HttpFailure(413, "BODY_TOO_LARGE");
    }
  }
  return await new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let inactivityTimer: ReturnType<typeof setTimeout>;
    const absoluteTimer = setTimeout(
      () => fail(new HttpFailure(408, "REQUEST_BODY_TIMEOUT", { Connection: "close" })),
      timeouts.absoluteMs
    );
    const cleanup = () => {
      clearTimeout(inactivityTimer);
      clearTimeout(absoluteTimer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.pause();
      rejectBody(error);
    };
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(
        () => fail(new HttpFailure(408, "REQUEST_BODY_TIMEOUT", { Connection: "close" })),
        timeouts.inactivityMs
      );
    };
    const onData = (value: Buffer | Uint8Array | string) => {
      resetInactivity();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > limit) {
        fail(new HttpFailure(413, "BODY_TOO_LARGE", { Connection: "close" }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBody(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new HttpFailure(400, "REQUEST_BODY_ABORTED"));
    const onError = (error: Error) => fail(error);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    resetInactivity();
  });
}

async function readJson(
  request: IncomingMessage,
  timeouts?: { inactivityMs: number; absoluteMs: number; }
): Promise<Record<string, unknown>> {
  const contentType = singleHeader(request, "content-type");
  if (contentType !== "application/json") throw new HttpFailure(415, "JSON_CONTENT_TYPE_REQUIRED");
  const body = await readBody(request, GUI_MAX_JSON_BYTES, timeouts);
  if (body.length === 0) throw new HttpFailure(400, "JSON_BODY_REQUIRED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpFailure(400, "INVALID_JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpFailure(400, "INVALID_JSON_OBJECT");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonObject(body: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return exactObject(body, keys, "INVALID_JSON_FIELDS");
}

function assertQuery(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpFailure(400, "INVALID_QUERY");
    }
  }
}

function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return GUI_DEFAULT_PAGE_LIMIT;
  if (!/^\d{1,3}$/.test(raw)) throw new HttpFailure(400, "INVALID_PAGE_LIMIT");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > GUI_MAX_PAGE_LIMIT) {
    throw new HttpFailure(400, "INVALID_PAGE_LIMIT");
  }
  return value;
}

function publicAuthState(state: GuiAuthState): GuiPublicAuthState {
  const publicState = PUBLIC_AUTH_STATES.has(state.state) ? state.state : "error";
  const errorCode = typeof state.errorCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(state.errorCode)
    ? state.errorCode
    : undefined;
  return {
    state: publicState,
    ...(errorCode ? { errorCode } : {})
  };
}

function publicButton(button: GuiButton): GuiButton | null {
  const text = typeof button.text === "string" ? button.text.slice(0, 256) : "";
  if (button.kind === "url" && typeof button.url === "string") {
    const url = safeHttpUrl(button.url);
    return url ? { kind: "url", text, url } : null;
  }
  if (button.kind !== "callback" || typeof button.callbackData !== "string") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(button.callbackData)) return null;
  const decoded = Buffer.from(button.callbackData, "base64url");
  if (
    decoded.length < 1
    || decoded.length > 64
    || decoded.toString("base64url") !== button.callbackData
    || button.requiresPassword === true
  ) return null;
  return { kind: "callback", text, callbackData: button.callbackData };
}

function publicTextEntity(entity: GuiTextEntity, textLength: number): GuiTextEntity | null {
  if (
    !entity
    || !["code", "pre", "url"].includes(entity.kind)
    || !Number.isSafeInteger(entity.offset)
    || !Number.isSafeInteger(entity.length)
    || entity.offset < 0
    || entity.length <= 0
    || entity.offset + entity.length > textLength
  ) return null;
  if (entity.kind === "pre") {
    const language = typeof entity.language === "string" && /^[A-Za-z0-9_+.-]{0,32}$/.test(entity.language)
      ? entity.language
      : "";
    return { kind: "pre", offset: entity.offset, length: entity.length, ...(language ? { language } : {}) };
  }
  if (entity.kind === "url") {
    const url = typeof entity.url === "string" ? safeHttpUrl(entity.url) : null;
    return url ? { kind: "url", offset: entity.offset, length: entity.length, url } : null;
  }
  return { kind: "code", offset: entity.offset, length: entity.length };
}

function publicAttachment(attachment: GuiAttachment): GuiAttachment | null {
  if (
    !attachment
    || !["image", "document"].includes(attachment.kind)
    || typeof attachment.name !== "string"
    || Buffer.byteLength(attachment.name, "utf8") < 1
    || Buffer.byteLength(attachment.name, "utf8") > 255
    || /[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(attachment.name)
    || !["telegram", "sanitized", "generated"].includes(attachment.filenameSource)
    || typeof attachment.mimeType !== "string"
    || !ATTACHMENT_MIME_TYPES.has(attachment.mimeType)
    || !Number.isSafeInteger(attachment.size)
    || attachment.size < 1
    || (attachment.token !== undefined && (
      attachment.size > GUI_MAX_ATTACHMENT_BYTES
      || typeof attachment.token !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(attachment.token)
    ))
    || (attachment.kind === "image" && !INLINE_IMAGE_MIME_TYPES.has(attachment.mimeType))
  ) return null;
  const width = Number.isSafeInteger(attachment.width) && Number(attachment.width) > 0
    ? Number(attachment.width)
    : undefined;
  const height = Number.isSafeInteger(attachment.height) && Number(attachment.height) > 0
    ? Number(attachment.height)
    : undefined;
  return {
    kind: attachment.kind,
    name: attachment.name,
    filenameSource: attachment.filenameSource,
    mimeType: attachment.mimeType,
    size: attachment.size,
    ...(attachment.token ? { token: attachment.token } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {})
  };
}

function publicMessage(message: GuiMessage): GuiMessage {
  const id = positiveInteger(message.id, "INVALID_UPSTREAM_MESSAGE");
  const topicId = positiveInteger(message.topicId, "INVALID_UPSTREAM_MESSAGE");
  const sentAt = nonnegativeInteger(message.sentAt, "INVALID_UPSTREAM_MESSAGE");
  const editedAt = message.editedAt === null
    ? null
    : nonnegativeInteger(message.editedAt, "INVALID_UPSTREAM_MESSAGE");
  const buttons = Array.isArray(message.buttons)
    ? message.buttons.slice(0, 100).map((row) => Array.isArray(row)
      ? row.slice(0, 8).flatMap((button) => {
          const projected = publicButton(button);
          return projected ? [projected] : [];
        })
      : []).filter((row) => row.length > 0)
    : [];
  const text = typeof message.text === "string" ? message.text.slice(0, 4_096) : "";
  const entities = Array.isArray(message.entities) && message.entities.length <= 256
    ? message.entities.flatMap((entity) => {
        const projected = publicTextEntity(entity, text.length);
        return projected ? [projected] : [];
      }).sort((left, right) => left.offset - right.offset || left.length - right.length)
    : [];
  const nonOverlappingEntities: GuiTextEntity[] = [];
  for (const entity of entities) {
    const previous = nonOverlappingEntities.at(-1);
    if (!previous || entity.offset >= previous.offset + previous.length) nonOverlappingEntities.push(entity);
  }
  const attachment = message.attachment ? publicAttachment(message.attachment) : null;
  const replyPanel = topicId === GENERAL_TOPIC_ID
    ? normalizeGuiReplyPanel(message.replyPanel)
    : null;
  const matchingReplyPanel = replyPanel?.messageId === id ? replyPanel : null;
  return {
    id,
    topicId,
    text,
    sentAt,
    editedAt,
    outgoing: message.outgoing === true,
    buttons,
    ...(matchingReplyPanel ? { replyPanel: matchingReplyPanel } : {}),
    ...(nonOverlappingEntities.length > 0 ? { entities: nonOverlappingEntities } : {}),
    ...(attachment ? { attachment } : {})
  };
}

function publicTopic(topic: GuiTopic): GuiTopic {
  return {
    id: positiveInteger(topic.id, "INVALID_UPSTREAM_TOPIC"),
    title: typeof topic.title === "string" ? topic.title.slice(0, 256) : "",
    topMessageId: positiveInteger(topic.topMessageId, "INVALID_UPSTREAM_TOPIC"),
    unreadCount: nonnegativeInteger(topic.unreadCount, "INVALID_UPSTREAM_TOPIC"),
    pinned: topic.pinned === true,
    closed: topic.closed === true,
    hidden: topic.hidden === true
  };
}

function projectUpdate(update: GuiTelegramUpdate): GuiServerEvent {
  switch (update.type) {
    case "message_upsert":
      return { type: "message_upsert", message: publicMessage(update.message) };
    case "message_delete":
      return {
        type: "message_delete",
        topicId: positiveInteger(update.topicId, "INVALID_UPSTREAM_UPDATE"),
        messageIds: update.messageIds.slice(0, 1_000)
          .map((id) => positiveInteger(id, "INVALID_UPSTREAM_UPDATE"))
      };
    case "topic_delete":
      return { type: "topic_delete", topicId: positiveInteger(update.topicId, "INVALID_UPSTREAM_UPDATE") };
    case "reconcile_required":
      return { type: "reconcile_required" };
  }
}

function decodeBase64UrlUtf8(value: string, code: string): string {
  if (value.length === 0 || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpFailure(400, code);
  }
  const buffer = Buffer.from(value, "base64url");
  if (buffer.toString("base64url") !== value) throw new HttpFailure(400, code);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new HttpFailure(400, code);
  }
}

function encodedContentDisposition(kind: "inline" | "attachment", filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind}; filename*=UTF-8''${encoded}`;
}

function parseCookie(request: IncomingMessage, cookieName: string): string | null {
  const header = singleHeader(request, "cookie", false);
  if (header === null) return null;
  const matches = header.split(";").map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && part.slice(0, separator) === cookieName;
  });
  if (matches.length !== 1) return null;
  return matches[0]?.slice(matches[0].indexOf("=") + 1) ?? null;
}

function encodeCursor(envelope: CursorEnvelope, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  token: string,
  key: Buffer,
  kind: CursorEnvelope["kind"],
  topicId: number | undefined,
  now: number
): TopicCursor | HistoryCursor {
  if (token.length === 0 || token.length > 1_024) throw new HttpFailure(400, "INVALID_CURSOR");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new HttpFailure(400, "INVALID_CURSOR");
  const signature = createHmac("sha256", key).update(parts[0]).digest("base64url");
  if (!constantTimeEqual(parts[1], signature)) throw new HttpFailure(400, "INVALID_CURSOR");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new HttpFailure(400, "INVALID_CURSOR");
  }
  const record = exactObject(parsed, ["kind", "topicId", "cursor", "expiresAt"], "INVALID_CURSOR");
  if (record["kind"] !== kind || nonnegativeInteger(record["expiresAt"], "INVALID_CURSOR") < now) {
    throw new HttpFailure(400, "INVALID_CURSOR");
  }
  if (kind === "messages" && record["topicId"] !== topicId) throw new HttpFailure(400, "INVALID_CURSOR");
  if (kind === "topics" && record["topicId"] !== undefined) throw new HttpFailure(400, "INVALID_CURSOR");
  const cursor = kind === "topics"
    ? exactObject(record["cursor"], ["offsetDate", "offsetId", "offsetTopic"], "INVALID_CURSOR")
    : exactObject(record["cursor"], ["offsetId", "offsetDate"], "INVALID_CURSOR");
  if (kind === "topics") {
    return {
      offsetDate: nonnegativeInteger(cursor["offsetDate"], "INVALID_CURSOR"),
      offsetId: nonnegativeInteger(cursor["offsetId"], "INVALID_CURSOR"),
      offsetTopic: nonnegativeInteger(cursor["offsetTopic"], "INVALID_CURSOR")
    };
  }
  return {
    offsetId: nonnegativeInteger(cursor["offsetId"], "INVALID_CURSOR"),
    offsetDate: nonnegativeInteger(cursor["offsetDate"], "INVALID_CURSOR")
  };
}

function requestMethod(request: IncomingMessage): string {
  if (rawHeaderValues(request, "x-http-method-override").length > 0) {
    throw new HttpFailure(400, "METHOD_OVERRIDE_NOT_ALLOWED");
  }
  return request.method ?? "";
}

function methodAllowed(method: string, allowed: readonly string[]): void {
  if (allowed.includes(method)) return;
  throw new HttpFailure(405, "METHOD_NOT_ALLOWED", { Allow: allowed.join(", ") });
}

interface UploadOwnerMarker {
  version: 1;
  pid: number;
  startedAt: number;
}

function strictUploadOwner(value: unknown): UploadOwnerMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "pid,startedAt,version") return null;
  if (
    record["version"] !== 1
    || typeof record["pid"] !== "number"
    || !Number.isSafeInteger(record["pid"])
    || record["pid"] <= 0
    || typeof record["startedAt"] !== "number"
    || !Number.isSafeInteger(record["startedAt"])
    || record["startedAt"] <= 0
  ) return null;
  return { version: 1, pid: record["pid"], startedAt: record["startedAt"] };
}

function processIsDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function sweepUploadRoots(baseDirectory: string, timestamp: number): Promise<void> {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid)) return;
  let entries;
  try {
    entries = await readdir(baseDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(UPLOAD_ROOT_PREFIX)) continue;
    if (!/^chatkjb-gui-uploads-\d+-[A-Za-z0-9_-]{6,64}$/.test(entry.name)) continue;
    const candidate = join(baseDirectory, entry.name);
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink() || candidateStat.uid !== uid) continue;
      const children = await readdir(candidate);
      if (!children.includes("owner.json")) {
        if (
          timestamp - candidateStat.mtimeMs >= INITIALIZATION_ORPHAN_AGE_MS
          && (children.length === 0 || (children.length === 1 && children[0] === ".owner.tmp"))
        ) await rm(candidate, { recursive: true, force: true });
        continue;
      }
      if (children.some((name) => name === ".owner.tmp")) continue;
      const markerPath = join(candidate, "owner.json");
      const markerStat = await lstat(markerPath);
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== uid || markerStat.size > 1_024) continue;
      const marker = strictUploadOwner(JSON.parse(await readFile(markerPath, "utf8")));
      if (!marker || !processIsDefinitelyDead(marker.pid)) continue;
      await rm(candidate, { recursive: true, force: true });
    } catch {
      // Any malformed, foreign, racy, or inaccessible candidate is preserved fail-closed.
    }
  }
}

async function createUploadRunRoot(): Promise<string> {
  const baseDirectory = tmpdir();
  await sweepUploadRoots(baseDirectory, Date.now());
  const root = await mkdtemp(join(baseDirectory, `${UPLOAD_ROOT_PREFIX}${process.pid}-`));
  await chmod(root, 0o700);
  const temporaryMarker = join(root, ".owner.tmp");
  const finalMarker = join(root, "owner.json");
  let markerHandle;
  try {
    markerHandle = await open(temporaryMarker, "wx", 0o600);
    await markerHandle.writeFile(JSON.stringify({ version: 1, pid: process.pid, startedAt: Date.now() }));
    await markerHandle.sync();
    await markerHandle.close();
    markerHandle = undefined;
    await rename(temporaryMarker, finalMarker);
    const directoryHandle = await open(root, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return root;
  } catch (error) {
    await markerHandle?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function startGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const now = options.now ?? Date.now;
  const capabilityTtlMs = options.capabilityTtlMs ?? CAPABILITY_TTL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs < 1_000 || capabilityTtlMs > 300_000) {
    throw new Error("capabilityTtlMs must be an integer from 1000 to 300000");
  }
  const rateWindow = options.rateLimit?.windowMs ?? RATE_WINDOW_MS;
  const rateRequests = options.rateLimit?.requests ?? RATE_REQUESTS;
  const rateMutations = options.rateLimit?.mutations ?? RATE_MUTATIONS;
  const rateBackground = options.rateLimit?.background ?? RATE_BACKGROUND;
  const mutationTimeoutMs = options.mutationTimeoutMs ?? MUTATION_TIMEOUT_MS;
  const timeoutValue = (key: keyof NonNullable<GuiServerOptions["timeoutOverrides"]>, fallback: number) => {
    const value = options.timeoutOverrides?.[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 10 || value > 7 * 24 * 60 * 60_000) {
      throw new Error(`${key} must be an integer from 10ms to 7 days`);
    }
    return value;
  };
  const ordinaryTimeouts = {
    inactivityMs: timeoutValue("ordinaryBodyInactivityMs", ORDINARY_BODY_INACTIVITY_MS),
    absoluteMs: timeoutValue("ordinaryBodyAbsoluteMs", ORDINARY_BODY_ABSOLUTE_MS)
  };
  const uploadBodyInactivityMs = timeoutValue("uploadBodyInactivityMs", UPLOAD_BODY_INACTIVITY_MS);
  const uploadBodyAbsoluteMs = timeoutValue("uploadBodyAbsoluteMs", UPLOAD_BODY_ABSOLUTE_MS);
  const uploadProgressInactivityMs = timeoutValue("uploadProgressInactivityMs", UPLOAD_PROGRESS_INACTIVITY_MS);
  const uploadOperationAbsoluteMs = timeoutValue("uploadOperationAbsoluteMs", UPLOAD_OPERATION_ABSOLUTE_MS);
  if (
    ordinaryTimeouts.absoluteMs < ordinaryTimeouts.inactivityMs
    || uploadBodyAbsoluteMs < uploadBodyInactivityMs
    || uploadOperationAbsoluteMs < uploadProgressInactivityMs
  ) throw new Error("absolute timeouts must not be shorter than their inactivity timeout");
  if (
    !Number.isSafeInteger(mutationTimeoutMs)
    || mutationTimeoutMs < 1_000
    || mutationTimeoutMs > 300_000
  ) {
    throw new Error("mutationTimeoutMs must be an integer from 1000 to 300000");
  }
  for (const [value, label] of [
    [rateWindow, "rate window"],
    [rateRequests, "request rate"],
    [rateMutations, "mutation rate"]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  }
  const uploadRunRoot = await createUploadRunRoot();

  let capability: string | null = randomBytes(32).toString("base64url");
  const capabilityExpiresAt = now() + capabilityTtlMs;
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const cursorKey = randomBytes(32);
  const epoch = randomBytes(12).toString("base64url");
  const cookieName = `chatkjb_gui_${randomBytes(8).toString("hex")}`;
  let sessionActive = false;
  let sessionExpiresAt = 0;
  let origin = "";
  let expectedHost = "";
  let sequence = 0;
  let journalBytes = 0;
  let auth: GuiPublicAuthState = { state: "signed_out" };
  let transport: "online" | "connecting" | "offline" = "offline";
  let inFlightMutations = 0;
  let inFlightDownloads = 0;
  let uploadInFlight = false;
  let closeTask: Promise<void> | null = null;
  const journal: JournalEvent[] = [];
  const streams = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const activeUploadDirs = new Set<string>();
  const activeUploadControllers = new Set<AbortController>();
  const activeUploadSettlements = new Set<Promise<void>>();
  const activeDownloadControllers = new Set<AbortController>();
  const requestTimes: number[] = [];
  const mutationTimes: number[] = [];
  const backgroundTimes: number[] = [];

  function currentEventId(): string {
    return `${epoch}:${sequence}`;
  }

  function diagnostic(type: GuiServerDiagnostic["type"], code: string): void {
    options.onDiagnostic?.({ type, code });
  }

  function expireWebSessionIfNeeded(): boolean {
    if (!sessionActive || now() < sessionExpiresAt) return false;
    sessionActive = false;
    for (const stream of streams) stream.end();
    streams.clear();
    for (const controller of activeDownloadControllers) controller.abort();
    for (const controller of activeUploadControllers) {
      controller.abort(new HttpFailure(401, "SESSION_EXPIRED"));
    }
    return true;
  }

  function appendEvent(event: GuiServerEvent): void {
    if (expireWebSessionIfNeeded()) return;
    sequence += 1;
    const id = currentEventId();
    const data = JSON.stringify(event);
    const frame = `id: ${id}\nevent: update\ndata: ${data}\n\n`;
    const entry = { id, sequence, frame, bytes: bytes(frame) };
    journal.push(entry);
    journalBytes += entry.bytes;
    while (journal.length > GUI_SSE_JOURNAL_EVENTS || journalBytes > GUI_SSE_JOURNAL_BYTES) {
      journalBytes -= journal.shift()?.bytes ?? 0;
    }
    for (const stream of [...streams]) {
      if (!stream.write(frame)) {
        diagnostic("slow_sse_client", "SSE_BACKPRESSURE");
        streams.delete(stream);
        stream.end();
      }
    }
  }

  function assertHost(request: IncomingMessage): void {
    if (
      rawHeaderValues(request, "x-forwarded-host").length > 0
      || rawHeaderValues(request, "forwarded").length > 0
    ) throw new HttpFailure(421, "INVALID_HOST");
    const host = singleHeader(request, "host");
    if (host !== expectedHost) throw new HttpFailure(421, "INVALID_HOST");
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      throw new HttpFailure(403, "LOOPBACK_ONLY");
    }
  }

  function assertOrigin(request: IncomingMessage, required: boolean): void {
    const presentedOrigin = singleHeader(request, "origin", required);
    if (presentedOrigin !== null && presentedOrigin !== origin) {
      throw new HttpFailure(403, "INVALID_ORIGIN");
    }
    const fetchSite = singleHeader(request, "sec-fetch-site", false);
    if (fetchSite !== null && fetchSite !== "same-origin") throw new HttpFailure(403, "INVALID_FETCH_SITE");
  }

  function assertSession(request: IncomingMessage): void {
    const cookie = parseCookie(request, cookieName);
    expireWebSessionIfNeeded();
    if (!sessionActive || cookie === null || !constantTimeEqual(cookie, sessionToken)) {
      throw new HttpFailure(401, "SESSION_REQUIRED");
    }
  }

  function assertCsrf(request: IncomingMessage): void {
    const value = singleHeader(request, "x-chatkjb-csrf");
    if (value === null || !constantTimeEqual(value, csrfToken)) throw new HttpFailure(403, "INVALID_CSRF");
  }

  // 읽음 표시와 입력 중 표시는 화면이 스크롤되거나 메시지가 들어올 때마다 자동으로
  // 발생한다. 사용자가 직접 누른 전송과 같은 예산을 쓰면, 배경 트래픽이 예산을 모두
  // 소진해 정작 사용자의 전송이 MUTATION_RATE_LIMITED로 막힌다. 두 예산을 분리한다.
  function checkRate(mutation: boolean, background = false): void {
    const timestamp = now();
    while (requestTimes[0] !== undefined && requestTimes[0] <= timestamp - rateWindow) requestTimes.shift();
    if (requestTimes.length >= rateRequests) {
      diagnostic("request_rejected", "RATE_LIMITED");
      throw new HttpFailure(429, "RATE_LIMITED", { "Retry-After": String(Math.ceil(rateWindow / 1_000)) });
    }
    requestTimes.push(timestamp);
    if (!mutation) return;

    const times = background ? backgroundTimes : mutationTimes;
    const limit = background ? rateBackground : rateMutations;
    const code = background ? "BACKGROUND_RATE_LIMITED" : "MUTATION_RATE_LIMITED";
    while (times[0] !== undefined && times[0] <= timestamp - rateWindow) times.shift();
    if (times.length >= limit || inFlightMutations >= MAX_IN_FLIGHT_MUTATIONS) {
      diagnostic("request_rejected", code);
      throw new HttpFailure(429, code, { "Retry-After": String(Math.ceil(rateWindow / 1_000)) });
    }
    times.push(timestamp);
  }

  // 응답하지 않는 Telegram 호출이 슬롯을 영구히 붙잡지 않도록 시간 상한을 건다.
  // 상한을 넘기면 대기를 포기하고 슬롯을 반환한다. 원 호출은 계속 진행될 수 있으나
  // 그 결과를 기다리지는 않는다.
  async function withMutationTimeout(task: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        task(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new HttpFailure(504, "TELEGRAM_OPERATION_TIMEOUT")),
            mutationTimeoutMs
          );
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function mutation(task: () => Promise<void>, background = false): Promise<void> {
    checkRate(true, background);
    inFlightMutations += 1;
    try {
      await withMutationTimeout(task);
    } catch (error) {
      if (error instanceof HttpFailure) {
        if (error.code === "TELEGRAM_OPERATION_TIMEOUT") {
          diagnostic("upstream_failure", "TELEGRAM_OPERATION_TIMEOUT");
        }
        throw error;
      }
      if (error instanceof ReadConfirmationPendingError) {
        diagnostic("upstream_failure", "READ_CONFIRMATION_PENDING");
        throw new HttpFailure(503, "READ_CONFIRMATION_PENDING");
      }
      diagnostic("upstream_failure", "TELEGRAM_OPERATION_FAILED");
      throw new HttpFailure(502, "TELEGRAM_OPERATION_FAILED");
    } finally {
      inFlightMutations -= 1;
    }
  }

  function authenticateApi(request: IncomingMessage, method: string, csrf = true): void {
    assertOrigin(request, method !== "GET");
    assertSession(request);
    if (csrf) assertCsrf(request);
  }

  function currentUploadLimit(): number {
    const candidate = options.client.uploadLimitBytes?.() ?? GUI_STANDARD_UPLOAD_BYTES;
    return Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= GUI_PREMIUM_UPLOAD_BYTES
      ? candidate
      : GUI_STANDARD_UPLOAD_BYTES;
  }

  async function removeUploadDirectory(directory: string): Promise<void> {
    if (!activeUploadDirs.has(directory)) return;
    activeUploadDirs.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }

  async function streamUpload(
    request: IncomingMessage,
    controller: AbortController,
    limit: number
  ): Promise<{ directory: string; path: string; size: number; }> {
    assertNoContentEncoding(request);
    if (rawHeaderValues(request, "transfer-encoding").length > 0) {
      throw new HttpFailure(411, "CONTENT_LENGTH_REQUIRED");
    }
    const rawLength = singleHeader(request, "content-length");
    if (!rawLength || !/^\d+$/.test(rawLength)) throw new HttpFailure(411, "CONTENT_LENGTH_REQUIRED");
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 1 || declaredLength > limit) {
      throw new HttpFailure(413, "UPLOAD_SIZE_INVALID");
    }
    try {
      const storage = await statfs(uploadRunRoot, { bigint: true });
      const available = storage.bavail * storage.bsize;
      if (!hasUploadStorageHeadroom(available, declaredLength)) {
        throw new HttpFailure(507, "UPLOAD_STORAGE_EXHAUSTED");
      }
    } catch (error) {
      if (error instanceof HttpFailure) throw error;
      throw new HttpFailure(507, "UPLOAD_STORAGE_EXHAUSTED");
    }
    const directory = await mkdtemp(join(uploadRunRoot, "upload-"));
    activeUploadDirs.add(directory);
    await chmod(directory, 0o700);
    const path = join(directory, "payload");
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
      const uploadHandle = handle;
      const received = await new Promise<number>((resolveUpload, rejectUpload) => {
        let size = 0;
        let settled = false;
        let writeChain = Promise.resolve();
        let inactivityTimer: ReturnType<typeof setTimeout>;
        const absoluteTimer = setTimeout(
          () => controller.abort(new HttpFailure(408, "UPLOAD_BODY_TIMEOUT")),
          uploadBodyAbsoluteMs
        );
        const cleanup = () => {
          clearTimeout(inactivityTimer);
          clearTimeout(absoluteTimer);
          request.off("data", onData);
          request.off("end", onEnd);
          request.off("aborted", onRequestAborted);
          request.off("error", onRequestError);
          controller.signal.removeEventListener("abort", onSignalAbort);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          request.pause();
          rejectUpload(error);
        };
        const resetInactivity = () => {
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(
            () => controller.abort(new HttpFailure(408, "UPLOAD_BODY_TIMEOUT")),
            uploadBodyInactivityMs
          );
        };
        const writeChunk = async (chunk: Buffer) => {
          if (controller.signal.aborted) throw controller.signal.reason;
          size += chunk.length;
          if (size > declaredLength || size > limit) throw new HttpFailure(413, "UPLOAD_SIZE_INVALID");
          let offset = 0;
          while (offset < chunk.length) {
            const { bytesWritten } = await uploadHandle.write(chunk, offset, chunk.length - offset);
            if (bytesWritten < 1) throw new Error("Upload spool made no write progress");
            offset += bytesWritten;
          }
          if (controller.signal.aborted) throw controller.signal.reason;
        };
        const onData = (value: Buffer | Uint8Array | string) => {
          if (settled) return;
          request.pause();
          resetInactivity();
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          writeChain = writeChain.then(() => writeChunk(chunk));
          void writeChain.then(
            () => { if (!settled) request.resume(); },
            fail
          );
        };
        const onEnd = () => {
          clearTimeout(inactivityTimer);
          void writeChain.then(() => {
            if (settled) return;
            if (size !== declaredLength) throw new HttpFailure(400, "UPLOAD_SIZE_MISMATCH");
            settled = true;
            cleanup();
            resolveUpload(size);
          }).catch(fail);
        };
        const onRequestAborted = () => controller.abort(new HttpFailure(499, "UPLOAD_CANCELLED"));
        const onRequestError = (error: Error) => fail(error);
        const onSignalAbort = () => fail(controller.signal.reason ?? new HttpFailure(499, "UPLOAD_CANCELLED"));
        request.on("data", onData);
        request.once("end", onEnd);
        request.once("aborted", onRequestAborted);
        request.once("error", onRequestError);
        controller.signal.addEventListener("abort", onSignalAbort, { once: true });
        resetInactivity();
        if (controller.signal.aborted) onSignalAbort();
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      await handle.sync();
      if (controller.signal.aborted) throw controller.signal.reason;
      await handle.close();
      handle = undefined;
      return { directory, path, size: received };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await removeUploadDirectory(directory);
      if (error instanceof HttpFailure) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOSPC") {
        throw new HttpFailure(507, "UPLOAD_STORAGE_EXHAUSTED");
      }
      throw error;
    }
  }

  function cursorFromQuery(
    url: URL,
    kind: CursorEnvelope["kind"],
    topicId?: number
  ): TopicCursor | HistoryCursor | undefined {
    const token = url.searchParams.get("cursor");
    return token === null ? undefined : decodeCursor(token, cursorKey, kind, topicId, now());
  }

  function nextCursorToken(
    kind: CursorEnvelope["kind"],
    cursor: TopicCursor | HistoryCursor | null,
    topicId?: number
  ): string | null {
    if (!cursor) return null;
    return encodeCursor({
      kind,
      ...(topicId !== undefined ? { topicId } : {}),
      cursor,
      expiresAt: now() + CURSOR_TTL_MS
    }, cursorKey);
  }

  async function handleBootstrap(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    methodAllowed(requestMethod(request), ["GET"]);
    assertQuery(url, ["cap"]);
    const presented = url.searchParams.get("cap");
    if (
      capability === null
      || now() >= capabilityExpiresAt
      || presented === null
      || !constantTimeEqual(presented, capability)
    ) throw new HttpFailure(401, "INVALID_BOOTSTRAP_CAPABILITY");
    capability = null;
    sessionActive = true;
    sessionExpiresAt = now() + SESSION_TTL_SECONDS * 1_000;
    const cookie = `${cookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SECONDS}`;
    writeResponse(response, 303, "", { Location: "/", "Set-Cookie": cookie });
  }

  async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = requestMethod(request);
    if (url.pathname === "/api/session") {
      methodAllowed(method, ["GET"]);
      assertQuery(url, []);
      authenticateApi(request, method, false);
      checkRate(false);
      writeJson(response, 200, {
        connection: auth.state,
        csrfToken,
        eventEpoch: epoch,
        limits: {
          textCharacters: 4_096,
          jsonBytes: GUI_MAX_JSON_BYTES,
          uploadBytes: currentUploadLimit(),
          attachmentBytes: GUI_MAX_ATTACHMENT_BYTES,
          attachmentDownloads: GUI_MAX_ATTACHMENT_DOWNLOADS,
          page: GUI_MAX_PAGE_LIMIT,
          callbackBytes: 64,
          sseConnections: GUI_MAX_SSE_CONNECTIONS
        }
      });
      return;
    }

    authenticateApi(request, method, true);

    if (url.pathname === "/api/general-panel") {
      methodAllowed(method, ["GET"]);
      assertQuery(url, []);
      checkRate(false);
      const panel = await options.client.findGeneralReplyPanel().catch((error: unknown) => {
        if (!(error instanceof HistoryInvalidatedError)) {
          diagnostic("upstream_failure", "TELEGRAM_OPERATION_FAILED");
        }
        return pageFailure(error);
      });
      writeJson(response, 200, { panel: normalizeGuiReplyPanel(panel) });
      return;
    }

    if (url.pathname === "/api/auth/qr") {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const body = await readBody(request, 0, ordinaryTimeouts);
      if (body.length !== 0) throw new HttpFailure(400, "AUTH_BODY_NOT_ALLOWED");
      checkRate(true);
      void options.client.beginQrLogin().catch(() => {
        diagnostic("upstream_failure", "TELEGRAM_LOGIN_FAILED");
      });
      writeJson(response, 202, { accepted: true });
      return;
    }

    if (url.pathname === "/api/auth/password") {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const body = parseJsonObject(await readJson(request, ordinaryTimeouts), ["password"]);
      if (typeof body["password"] !== "string" || body["password"].length < 1 || body["password"].length > 512) {
        throw new HttpFailure(400, "INVALID_PASSWORD_INPUT");
      }
      await mutation(async () => options.client.submitPassword(body["password"] as string));
      writeNoContent(response);
      return;
    }

    if (url.pathname === "/api/auth/cancel") {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const body = await readBody(request, 0, ordinaryTimeouts);
      if (body.length !== 0) throw new HttpFailure(400, "AUTH_BODY_NOT_ALLOWED");
      await mutation(async () => options.client.cancelLogin());
      writeNoContent(response);
      return;
    }

    if (url.pathname === "/api/topics") {
      methodAllowed(method, ["GET"]);
      assertQuery(url, ["cursor", "limit"]);
      checkRate(false);
      const limit = pageLimit(url);
      const checkpointEventId = currentEventId();
      const page = await options.client.listTopics(
        cursorFromQuery(url, "topics") as TopicCursor | undefined,
        limit
      ).catch((error: unknown) => {
        if (!(error instanceof HistoryInvalidatedError)) {
          diagnostic("upstream_failure", "TELEGRAM_OPERATION_FAILED");
        }
        return pageFailure(error);
      });
      writeJson(response, 200, {
        topics: page.topics.slice(0, limit).map(publicTopic),
        nextCursor: nextCursorToken("topics", page.nextCursor),
        checkpointEventId
      });
      return;
    }

    const messagesMatch = url.pathname.match(/^\/api\/topics\/(\d+)\/messages$/);
    if (messagesMatch) {
      const topicId = positiveInteger(Number(messagesMatch[1]), "INVALID_TOPIC_ID");
      if (method === "GET") {
        assertQuery(url, ["cursor", "limit"]);
        checkRate(false);
        const limit = pageLimit(url);
        const checkpointEventId = currentEventId();
        const page = await options.client.listMessages(
          topicId,
          cursorFromQuery(url, "messages", topicId) as HistoryCursor | undefined,
          limit
        ).catch((error: unknown) => {
          if (!(error instanceof HistoryInvalidatedError)) {
            diagnostic("upstream_failure", "TELEGRAM_OPERATION_FAILED");
          }
          return pageFailure(error);
        });
        writeJson(response, 200, {
          messages: page.messages.slice(0, limit).map(publicMessage),
          nextCursor: nextCursorToken("messages", page.nextCursor, topicId),
          checkpointEventId
        });
        return;
      }
      methodAllowed(method, ["GET", "POST"]);
      assertQuery(url, []);
      const body = parseJsonObject(await readJson(request, ordinaryTimeouts), ["text"]);
      if (typeof body["text"] !== "string" || !body["text"].trim() || body["text"].length > 4_096) {
        throw new HttpFailure(400, "INVALID_MESSAGE_TEXT");
      }
      await mutation(() => options.client.sendText(topicId, body["text"] as string));
      writeNoContent(response);
      return;
    }

    const filesMatch = url.pathname.match(/^\/api\/topics\/(\d+)\/files$/);
    if (filesMatch) {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const topicId = positiveInteger(Number(filesMatch[1]), "INVALID_TOPIC_ID");
      const mimeType = singleHeader(request, "content-type");
      const encodedName = singleHeader(request, "x-chatkjb-file-name");
      const encodedCaption = singleHeader(request, "x-chatkjb-caption", false);
      const name = decodeBase64UrlUtf8(encodedName ?? "", "INVALID_UPLOAD_FILENAME");
      const caption = encodedCaption === null
        ? undefined
        : decodeBase64UrlUtf8(encodedCaption, "INVALID_UPLOAD_CAPTION");
      let metadata;
      try {
        metadata = validateTelegramUploadMetadata(name, mimeType, caption);
      } catch {
        throw new HttpFailure(400, "INVALID_UPLOAD_METADATA");
      }
      checkRate(true);
      if (uploadInFlight) {
        throw new HttpFailure(429, "UPLOAD_IN_PROGRESS", { "Retry-After": "1" });
      }
      if (inFlightMutations >= MAX_IN_FLIGHT_MUTATIONS) {
        throw new HttpFailure(429, "MUTATION_RATE_LIMITED", { "Retry-After": "1" });
      }
      uploadInFlight = true;
      inFlightMutations += 1;
      let resolveUploadSettlement: () => void = () => {};
      const uploadSettlement = new Promise<void>((resolveSettlement) => {
        resolveUploadSettlement = resolveSettlement;
      });
      activeUploadSettlements.add(uploadSettlement);
      const controller = new AbortController();
      activeUploadControllers.add(controller);
      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      const absoluteTimer = setTimeout(
        () => controller.abort(new HttpFailure(504, "UPLOAD_OPERATION_TIMEOUT")),
        uploadOperationAbsoluteMs
      );
      const abortForPeerClose = () => {
        if (!response.writableEnded) controller.abort(new HttpFailure(499, "UPLOAD_CANCELLED"));
      };
      response.once("close", abortForPeerClose);
      let spooled: { directory: string; path: string; size: number; } | undefined;
      let releaseTask: Promise<void> | undefined;
      const releaseFile = () => {
        if (!spooled) return Promise.resolve();
        releaseTask ??= removeUploadDirectory(spooled.directory);
        return releaseTask;
      };
      const resetProgressTimer = () => {
        clearTimeout(progressTimer);
        progressTimer = setTimeout(
          () => controller.abort(new HttpFailure(504, "UPLOAD_PROGRESS_TIMEOUT")),
          uploadProgressInactivityMs
        );
      };
      try {
        spooled = await streamUpload(request, controller, currentUploadLimit());
        if (controller.signal.aborted) throw controller.signal.reason;
        resetProgressTimer();
        await options.client.sendFile(topicId, {
          ...metadata,
          path: spooled.path,
          size: spooled.size,
          signal: controller.signal,
          onProgress: resetProgressTimer,
          onFileReleased: releaseFile
        });
        if (controller.signal.aborted) throw controller.signal.reason;
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason instanceof HttpFailure) {
          throw controller.signal.reason;
        }
        if (error instanceof HttpFailure) {
          if (["UPLOAD_OPERATION_TIMEOUT", "UPLOAD_PROGRESS_TIMEOUT"].includes(error.code)) {
            diagnostic("upstream_failure", error.code);
          }
          throw error;
        }
        diagnostic("upstream_failure", "TELEGRAM_OPERATION_FAILED");
        throw new HttpFailure(502, "TELEGRAM_OPERATION_FAILED");
      } finally {
        clearTimeout(progressTimer);
        clearTimeout(absoluteTimer);
        response.off("close", abortForPeerClose);
        await releaseFile().catch(() => undefined);
        activeUploadControllers.delete(controller);
        uploadInFlight = false;
        inFlightMutations -= 1;
        activeUploadSettlements.delete(uploadSettlement);
        resolveUploadSettlement();
      }
      writeNoContent(response);
      return;
    }

    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([A-Za-z0-9_-]{43})$/);
    if (attachmentMatch) {
      methodAllowed(method, ["GET"]);
      assertQuery(url, []);
      if (
        rawHeaderValues(request, "range").length > 0
        || rawHeaderValues(request, "content-length").length > 0
        || rawHeaderValues(request, "transfer-encoding").length > 0
      ) throw new HttpFailure(400, "ATTACHMENT_REQUEST_INVALID");
      checkRate(false);
      if (inFlightDownloads >= GUI_MAX_ATTACHMENT_DOWNLOADS) {
        throw new HttpFailure(429, "ATTACHMENT_DOWNLOAD_LIMIT", { "Retry-After": "1" });
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timeout = setTimeout(abort, GUI_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      request.once("aborted", abort);
      response.once("close", abort);
      activeDownloadControllers.add(controller);
      inFlightDownloads += 1;
      let download: TelegramAttachmentDownload;
      try {
        download = await options.client.downloadAttachment(attachmentMatch[1]!, controller.signal);
        assertSession(request);
      } catch (error) {
        if (error instanceof HttpFailure) throw error;
        diagnostic("upstream_failure", "ATTACHMENT_NOT_AVAILABLE");
        throw new HttpFailure(404, "ATTACHMENT_NOT_AVAILABLE");
      } finally {
        clearTimeout(timeout);
        request.off("aborted", abort);
        activeDownloadControllers.delete(controller);
        inFlightDownloads -= 1;
      }
      if (
        !download
        || !["image", "document"].includes(download.kind)
        || typeof download.name !== "string"
        || Buffer.byteLength(download.name, "utf8") < 1
        || Buffer.byteLength(download.name, "utf8") > 255
        || /[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(download.name)
        || typeof download.mimeType !== "string"
        || !ATTACHMENT_MIME_TYPES.has(download.mimeType)
        || !(download.bytes instanceof Uint8Array)
        || download.bytes.byteLength < 1
        || download.bytes.byteLength > GUI_MAX_ATTACHMENT_BYTES
        || (download.kind === "image" && !INLINE_IMAGE_MIME_TYPES.has(download.mimeType))
      ) throw new HttpFailure(502, "INVALID_ATTACHMENT_RESPONSE");
      writeBinary(response, 200, download.bytes, {
        "Content-Type": download.mimeType,
        "Content-Disposition": encodedContentDisposition(download.kind === "image" ? "inline" : "attachment", download.name)
      });
      return;
    }

    const callbackMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/callback$/);
    if (callbackMatch) {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const messageId = positiveInteger(Number(callbackMatch[1]), "INVALID_MESSAGE_ID");
      const body = parseJsonObject(await readJson(request, ordinaryTimeouts), ["callbackData"]);
      const callbackData = body["callbackData"];
      if (typeof callbackData !== "string" || !/^[A-Za-z0-9_-]+$/.test(callbackData)) {
        throw new HttpFailure(400, "INVALID_CALLBACK_DATA");
      }
      const callbackBytes = Buffer.from(callbackData, "base64url");
      if (
        callbackBytes.length < 1
        || callbackBytes.length > 64
        || callbackBytes.toString("base64url") !== callbackData
      ) throw new HttpFailure(400, "INVALID_CALLBACK_DATA");
      await mutation(async () => {
        await options.client.pressCallback(messageId, callbackData);
      });
      writeNoContent(response);
      return;
    }

    const readMatch = url.pathname.match(/^\/api\/topics\/(\d+)\/read$/);
    if (readMatch) {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const topicId = positiveInteger(Number(readMatch[1]), "INVALID_TOPIC_ID");
      const body = parseJsonObject(await readJson(request, ordinaryTimeouts), ["maxMessageId"]);
      const maxMessageId = positiveInteger(body["maxMessageId"], "INVALID_MESSAGE_ID");
      await mutation(() => options.client.markRead(topicId, maxMessageId), true);
      writeNoContent(response);
      return;
    }

    const typingMatch = url.pathname.match(/^\/api\/topics\/(\d+)\/typing$/);
    if (typingMatch) {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const topicId = positiveInteger(Number(typingMatch[1]), "INVALID_TOPIC_ID");
      const body = parseJsonObject(await readJson(request, ordinaryTimeouts), ["active"]);
      if (typeof body["active"] !== "boolean") throw new HttpFailure(400, "INVALID_TYPING_STATE");
      await mutation(() => options.client.setTyping(topicId, body["active"] as boolean), true);
      writeNoContent(response);
      return;
    }

    if (url.pathname === "/api/logout") {
      methodAllowed(method, ["POST"]);
      assertQuery(url, []);
      const body = await readBody(request, 0, ordinaryTimeouts);
      if (body.length !== 0) throw new HttpFailure(400, "LOGOUT_BODY_NOT_ALLOWED");
      for (const controller of activeUploadControllers) {
        controller.abort(new HttpFailure(499, "UPLOAD_CANCELLED"));
      }
      await mutation(() => options.client.logOut());
      sessionActive = false;
      for (const stream of streams) stream.end();
      streams.clear();
      for (const controller of activeDownloadControllers) controller.abort();
      writeNoContent(response, {
        "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
      });
      return;
    }

    if (url.pathname === "/api/events") {
      methodAllowed(method, ["GET"]);
      assertQuery(url, []);
      checkRate(false);
      if (streams.size >= GUI_MAX_SSE_CONNECTIONS) throw new HttpFailure(429, "SSE_CONNECTION_LIMIT");
      const lastEventId = singleHeader(request, "last-event-id", false);
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.flushHeaders();
      let replayed = false;
      let writable = true;
      if (lastEventId) {
        const match = lastEventId.match(/^([A-Za-z0-9_-]{16}):(\d+)$/);
        const requested = match?.[1] === epoch ? Number(match[2]) : Number.NaN;
        const oldest = journal[0]?.sequence ?? sequence + 1;
        if (Number.isSafeInteger(requested) && requested >= oldest - 1 && requested <= sequence) {
          for (const event of journal) {
            if (event.sequence > requested && !response.write(event.frame)) {
              writable = false;
              break;
            }
          }
          replayed = true;
        }
      }
      const syncData = JSON.stringify({
        type: "reconcile_required",
        reason: replayed ? "reconnected" : "snapshot_required",
        checkpointEventId: currentEventId()
      });
      if (writable) {
        writable = response.write(
          `id: ${currentEventId()}\nevent: reconcile_required\ndata: ${syncData}\n\n`
        );
      }
      if (!writable) {
        diagnostic("slow_sse_client", "SSE_BACKPRESSURE");
        response.end();
        return;
      }
      streams.add(response);
      const remove = () => streams.delete(response);
      response.once("close", remove);
      return;
    }

    throw new HttpFailure(404, "NOT_FOUND");
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    assertHost(request);
    if (!request.url || !request.url.startsWith("/") || bytes(request.url) > MAX_URL_BYTES) {
      throw new HttpFailure(400, "INVALID_REQUEST_TARGET");
    }
    const url = new URL(request.url, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) {
      throw new HttpFailure(400, "INVALID_REQUEST_TARGET");
    }
    if (url.pathname === "/bootstrap") return await handleBootstrap(request, response, url);
    if (url.pathname === "/healthz") {
      methodAllowed(requestMethod(request), ["GET"]);
      assertQuery(url, []);
      writeJson(response, 200, { process: "ready", transport, streams: streams.size });
      return;
    }
    const webAsset = WEB_ASSETS.get(url.pathname);
    if (webAsset) {
      methodAllowed(requestMethod(request), ["GET"]);
      assertQuery(url, []);
      assertSession(request);
      writeBinary(response, 200, webAsset.body, { "Content-Type": webAsset.contentType });
      return;
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    throw new HttpFailure(404, "NOT_FOUND");
  }

  const server: Server = createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const failure = error instanceof HttpFailure
        ? error
        : new HttpFailure(500, "INTERNAL_ERROR");
      diagnostic(
        error instanceof HttpFailure ? "request_rejected" : "upstream_failure",
        failure.code
      );
      writeFailure(response, failure);
    });
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 256;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => rejectListen(error);
      server.once("error", onError);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", onError);
        resolveListen();
      });
    });
  } catch (error) {
    await rm(uploadRunRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(uploadRunRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("GUI server did not bind to an ephemeral IPv4 loopback port");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  origin = `http://${expectedHost}`;
  let bootstrapUrl: string | null = `${origin}/bootstrap?cap=${capability}`;

  const heartbeat = setInterval(() => {
    if (expireWebSessionIfNeeded()) return;
    for (const stream of [...streams]) {
      if (!stream.write(": keepalive\n\n")) {
        streams.delete(stream);
        stream.end();
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    origin,
    takeBootstrapUrl() {
      if (bootstrapUrl === null) throw new Error("GUI bootstrap URL has already been consumed");
      const value = bootstrapUrl;
      bootstrapUrl = null;
      return value;
    },
    publishAuthState(state) {
      auth = publicAuthState(state);
      transport = state.state === "ready"
        ? "online"
        : state.state === "connecting" || state.state === "reconnecting"
          ? "connecting"
          : "offline";
      appendEvent({ type: "auth_state", auth });
    },
    publishUpdate(update) {
      try {
        appendEvent(projectUpdate(update));
      } catch {
        diagnostic("upstream_failure", "INVALID_UPSTREAM_UPDATE");
        appendEvent({ type: "reconcile_required" });
      }
    },
    close() {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        clearInterval(heartbeat);
        for (const stream of streams) stream.end();
        streams.clear();
        for (const controller of activeDownloadControllers) controller.abort();
        for (const controller of activeUploadControllers) {
          controller.abort(new HttpFailure(499, "UPLOAD_CANCELLED"));
        }
        server.closeAllConnections();
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }).catch((error: unknown) => {
          if (!(error instanceof Error && error.message.includes("Server is not running"))) throw error;
        });
        for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...activeUploadSettlements]);
        await Promise.all([...activeUploadDirs].map(async (directory) => {
          await removeUploadDirectory(directory);
        }));
        await rm(uploadRunRoot, { recursive: true, force: true });
      })();
      return closeTask;
    }
  };
}
