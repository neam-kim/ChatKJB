export const GENERAL_TOPIC_ID = 1;
export const GUI_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export const GUI_ALLOWED_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "application/zip",
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
] as const;

const ATTACHMENT_MIME_TYPES = new Set<string>(GUI_ALLOWED_ATTACHMENT_MIME_TYPES);

export type GuiConnectionState =
  | "signed_out"
  | "connecting"
  | "waiting_qr"
  | "waiting_password"
  | "ready"
  | "reconnecting"
  | "error";

export interface GuiAuthState {
  state: GuiConnectionState;
  passwordHint?: string;
  errorCode?: string;
}

export interface TopicCursor {
  offsetDate: number;
  offsetId: number;
  offsetTopic: number;
}

export interface HistoryCursor {
  offsetId: number;
  offsetDate: number;
}

export interface GuiTopic {
  id: number;
  title: string;
  topMessageId: number;
  unreadCount: number;
  pinned: boolean;
  closed: boolean;
  hidden: boolean;
}

export interface GuiButton {
  kind: "callback" | "url";
  text: string;
  callbackData?: string;
  url?: string;
  requiresPassword?: boolean;
}

export interface GuiReplyPanel {
  messageId: number;
  rows: string[][];
}

export interface GuiTextEntity {
  kind: "code" | "pre" | "url";
  offset: number;
  length: number;
  language?: string;
  url?: string;
}

export interface GuiAttachment {
  kind: "image" | "document";
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  token?: string;
}

export interface GuiMessage {
  id: number;
  topicId: number;
  text: string;
  sentAt: number;
  editedAt: number | null;
  outgoing: boolean;
  buttons: GuiButton[][];
  replyPanel?: GuiReplyPanel;
  entities?: GuiTextEntity[];
  attachment?: GuiAttachment;
}

export type GuiTelegramUpdate =
  | { type: "message_upsert"; message: GuiMessage; }
  | { type: "message_delete"; topicId: number; messageIds: number[]; }
  | { type: "topic_delete"; topicId: number; }
  | { type: "reconcile_required"; };

export interface GuiPublicAuthState {
  state: GuiConnectionState;
  errorCode?: string;
}

export interface GuiTopicPageDto {
  topics: GuiTopic[];
  nextCursor: string | null;
  checkpointEventId: string;
}

export interface GuiMessagePageDto {
  messages: GuiMessage[];
  nextCursor: string | null;
  checkpointEventId: string;
}

export type GuiServerEvent =
  | { type: "auth_state"; auth: GuiPublicAuthState; }
  | GuiTelegramUpdate;

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const string = String((value as { toString(): string; }).toString());
    if (/^-?\d+$/.test(string)) {
      const number = Number(string);
      return Number.isSafeInteger(number) ? number : null;
    }
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function markedChannelId(channelId: unknown): number | null {
  const id = integer(channelId);
  if (id === null || id <= 0 || id > 997_852_516_352) return null;
  const marked = -(1_000_000_000_000 + id);
  return Number.isSafeInteger(marked) ? marked : null;
}

export function rawMessageChatId(message: unknown): number | null {
  const value = record(message);
  const peerId = record(value?.["peerId"]);
  if (peerId?.["className"] !== "PeerChannel") return null;
  return markedChannelId(peerId["channelId"]);
}

export function topicIdFromRawMessage(message: unknown): number {
  const value = record(message);
  const replyTo = record(value?.["replyTo"]);
  if (replyTo?.["forumTopic"] !== true) return GENERAL_TOPIC_ID;
  return integer(replyTo["replyToTopId"])
    ?? integer(replyTo["replyToMsgId"])
    ?? GENERAL_TOPIC_ID;
}

export function isTopicCreateRoot(message: unknown, topicIds: ReadonlySet<number>): boolean {
  const value = record(message);
  const id = integer(value?.["id"]);
  const action = record(value?.["action"]);
  return id !== null
    && id !== GENERAL_TOPIC_ID
    && topicIds.has(id)
    && action?.["className"] === "MessageActionTopicCreate";
}

function normalizeButtons(replyMarkup: unknown): GuiButton[][] {
  const markup = record(replyMarkup);
  const rows = Array.isArray(markup?.["rows"]) ? markup["rows"] : [];
  return rows.map((rowValue) => {
    const row = record(rowValue);
    const buttons = Array.isArray(row?.["buttons"]) ? row["buttons"] : [];
    return buttons.flatMap((buttonValue): GuiButton[] => {
      const button = record(buttonValue);
      const text = typeof button?.["text"] === "string" ? button["text"] : "";
      if (button?.["className"] === "KeyboardButtonCallback") {
        const data = button["data"];
        if (!Buffer.isBuffer(data) && !(data instanceof Uint8Array)) return [];
        return [{
          kind: "callback",
          text,
          callbackData: Buffer.from(data).toString("base64url"),
          requiresPassword: button["requiresPassword"] === true
        }];
      }
      if (button?.["className"] === "KeyboardButtonUrl" && typeof button["url"] === "string") {
        const url = safeHttpUrl(button["url"]);
        return url ? [{ kind: "url", text, url }] : [];
      }
      return [];
    });
  }).filter((row) => row.length > 0);
}

const REPLY_PANEL_PREFIXES: ReadonlyArray<ReadonlyArray<readonly string[]>> = [
  [["\u2699\ufe0f \uc0c8 \uc138\uc158 \uae30\ubcf8\uac12"], ["\ud83e\udde0 \ubaa8\ub378"]],
  [["\ud83e\udd16 \uc81c\uacf5\uc790"], ["\ud83d\udcad "]],
  [["\ud83d\udee0\ufe0f \uc791\uc5c5\ub7c9", "\u2796"], ["\ud83d\udd11 \ud1a0\ud070", "\u2796"]]
];

function validReplyPanelLabel(value: unknown, row: number, column: number): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 128) {
    return false;
  }
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  const prefixes = REPLY_PANEL_PREFIXES[row]?.[column] ?? [];
  return prefixes.some((prefix) => prefix === "\u2796" ? value === prefix : value.startsWith(prefix));
}

function normalizeReplyPanelRows(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const rows: string[][] = [];
  for (let rowIndex = 0; rowIndex < value.length; rowIndex += 1) {
    const sourceRow = value[rowIndex];
    if (!Array.isArray(sourceRow) || sourceRow.length !== 2) return null;
    const row: string[] = [];
    for (let columnIndex = 0; columnIndex < sourceRow.length; columnIndex += 1) {
      const label = sourceRow[columnIndex];
      if (!validReplyPanelLabel(label, rowIndex, columnIndex)) return null;
      row.push(label);
    }
    rows.push(row);
  }
  return rows;
}

/** Revalidates a normalized panel before it crosses another trust boundary. */
export function normalizeGuiReplyPanel(value: unknown): GuiReplyPanel | null {
  const panel = record(value);
  const messageId = integer(panel?.["messageId"]);
  const rows = normalizeReplyPanelRows(panel?.["rows"]);
  if (messageId === null || messageId <= 0 || !rows) return null;
  return { messageId, rows };
}

function normalizeTelegramReplyPanel(replyMarkup: unknown, messageId: number): GuiReplyPanel | null {
  const markup = record(replyMarkup);
  if (markup?.["className"] !== "ReplyKeyboardMarkup") return null;
  const rawRows = markup["rows"];
  if (!Array.isArray(rawRows) || rawRows.length !== 3) return null;
  const rows: string[][] = [];
  for (const rawRow of rawRows) {
    const row = record(rawRow);
    const buttons = row?.["className"] === "KeyboardButtonRow" ? row["buttons"] : null;
    if (!Array.isArray(buttons) || buttons.length !== 2) return null;
    const labels: string[] = [];
    for (const rawButton of buttons) {
      const button = record(rawButton);
      if (button?.["className"] !== "KeyboardButton") return null;
      labels.push(button["text"] as string);
    }
    rows.push(labels);
  }
  return normalizeGuiReplyPanel({ messageId, rows });
}

function blockedHttpHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const blockedIpv4 = (octets: number[]): boolean => {
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return true;
    }
    const [a = 0, b = 0, c = 0] = octets;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c <= 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || a >= 224;
  };
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    return blockedIpv4(ipv4.slice(1).map(Number));
  }
  const ipv6 = host.replace(/^\[|\]$/g, "");
  if (ipv6.includes(":")) {
    const mapped = ipv6.match(/^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (mapped) {
      const high = Number.parseInt(mapped[1]!, 16);
      const low = Number.parseInt(mapped[2]!, 16);
      if (blockedIpv4([high >> 8, high & 255, low >> 8, low & 255])) return true;
    }
    const dottedMapped = ipv6.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
    if (dottedMapped && blockedIpv4(dottedMapped.slice(1).map(Number))) return true;
    return ipv6 === "::" || ipv6 === "::1"
      || /^f[cd]/i.test(ipv6)
      || /^fe[89a-f]/i.test(ipv6)
      || /^64:ff9b(?::1)?:/i.test(ipv6);
  }
  return false;
}

export function safeHttpUrl(value: string): string | null {
  if (value.length === 0 || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username
      && !url.password
      && !blockedHttpHostname(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeEntities(rawEntities: unknown, text: string): GuiTextEntity[] {
  if (!Array.isArray(rawEntities) || rawEntities.length === 0 || rawEntities.length > 256) return [];
  const candidates = rawEntities.flatMap((raw): GuiTextEntity[] => {
    const entity = record(raw);
    const offset = integer(entity?.["offset"]);
    const length = integer(entity?.["length"]);
    if (
      offset === null
      || length === null
      || offset < 0
      || length <= 0
      || offset + length > text.length
    ) return [];
    if (entity?.["className"] === "MessageEntityCode") return [{ kind: "code", offset, length }];
    if (entity?.["className"] === "MessageEntityPre") {
      const language = typeof entity["language"] === "string" && /^[A-Za-z0-9_+.-]{0,32}$/.test(entity["language"])
        ? entity["language"]
        : "";
      return [{ kind: "pre", offset, length, ...(language ? { language } : {}) }];
    }
    const rawUrl = entity?.["className"] === "MessageEntityTextUrl"
      ? entity["url"]
      : entity?.["className"] === "MessageEntityUrl"
        ? text.slice(offset, offset + length)
        : undefined;
    const url = typeof rawUrl === "string" ? safeHttpUrl(rawUrl) : null;
    return url ? [{ kind: "url", offset, length, url }] : [];
  }).sort((left, right) => left.offset - right.offset || left.length - right.length);
  const accepted: GuiTextEntity[] = [];
  let previousEnd = 0;
  for (const entity of candidates) {
    if (accepted.length > 0 && entity.offset < previousEnd) continue;
    accepted.push(entity);
    previousEnd = entity.offset + entity.length;
  }
  return accepted;
}

function safeIncomingFilename(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  let result = value.normalize("NFC")
    .replace(/[\/\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "_")
    .trim();
  if (!result || result === "." || result === "..") result = fallback;
  while (Buffer.byteLength(result, "utf8") > 255) result = result.slice(0, -1);
  return result || fallback;
}

function photoDimensions(photo: Record<string, unknown>): {
  size: number;
  width?: number;
  height?: number;
} {
  const sizes = Array.isArray(photo["sizes"]) ? photo["sizes"] : [];
  let selected: { size: number; width?: number; height?: number; area: number; } = { size: 0, area: 0 };
  for (const rawSize of sizes) {
    const size = record(rawSize);
    const width = integer(size?.["w"]);
    const height = integer(size?.["h"]);
    const directSize = integer(size?.["size"]);
    const progressive = Array.isArray(size?.["sizes"])
      ? Math.max(0, ...size["sizes"].map((value) => integer(value) ?? 0))
      : 0;
    const byteSize = Math.max(directSize ?? 0, progressive);
    const area = Math.max(0, width ?? 0) * Math.max(0, height ?? 0);
    if (area >= selected.area) {
      selected = {
        size: byteSize,
        ...(width !== null && width > 0 ? { width } : {}),
        ...(height !== null && height > 0 ? { height } : {}),
        area
      };
    }
  }
  return {
    size: selected.size,
    ...(selected.width ? { width: selected.width } : {}),
    ...(selected.height ? { height: selected.height } : {})
  };
}

function normalizeAttachment(mediaValue: unknown, messageId: number): GuiAttachment | null {
  const media = record(mediaValue);
  if (!media || media["spoiler"] === true || media["ttlSeconds"] !== undefined) return null;
  if (media["className"] === "MessageMediaPhoto") {
    const photo = record(media["photo"]);
    if (photo?.["className"] !== "Photo") return null;
    const dimensions = photoDimensions(photo);
    if (dimensions.size < 1 || dimensions.size > GUI_MAX_ATTACHMENT_BYTES) return null;
    return {
      kind: "image",
      name: `photo-${messageId}.jpg`,
      mimeType: "image/jpeg",
      ...dimensions
    };
  }
  if (media["className"] !== "MessageMediaDocument") return null;
  const document = record(media["document"]);
  const size = integer(document?.["size"]);
  const rawMimeType = document?.["mimeType"];
  if (
    document?.["className"] !== "Document"
    || size === null
    || size < 1
    || size > GUI_MAX_ATTACHMENT_BYTES
    || typeof rawMimeType !== "string"
  ) return null;
  const mimeType = ATTACHMENT_MIME_TYPES.has(rawMimeType) ? rawMimeType : "application/octet-stream";
  const attributes = Array.isArray(document["attributes"]) ? document["attributes"] : [];
  const filenameAttribute = attributes.map(record)
    .find((attribute) => attribute?.["className"] === "DocumentAttributeFilename");
  const dimensionAttribute = attributes.map(record)
    .find((attribute) => attribute?.["className"] === "DocumentAttributeImageSize");
  const width = integer(dimensionAttribute?.["w"]);
  const height = integer(dimensionAttribute?.["h"]);
  return {
    kind: "document",
    name: safeIncomingFilename(filenameAttribute?.["fileName"], `document-${messageId}.bin`),
    mimeType,
    size,
    ...(width !== null && width > 0 ? { width } : {}),
    ...(height !== null && height > 0 ? { height } : {})
  };
}

export function normalizeTelegramMessage(
  message: unknown,
  topicIds: ReadonlySet<number>
): GuiMessage | null {
  const value = record(message);
  if (value?.["className"] !== "Message") return null;
  const id = integer(value["id"]);
  const date = integer(value["date"]);
  if (id === null || id <= 0 || date === null || isTopicCreateRoot(message, topicIds)) return null;
  const topicId = topicIdFromRawMessage(message);
  const text = typeof value["message"] === "string" ? value["message"] : "";
  const editDate = integer(value["editDate"]);
  const entities = normalizeEntities(value["entities"], text);
  const attachment = normalizeAttachment(value["media"], id);
  const replyPanel = topicId === GENERAL_TOPIC_ID
    ? normalizeTelegramReplyPanel(value["replyMarkup"], id)
    : null;
  return {
    id,
    topicId,
    text,
    sentAt: date * 1000,
    editedAt: editDate === null ? null : editDate * 1000,
    outgoing: value["out"] === true,
    buttons: normalizeButtons(value["replyMarkup"]),
    ...(replyPanel ? { replyPanel } : {}),
    ...(entities.length > 0 ? { entities } : {}),
    ...(attachment ? { attachment } : {})
  };
}

export function normalizeForumTopics(result: unknown): {
  topics: GuiTopic[];
  nextCursor: TopicCursor | null;
} {
  const value = record(result);
  const rawTopics = Array.isArray(value?.["topics"]) ? value["topics"] : [];
  const messages = Array.isArray(value?.["messages"]) ? value["messages"] : [];
  const datesById = new Map<number, number>();
  const topicDatesById = new Map<number, number>();
  for (const message of messages) {
    const item = record(message);
    const id = integer(item?.["id"]);
    const date = integer(item?.["date"]);
    if (id !== null && date !== null) datesById.set(id, date);
  }
  const topics = rawTopics.flatMap((topicValue): GuiTopic[] => {
    const topic = record(topicValue);
    if (!topic) return [];
    if (topic?.["className"] === "ForumTopicDeleted") return [];
    const id = integer(topic?.["id"]);
    const topMessageId = integer(topic?.["topMessage"]);
    if (id === null || id <= 0 || topMessageId === null) return [];
    topicDatesById.set(id, integer(topic["date"]) ?? 0);
    return [{
      id,
      title: typeof topic["title"] === "string" ? topic["title"] : (id === 1 ? "General" : `Topic ${id}`),
      topMessageId,
      unreadCount: Math.max(0, integer(topic["unreadCount"]) ?? 0),
      pinned: topic["pinned"] === true,
      closed: topic["closed"] === true,
      hidden: topic["hidden"] === true
    }];
  });
  const last = topics.at(-1);
  if (!last) return { topics, nextCursor: null };
  return {
    topics,
    nextCursor: {
      offsetDate: datesById.get(last.topMessageId) ?? topicDatesById.get(last.id) ?? 0,
      offsetId: last.topMessageId,
      offsetTopic: last.id
    }
  };
}

export function nextRawHistoryCursor(messages: readonly unknown[]): HistoryCursor | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = record(messages[index]);
    const id = integer(value?.["id"]);
    const date = integer(value?.["date"]);
    if (id !== null && id > 0 && date !== null && date >= 0) {
      return { offsetId: id, offsetDate: date };
    }
  }
  return null;
}

export function safeTelegramErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "errorMessage" in error) {
    const value = String((error as { errorMessage?: unknown; }).errorMessage ?? "");
    const match = value.match(/[A-Z][A-Z0-9_]{2,}/);
    if (match) return match[0];
  }
  if (error instanceof Error && error.name && error.name !== "Error") return error.name;
  return "TELEGRAM_AUTH_FAILED";
}
