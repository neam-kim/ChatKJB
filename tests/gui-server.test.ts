import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GuiAuthState,
  GuiMessage,
  GuiReplyPanel,
  GuiTopic,
  HistoryCursor,
  TopicCursor
} from "../src/gui/protocol.js";
import {
  GUI_MAX_PAGE_LIMIT,
  startGuiServer,
  type GuiServerClient,
  type GuiServerDiagnostic,
  type GuiServerHandle
} from "../src/gui/server.js";
import {
  GUI_MAX_UPLOAD_BYTES,
  HistoryInvalidatedError,
  type MessagePage,
  type TelegramUploadInput,
  type TopicPage
} from "../src/gui/telegram-user-client.js";

const SECURITY_HEADER_EXPECTATIONS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=()",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
} as const;

const LEAK_SENTINELS = [
  "LEAK_PHONE_SENTINEL",
  "LEAK_SESSION_SENTINEL",
  "LEAK_API_HASH_SENTINEL",
  "LEAK_PEER_SENTINEL",
  "LEAK_CALLBACK_SENTINEL"
] as const;

const REPLY_PANEL_ROWS = [
  ["\u2699\ufe0f \uc0c8 \uc138\uc158 \uae30\ubcf8\uac12", "\ud83e\udde0 \ubaa8\ub378: GPT-5.6-Sol"],
  ["\ud83e\udd16 \uc81c\uacf5\uc790: Codex", "\ud83d\udcad \ucd94\ub860: \ub9e4\uc6b0 \ub192\uc74c (xHigh)"],
  ["\u2796", "\ud83d\udd11 \ud1a0\ud070: #3"]
] as const;

interface AuthenticatedSession {
  cookie: string;
  csrf: string;
  epoch: string;
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface ParsedSseFrame {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

class FakeGuiServerClient implements GuiServerClient {
  topicsPage: TopicPage = { topics: [], nextCursor: null };
  messagesPage: MessagePage = { messages: [], nextCursor: null };
  generalPanel: GuiReplyPanel | null = null;
  callbackResult: unknown = undefined;

  readonly beginQrLogin = vi.fn(async () => undefined);
  readonly submitPassword = vi.fn((_password: string) => undefined);
  readonly cancelLogin = vi.fn(() => undefined);
  readonly listTopics = vi.fn(async (_cursor?: TopicCursor, _limit?: number) => this.topicsPage);
  readonly listMessages = vi.fn(async (
    _topicId: number,
    _cursor?: HistoryCursor,
    _limit?: number
  ) => this.messagesPage);
  readonly findGeneralReplyPanel = vi.fn(async () => this.generalPanel);
  readonly sendText = vi.fn(async (_topicId: number, _text: string) => undefined);
  readonly sendFile = vi.fn(async (_topicId: number, _input: TelegramUploadInput) => undefined);
  readonly downloadAttachment = vi.fn<GuiServerClient["downloadAttachment"]>(async (_token: string) => ({
    kind: "image" as const,
    name: "safe image.jpg",
    mimeType: "image/jpeg",
    bytes: Uint8Array.from([0xff, 0xd8, 0xff])
  }));
  readonly pressCallback = vi.fn(async (_messageId: number, _callbackData: string) => this.callbackResult);
  readonly markRead = vi.fn(async (_topicId: number, _maxMessageId: number) => undefined);
  readonly setTyping = vi.fn(async (_topicId: number, _active: boolean) => undefined);
  readonly logOut = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
}

class SseConnection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  private constructor(
    readonly response: Response,
    private readonly controller: AbortController
  ) {
    if (!response.body) throw new Error("SSE response did not have a body");
    this.reader = response.body.getReader();
  }

  static async open(
    origin: string,
    session: AuthenticatedSession,
    lastEventId?: string,
    includeOrigin = true
  ): Promise<SseConnection> {
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/events`, {
      headers: {
        ...(includeOrigin ? { Origin: origin } : {}),
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Sec-Fetch-Site": "same-origin",
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {})
      },
      signal: controller.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expectSecurityHeaders(response);
    return new SseConnection(response, controller);
  }

  async nextFrame(timeoutMs = 2_000): Promise<ParsedSseFrame> {
    while (true) {
      const separator = this.buffer.indexOf("\n\n");
      if (separator >= 0) {
        const raw = this.buffer.slice(0, separator);
        this.buffer = this.buffer.slice(separator + 2);
        if (raw.startsWith(":")) continue;
        const id = raw.split("\n").find((line) => line.startsWith("id: "))?.slice(4) ?? "";
        const event = raw.split("\n").find((line) => line.startsWith("event: "))?.slice(7) ?? "";
        const data = raw.split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        return { id, event, data: JSON.parse(data) as Record<string, unknown> };
      }
      const chunk = await readWithTimeout(this.reader, timeoutMs);
      if (chunk.done) throw new Error("SSE stream ended before the expected frame");
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.reader.cancel().catch(() => undefined);
  }

  async expectEnd(timeoutMs = 2_000): Promise<void> {
    const chunk = await readWithTimeout(this.reader, timeoutMs);
    expect(chunk.done).toBe(true);
  }
}

const handles: GuiServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for SSE frame")), timeoutMs);
    void reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function expectSecurityHeaders(response: Response): void {
  for (const [name, expected] of Object.entries(SECURITY_HEADER_EXPECTATIONS)) {
    expect(response.headers.get(name), name).toContain(expected);
  }
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
}

function expectRawSecurityHeaders(headers: IncomingHttpHeaders): void {
  for (const [name, expected] of Object.entries(SECURITY_HEADER_EXPECTATIONS)) {
    expect(String(headers[name] ?? ""), name).toContain(expected);
  }
  expect(headers["access-control-allow-origin"]).toBeUndefined();
  expect(headers["access-control-allow-credentials"]).toBeUndefined();
}

function jsonHeaders(origin: string, session: AuthenticatedSession): Record<string, string> {
  return {
    Origin: origin,
    Cookie: session.cookie,
    "X-ChatKJB-CSRF": session.csrf,
    "Content-Type": "application/json"
  };
}

function readHeaders(origin: string, session: AuthenticatedSession): Record<string, string> {
  return {
    Origin: origin,
    Cookie: session.cookie,
    "X-ChatKJB-CSRF": session.csrf
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function startFixture(options: {
  client?: FakeGuiServerClient;
  diagnostics?: GuiServerDiagnostic[];
  now?: () => number;
  mutationTimeoutMs?: number;
} = {}): Promise<{ handle: GuiServerHandle; client: FakeGuiServerClient; diagnostics: GuiServerDiagnostic[]; }> {
  const client = options.client ?? new FakeGuiServerClient();
  const diagnostics = options.diagnostics ?? [];
  const handle = await startGuiServer({
    client,
    ...(options.now ? { now: options.now } : {}),
    ...(options.mutationTimeoutMs ? { mutationTimeoutMs: options.mutationTimeoutMs } : {}),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  });
  handles.push(handle);
  return { handle, client, diagnostics };
}

async function authenticate(handle: GuiServerHandle): Promise<AuthenticatedSession> {
  const bootstrap = await fetch(handle.takeBootstrapUrl(), { redirect: "manual" });
  expect(bootstrap.status).toBe(303);
  const setCookie = bootstrap.headers.get("set-cookie");
  if (!setCookie) throw new Error("bootstrap did not return a cookie");
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const sessionResponse = await fetch(`${handle.origin}/api/session`, {
    headers: { Origin: handle.origin, Cookie: cookie }
  });
  expect(sessionResponse.status).toBe(200);
  const session = await sessionResponse.json() as { csrfToken: string; eventEpoch: string; };
  return { cookie, csrf: session.csrfToken, epoch: session.eventEpoch };
}

async function rawRequest(
  target: string,
  options: { method?: string; headers?: Record<string, string | number>; body?: Uint8Array; } = {}
): Promise<RawResponse> {
  const url = new URL(target);
  return await new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers: options.headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function waitForStreamCount(origin: string, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${origin}/healthz`);
    const health = await response.json() as { streams: number; };
    if (health.streams === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`SSE stream count did not become ${expected}`);
}

function message(id: number, text: string, editedAt: number | null = null): GuiMessage {
  return {
    id,
    topicId: 42,
    text,
    sentAt: 1_700_000_000_000,
    editedAt,
    outgoing: false,
    buttons: []
  };
}

describe("GUI loopback server bootstrap and web trust boundary", () => {
  it("serves only the allowlisted no-store web application assets", async () => {
    const { handle } = await startFixture();
    const session = await authenticate(handle);
    for (const [path, contentType] of [
      ["/", "text/html; charset=utf-8"],
      ["/assets/styles.css", "text/css; charset=utf-8"],
      ["/assets/app.js", "text/javascript; charset=utf-8"],
      ["/manifest.webmanifest", "application/manifest+json; charset=utf-8"]
    ] as const) {
      const response = await fetch(`${handle.origin}${path}`, { headers: { Cookie: session.cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect((await response.text()).length).toBeGreaterThan(20);
    }
    const traversal = await fetch(`${handle.origin}/assets/%2e%2e/server.js`, {
      headers: { Cookie: session.cookie }
    });
    expect(traversal.status).toBe(404);
  });

  it("exchanges a random capability once without reflecting or diagnosing it", async () => {
    const { handle, diagnostics } = await startFixture();
    const bootstrapUrl = handle.takeBootstrapUrl();
    expect(() => handle.takeBootstrapUrl()).toThrow(/already been consumed/);
    const capability = new URL(bootstrapUrl).searchParams.get("cap");
    expect(capability).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const wrong = await fetch(`${handle.origin}/bootstrap?cap=${base64Url("wrong capability")}`, {
      redirect: "manual"
    });
    expect(wrong.status).toBe(401);
    expectSecurityHeaders(wrong);
    expect(await wrong.text()).not.toContain(capability!);

    const accepted = await fetch(bootstrapUrl, { redirect: "manual" });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("location")).toBe("/");
    expect(accepted.headers.get("location")).not.toContain(capability!);
    expect(await accepted.text()).toBe("");
    expectSecurityHeaders(accepted);

    const setCookie = accepted.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(
      /^chatkjb_gui_[0-9a-f]{16}=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/
    );
    expect(setCookie).not.toContain(capability!);

    const replay = await fetch(bootstrapUrl, { redirect: "manual" });
    expect(replay.status).toBe(401);
    expect(await replay.text()).not.toContain(capability!);
    expect(JSON.stringify(diagnostics)).not.toContain(capability!);
    expect(diagnostics).toEqual([
      { type: "request_rejected", code: "INVALID_BOOTSTRAP_CAPABILITY" },
      { type: "request_rejected", code: "INVALID_BOOTSTRAP_CAPABILITY" }
    ]);
  });

  it("requires exact Host, Origin, session cookie, and CSRF before a mutation", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const url = `${handle.origin}/api/topics/42/messages`;
    const validBody = JSON.stringify({ text: "allowed only after every boundary" });

    const wrongHost = await rawRequest(url, {
      method: "POST",
      headers: {
        Host: "localhost",
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(validBody)
      },
      body: Buffer.from(validBody)
    });
    expect(wrongHost.status).toBe(421);
    expectRawSecurityHeaders(wrongHost.headers);
    expect(client.sendText).not.toHaveBeenCalled();

    const attempts: Array<Promise<Response>> = [
      fetch(url, {
        method: "POST",
        headers: {
          Cookie: session.cookie,
          "X-ChatKJB-CSRF": session.csrf,
          "Content-Type": "application/json"
        },
        body: validBody
      }),
      fetch(url, {
        method: "POST",
        headers: { ...jsonHeaders("https://attacker.invalid", session) },
        body: validBody
      }),
      fetch(url, {
        method: "POST",
        headers: {
          Origin: handle.origin,
          "X-ChatKJB-CSRF": session.csrf,
          "Content-Type": "application/json"
        },
        body: validBody
      }),
      fetch(url, {
        method: "POST",
        headers: { ...jsonHeaders(handle.origin, session), Cookie: "chatkjb_gui_wrong=wrong" },
        body: validBody
      }),
      fetch(url, {
        method: "POST",
        headers: {
          Origin: handle.origin,
          Cookie: session.cookie,
          "Content-Type": "application/json"
        },
        body: validBody
      }),
      fetch(url, {
        method: "POST",
        headers: { ...jsonHeaders(handle.origin, session), "X-ChatKJB-CSRF": "wrong" },
        body: validBody
      })
    ];
    const responses = await Promise.all(attempts);
    expect(responses.map((response) => response.status)).toEqual([400, 403, 401, 401, 400, 403]);
    for (const response of responses) {
      expectSecurityHeaders(response);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      await response.text();
    }
    expect(client.sendText).not.toHaveBeenCalled();

    const allowed = await fetch(url, {
      method: "POST",
      headers: jsonHeaders(handle.origin, session),
      body: validBody
    });
    expect(allowed.status).toBe(204);
    expectSecurityHeaders(allowed);
    expect(client.sendText).toHaveBeenCalledOnce();
    expect(client.sendText).toHaveBeenCalledWith(42, "allowed only after every boundary");
  });

  it("allows same-origin safe GETs without an Origin header while retaining fetch metadata checks", async () => {
    const { handle } = await startFixture();
    const bootstrap = await fetch(handle.takeBootstrapUrl(), { redirect: "manual" });
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const sessionResponse = await fetch(`${handle.origin}/api/session`, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }
    });
    expect(sessionResponse.status).toBe(200);
    const body = await sessionResponse.json() as { csrfToken: string; eventEpoch: string; };
    const session = { cookie, csrf: body.csrfToken, epoch: body.eventEpoch };

    const topics = await fetch(`${handle.origin}/api/topics`, {
      headers: {
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Sec-Fetch-Site": "same-origin"
      }
    });
    expect(topics.status).toBe(200);

    const hostileOrigin = await fetch(`${handle.origin}/api/topics`, {
      headers: {
        Origin: "https://attacker.invalid",
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Sec-Fetch-Site": "same-origin"
      }
    });
    expect(hostileOrigin.status).toBe(403);

    const crossSite = await fetch(`${handle.origin}/api/topics`, {
      headers: {
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Sec-Fetch-Site": "cross-site"
      }
    });
    expect(crossSite.status).toBe(403);

    const stream = await SseConnection.open(handle.origin, session, undefined, false);
    try {
      expect((await stream.nextFrame()).event).toBe("reconcile_required");
    } finally {
      await stream.close();
    }
  });
});

describe("GUI REST DTO and input boundaries", () => {
  it("serves only a revalidated General reply panel projection", async () => {
    const client = new FakeGuiServerClient();
    client.generalPanel = {
      messageId: 700,
      rows: REPLY_PANEL_ROWS.map((row) => [...row]),
      secret: LEAK_SENTINELS[1]
    } as GuiReplyPanel;
    const { handle } = await startFixture({ client });
    const session = await authenticate(handle);

    const valid = await fetch(`${handle.origin}/api/general-panel`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(valid.status).toBe(200);
    const validText = await valid.text();
    expect(validText).not.toContain(LEAK_SENTINELS[1]);
    expect(JSON.parse(validText)).toEqual({
      panel: { messageId: 700, rows: REPLY_PANEL_ROWS }
    });
    expect(client.findGeneralReplyPanel).toHaveBeenCalledOnce();

    client.generalPanel = {
      messageId: 701,
      rows: REPLY_PANEL_ROWS.map((row) => [...row])
    };
    client.generalPanel.rows[1]![1] = "\ud83d\udcad \ucd94\ub860: \u202eHigh";
    const rejected = await fetch(`${handle.origin}/api/general-panel`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toEqual({ panel: null });

    const injected = await fetch(`${handle.origin}/api/general-panel?chatId=-1`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(injected.status).toBe(400);
    expect(client.findGeneralReplyPanel).toHaveBeenCalledTimes(2);
  });

  it("revalidates message reply panels and binds them to General and the containing message id", async () => {
    const client = new FakeGuiServerClient();
    const valid = {
      ...message(710, "valid panel"),
      topicId: 1,
      replyPanel: { messageId: 710, rows: REPLY_PANEL_ROWS.map((row) => [...row]) }
    };
    const wrongTopic = {
      ...message(711, "wrong topic"),
      replyPanel: { messageId: 711, rows: REPLY_PANEL_ROWS.map((row) => [...row]) }
    };
    const wrongMessage = {
      ...message(712, "wrong id"),
      topicId: 1,
      replyPanel: { messageId: 999, rows: REPLY_PANEL_ROWS.map((row) => [...row]) }
    };
    client.messagesPage = { messages: [valid, wrongTopic, wrongMessage], nextCursor: null };
    const { handle } = await startFixture({ client });
    const session = await authenticate(handle);

    const response = await fetch(`${handle.origin}/api/topics/1/messages`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { messages: GuiMessage[]; };
    expect(body.messages[0]?.replyPanel).toEqual({ messageId: 710, rows: REPLY_PANEL_ROWS });
    expect(body.messages[1]?.replyPanel).toBeUndefined();
    expect(body.messages[2]?.replyPanel).toBeUndefined();
  });

  it("downloads only opaque cached attachments with bounded safe response metadata", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const token = "A".repeat(43);
    const response = await fetch(`${handle.origin}/api/attachments/${token}`, {
      headers: readHeaders(handle.origin, session)
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''safe%20image.jpg"
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
    expect(client.downloadAttachment).toHaveBeenCalledWith(token, expect.any(AbortSignal));

    for (const invalid of ["short", `${token}.path`, "%2e%2e%2fsecret"] ) {
      const rejected = await fetch(`${handle.origin}/api/attachments/${invalid}`, {
        headers: readHeaders(handle.origin, session)
      });
      expect([400, 404]).toContain(rejected.status);
    }
    expect(client.downloadAttachment).toHaveBeenCalledOnce();
  });

  it("rejects attachment query injection and active or oversized response content", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const token = "C".repeat(43);

    const injected = await fetch(`${handle.origin}/api/attachments/${token}?path=/etc/passwd`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(injected.status).toBe(400);
    expect(client.downloadAttachment).not.toHaveBeenCalled();

    client.downloadAttachment.mockResolvedValueOnce({
      kind: "image",
      name: "payload.svg",
      mimeType: "image/svg+xml",
      bytes: Uint8Array.from([60, 115, 118, 103, 62])
    });
    const active = await fetch(`${handle.origin}/api/attachments/${token}`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(active.status).toBe(502);
    expect(active.headers.get("content-type")).toContain("application/json");

    client.downloadAttachment.mockResolvedValueOnce({
      kind: "document",
      name: "oversized.bin",
      mimeType: "application/octet-stream",
      bytes: new Uint8Array(20 * 1024 * 1024 + 1)
    });
    const oversized = await fetch(`${handle.origin}/api/attachments/${token}`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(oversized.status).toBe(502);
  });

  it("projects topic and message pages onto the public allowlist and signs cursors", async () => {
    const client = new FakeGuiServerClient();
    const topic = {
      id: 42,
      title: "Project",
      topMessageId: 90,
      unreadCount: 2,
      pinned: false,
      closed: false,
      hidden: false,
      phone: LEAK_SENTINELS[0],
      session: LEAK_SENTINELS[1],
      peer: LEAK_SENTINELS[3]
    } as GuiTopic;
    const callbackData = base64Url("allowed");
    const projectedMessage = {
      ...message(91, "safe body"),
      buttons: [[
        { kind: "callback", text: "Allowed", callbackData },
        { kind: "callback", text: "Password", callbackData, requiresPassword: true },
        { kind: "url", text: "Unsafe", url: "javascript:alert(1)" },
        { kind: "url", text: "Private", url: "http://127.0.0.1/private" }
      ]],
      entities: [
        { kind: "code", offset: 0, length: 4 },
        { kind: "pre", offset: 1, length: 4, language: "<script>" },
        { kind: "url", offset: 5, length: 4, url: "https://example.com" }
      ],
      attachment: {
        kind: "image",
        name: "safe.jpg",
        mimeType: "image/jpeg",
        size: 123,
        width: 20,
        height: 10,
        token: "B".repeat(43),
        accessHash: LEAK_SENTINELS[3],
        fileReference: LEAK_SENTINELS[4]
      },
      apiHash: LEAK_SENTINELS[2],
      rawPeer: LEAK_SENTINELS[3]
    } as GuiMessage;
    client.topicsPage = {
      topics: [topic],
      nextCursor: { offsetDate: 100, offsetId: 90, offsetTopic: 42 }
    };
    client.messagesPage = {
      messages: [projectedMessage],
      nextCursor: { offsetId: 91, offsetDate: 100 }
    };
    const { handle } = await startFixture({ client });
    const session = await authenticate(handle);

    const topicsResponse = await fetch(`${handle.origin}/api/topics?limit=1`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(topicsResponse.status).toBe(200);
    const topicsBody = await topicsResponse.json() as {
      topics: GuiTopic[];
      nextCursor: string;
      checkpointEventId: string;
    };
    expect(topicsBody.topics).toEqual([{
      id: 42,
      title: "Project",
      topMessageId: 90,
      unreadCount: 2,
      pinned: false,
      closed: false,
      hidden: false
    }]);
    expect(topicsBody.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(topicsBody.checkpointEventId).toMatch(/^[A-Za-z0-9_-]{16}:0$/);

    const messagesResponse = await fetch(`${handle.origin}/api/topics/42/messages?limit=1`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(messagesResponse.status).toBe(200);
    const messagesText = await messagesResponse.text();
    for (const sentinel of LEAK_SENTINELS) expect(messagesText).not.toContain(sentinel);
    const messagesBody = JSON.parse(messagesText) as { messages: GuiMessage[]; nextCursor: string; };
    expect(messagesBody.messages).toEqual([{
      ...message(91, "safe body"),
      buttons: [[{ kind: "callback", text: "Allowed", callbackData }]],
      entities: [
        { kind: "code", offset: 0, length: 4 },
        { kind: "url", offset: 5, length: 4, url: "https://example.com/" }
      ],
      attachment: {
        kind: "image",
        name: "safe.jpg",
        mimeType: "image/jpeg",
        size: 123,
        width: 20,
        height: 10,
        token: "B".repeat(43)
      }
    }]);

    const cursorResponse = await fetch(
      `${handle.origin}/api/topics?limit=1&cursor=${encodeURIComponent(topicsBody.nextCursor)}`,
      { headers: readHeaders(handle.origin, session) }
    );
    expect(cursorResponse.status).toBe(200);
    expect(client.listTopics).toHaveBeenLastCalledWith(
      { offsetDate: 100, offsetId: 90, offsetTopic: 42 },
      1
    );
  });

  it("rejects strict text, page, cursor, callback, and generic-scope injection before client calls", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const mutationUrl = `${handle.origin}/api/topics/42/messages`;

    for (const body of [
      {},
      { text: "" },
      { text: "   " },
      { text: "x".repeat(4_097) },
      { text: 42 },
      { text: "attempt", chatId: -1_000_000_000_123 },
      { text: "attempt", method: "messages.sendMessage" },
      { text: "attempt", path: "/etc/passwd" }
    ]) {
      const response = await fetch(mutationUrl, {
        method: "POST",
        headers: jsonHeaders(handle.origin, session),
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
    }
    expect(client.sendText).not.toHaveBeenCalled();

    for (const query of [
      "limit=0",
      `limit=${GUI_MAX_PAGE_LIMIT + 1}`,
      "limit=1.5",
      "limit=1&limit=2",
      "chatId=-1000000000123",
      "cursor=unsigned",
      `limit=1&padding=${"x".repeat(2_100)}`
    ]) {
      const response = await fetch(`${handle.origin}/api/topics?${query}`, {
        headers: readHeaders(handle.origin, session)
      });
      expect(response.status).toBe(400);
    }
    expect(client.listTopics).not.toHaveBeenCalled();

    client.topicsPage = {
      topics: [],
      nextCursor: { offsetDate: 1, offsetId: 2, offsetTopic: 3 }
    };
    const firstPage = await fetch(`${handle.origin}/api/topics?limit=1`, {
      headers: readHeaders(handle.origin, session)
    });
    const cursor = (await firstPage.json() as { nextCursor: string; }).nextCursor;
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const tamperedResponse = await fetch(`${handle.origin}/api/topics?cursor=${tampered}`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(tamperedResponse.status).toBe(400);
    const crossKind = await fetch(`${handle.origin}/api/topics/42/messages?cursor=${encodeURIComponent(cursor)}`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(crossKind.status).toBe(400);
    expect(client.listMessages).not.toHaveBeenCalled();

    const callbackUrl = `${handle.origin}/api/messages/91/callback`;
    for (const callbackData of ["", "***", "A", `${base64Url("x".repeat(65))}`]) {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: jsonHeaders(handle.origin, session),
        body: JSON.stringify({ callbackData })
      });
      expect(response.status).toBe(400);
    }
    const extraCallbackField = await fetch(callbackUrl, {
      method: "POST",
      headers: jsonHeaders(handle.origin, session),
      body: JSON.stringify({ callbackData: base64Url("ok"), path: "/tmp/secret" })
    });
    expect(extraCallbackField.status).toBe(400);
    expect(client.pressCallback).not.toHaveBeenCalled();

    client.callbackResult = {
      phone: LEAK_SENTINELS[0],
      session: LEAK_SENTINELS[1],
      apiHash: LEAK_SENTINELS[2],
      peer: LEAK_SENTINELS[3],
      message: LEAK_SENTINELS[4]
    };
    const validData = base64Url("ok");
    const callback = await fetch(callbackUrl, {
      method: "POST",
      headers: jsonHeaders(handle.origin, session),
      body: JSON.stringify({ callbackData: validData })
    });
    expect(callback.status).toBe(204);
    const callbackBody = await callback.text();
    for (const sentinel of LEAK_SENTINELS) expect(callbackBody).not.toContain(sentinel);
    expect(client.pressCallback).toHaveBeenCalledWith(91, validData);

    const generic = await fetch(`${handle.origin}/api/invoke`, {
      method: "POST",
      headers: jsonHeaders(handle.origin, session),
      body: JSON.stringify({ chatId: -1, method: "invoke", path: "/etc/passwd" })
    });
    expect(generic.status).toBe(404);
  });

  it("streams a validated binary upload without accepting a path or unsupported metadata", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const filename = "검증 보고서.pdf";
    const caption = "safe caption";
    const uploadUrl = `${handle.origin}/api/topics/42/files`;
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "application/pdf",
        "X-ChatKJB-File-Name": base64Url(filename),
        "X-ChatKJB-Caption": base64Url(caption)
      },
      body: bytes
    });
    expect(upload.status).toBe(204);
    expectSecurityHeaders(upload);
    expect(client.sendFile).toHaveBeenCalledOnce();
    const [topicId, input] = client.sendFile.mock.calls[0]!;
    expect(topicId).toBe(42);
    expect(input.name).toBe(filename);
    expect(input.mimeType).toBe("application/pdf");
    expect(input.caption).toBe(caption);
    expect(Buffer.from(input.bytes)).toEqual(Buffer.from(bytes));
    expect(Object.keys(input).sort()).toEqual(["bytes", "caption", "mimeType", "name"]);

    client.sendFile.mockClear();
    for (const invalid of [
      { name: "../secret.pdf", mime: "application/pdf", body: bytes, query: "" },
      { name: "secret.exe", mime: "application/x-msdownload", body: bytes, query: "" },
      { name: "safe.pdf", mime: "application/pdf", body: new Uint8Array(), query: "" },
      { name: "safe.pdf", mime: "application/pdf", body: bytes, query: "?path=/etc/passwd" }
    ]) {
      const response = await fetch(`${uploadUrl}${invalid.query}`, {
        method: "POST",
        headers: {
          Origin: handle.origin,
          Cookie: session.cookie,
          "X-ChatKJB-CSRF": session.csrf,
          "Content-Type": invalid.mime,
          "X-ChatKJB-File-Name": base64Url(invalid.name)
        },
        body: invalid.body
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    const malformedFilename = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "application/pdf",
        "X-ChatKJB-File-Name": "***not-base64url***"
      },
      body: bytes
    });
    expect(malformedFilename.status).toBe(400);
    expect(client.sendFile).not.toHaveBeenCalled();

    const oversized = await rawRequest(uploadUrl, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "application/pdf",
        "X-ChatKJB-File-Name": base64Url("safe.pdf"),
        "Content-Length": GUI_MAX_UPLOAD_BYTES + 1
      }
    });
    expect(oversized.status).toBe(413);
    expectRawSecurityHeaders(oversized.headers);
    expect(client.sendFile).not.toHaveBeenCalled();

    const exactBytes = new Uint8Array(GUI_MAX_UPLOAD_BYTES);
    const exact = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "application/pdf",
        "X-ChatKJB-File-Name": base64Url("exact-100-mib.pdf")
      },
      body: exactBytes
    });
    expect(exact.status).toBe(204);
    expect(client.sendFile).toHaveBeenCalledOnce();
    expect(client.sendFile.mock.calls[0]?.[1].bytes.byteLength).toBe(GUI_MAX_UPLOAD_BYTES);
    client.sendFile.mockClear();

  });

  it("allows one upload at a time and releases the slot after success and failure", async () => {
    const client = new FakeGuiServerClient();
    let releaseFirst!: () => void;
    client.sendFile.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    const { handle } = await startFixture({ client });
    const session = await authenticate(handle);
    const uploadUrl = `${handle.origin}/api/topics/42/files`;
    const upload = (name: string) => fetch(uploadUrl, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf,
        "Content-Type": "image/svg+xml",
        "X-ChatKJB-File-Name": base64Url(name)
      },
      body: Uint8Array.of(60, 115, 118, 103, 47, 62)
    });

    const first = upload("first.svg");
    await vi.waitFor(() => expect(client.sendFile).toHaveBeenCalledOnce());
    const concurrent = await upload("concurrent.svg");
    expect(concurrent.status).toBe(429);
    expect(await concurrent.json()).toEqual({ error: { code: "UPLOAD_IN_PROGRESS" } });
    releaseFirst();
    expect((await first).status).toBe(204);

    client.sendFile.mockRejectedValueOnce(new Error("Telegram failed"));
    expect((await upload("fails.svg")).status).toBe(502);
    client.sendFile.mockResolvedValueOnce(undefined);
    expect((await upload("after-failure.svg")).status).toBe(204);
    expect(client.sendFile).toHaveBeenCalledTimes(3);
  });

  it("projects only history authority invalidation as a stable 409 response", async () => {
    const client = new FakeGuiServerClient();
    const { handle, diagnostics } = await startFixture({ client });
    const session = await authenticate(handle);

    client.listTopics.mockRejectedValueOnce(new HistoryInvalidatedError());
    const invalidated = await fetch(`${handle.origin}/api/topics`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(invalidated.status).toBe(409);
    expect(await invalidated.json()).toEqual({ error: { code: "HISTORY_INVALIDATED" } });
    expect(diagnostics).toEqual([{ type: "request_rejected", code: "HISTORY_INVALIDATED" }]);

    client.listMessages.mockRejectedValueOnce(new Error("ordinary upstream failure"));
    const failed = await fetch(`${handle.origin}/api/topics/42/messages`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: { code: "TELEGRAM_OPERATION_FAILED" } });
    expect(diagnostics).toEqual([
      { type: "request_rejected", code: "HISTORY_INVALIDATED" },
      { type: "upstream_failure", code: "TELEGRAM_OPERATION_FAILED" },
      { type: "request_rejected", code: "TELEGRAM_OPERATION_FAILED" }
    ]);
  });
});

describe("GUI SSE reconciliation and isolated lifecycle", () => {
  it("aborts an in-flight attachment before web-session expiry can release bytes", async () => {
    let clock = 10_000;
    const client = new FakeGuiServerClient();
    let observedSignal: AbortSignal | undefined;
    client.downloadAttachment.mockImplementationOnce(async (_token, signal) => {
      observedSignal = signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      throw new Error("unreachable");
    });
    const { handle } = await startFixture({ client, now: () => clock });
    const session = await authenticate(handle);
    const downloading = fetch(`${handle.origin}/api/attachments/${"E".repeat(43)}`, {
      headers: readHeaders(handle.origin, session)
    });
    await vi.waitFor(() => expect(client.downloadAttachment).toHaveBeenCalledOnce());

    clock += 12 * 60 * 60 * 1_000;
    handle.publishUpdate({ type: "reconcile_required" });
    const response = await downloading;

    expect(observedSignal?.aborted).toBe(true);
    expect([401, 404]).toContain(response.status);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("ends an open SSE stream before publishing after the web session expires", async () => {
    let clock = 1_000;
    const { handle } = await startFixture({ now: () => clock });
    const session = await authenticate(handle);
    const stream = await SseConnection.open(handle.origin, session);
    await stream.nextFrame();

    clock += 12 * 60 * 60 * 1_000;
    handle.publishUpdate({ type: "message_upsert", message: message(91, "must not escape") });

    await stream.expectEnd();
    const stale = await fetch(`${handle.origin}/api/session`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(stale.status).toBe(401);
  });

  it("uses epoch event IDs, replays retained edit/delete updates, and reconciles invalid IDs", async () => {
    const { handle } = await startFixture();
    const session = await authenticate(handle);
    expect(session.epoch).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const first = await SseConnection.open(handle.origin, session);
    try {
      const initial = await first.nextFrame();
      expect(initial).toEqual({
        id: `${session.epoch}:0`,
        event: "reconcile_required",
        data: {
          type: "reconcile_required",
          reason: "snapshot_required",
          checkpointEventId: `${session.epoch}:0`
        }
      });

      handle.publishUpdate({ type: "message_upsert", message: message(91, "new") });
      const created = await first.nextFrame();
      expect(created.id).toBe(`${session.epoch}:1`);
      expect(created.event).toBe("update");
      expect(created.data).toEqual({ type: "message_upsert", message: message(91, "new") });
      await first.close();
      await waitForStreamCount(handle.origin, 0);

      handle.publishUpdate({
        type: "message_upsert",
        message: message(91, "edited", 1_700_000_001_000)
      });
      handle.publishUpdate({ type: "message_delete", topicId: 42, messageIds: [91] });

      const resumed = await SseConnection.open(handle.origin, session, created.id);
      try {
        const edited = await resumed.nextFrame();
        const deleted = await resumed.nextFrame();
        const reconciled = await resumed.nextFrame();
        expect(edited).toEqual({
          id: `${session.epoch}:2`,
          event: "update",
          data: {
            type: "message_upsert",
            message: message(91, "edited", 1_700_000_001_000)
          }
        });
        expect(deleted).toEqual({
          id: `${session.epoch}:3`,
          event: "update",
          data: { type: "message_delete", topicId: 42, messageIds: [91] }
        });
        expect(reconciled.data).toEqual({
          type: "reconcile_required",
          reason: "reconnected",
          checkpointEventId: `${session.epoch}:3`
        });
      } finally {
        await resumed.close();
      }

      for (const invalidId of ["not-an-event-id", `${"A".repeat(16)}:3`, `${session.epoch}:999`]) {
        const invalid = await SseConnection.open(handle.origin, session, invalidId);
        try {
          const frame = await invalid.nextFrame();
          expect(frame.event).toBe("reconcile_required");
          expect(frame.data).toEqual({
            type: "reconcile_required",
            reason: "snapshot_required",
            checkpointEventId: `${session.epoch}:3`
          });
        } finally {
          await invalid.close();
        }
      }
      await waitForStreamCount(handle.origin, 0);
    } finally {
      await first.close();
    }
  });

  it("projects SSE auth/update payloads and removes connections on close", async () => {
    const { handle } = await startFixture();
    const session = await authenticate(handle);
    const stream = await SseConnection.open(handle.origin, session);
    try {
      await stream.nextFrame();
      handle.publishAuthState({
        state: "waiting_password",
        passwordHint: LEAK_SENTINELS[0],
        errorCode: `INVALID ${LEAK_SENTINELS[1]}`
      } as GuiAuthState);
      const auth = await stream.nextFrame();
      expect(auth.data).toEqual({ type: "auth_state", auth: { state: "waiting_password" } });

      handle.publishUpdate({
        type: "message_upsert",
        message: {
          ...message(92, "safe update"),
          phone: LEAK_SENTINELS[0],
          session: LEAK_SENTINELS[1],
          apiHash: LEAK_SENTINELS[2],
          peer: LEAK_SENTINELS[3]
        } as GuiMessage
      });
      const update = await stream.nextFrame();
      const serialized = JSON.stringify(update);
      for (const sentinel of LEAK_SENTINELS) expect(serialized).not.toContain(sentinel);
      expect(update.data).toEqual({ type: "message_upsert", message: message(92, "safe update") });
    } finally {
      await stream.close();
    }
    await waitForStreamCount(handle.origin, 0);
  });

  it("logs out only through the authenticated endpoint and keeps handle.close transport-neutral", async () => {
    const { handle, client } = await startFixture();
    const session = await authenticate(handle);
    const healthBefore = await fetch(`${handle.origin}/healthz`);
    expect(healthBefore.status).toBe(200);
    expect(await healthBefore.json()).toEqual({ process: "ready", transport: "offline", streams: 0 });
    expectSecurityHeaders(healthBefore);

    handle.publishAuthState({
      state: "ready",
      passwordHint: LEAK_SENTINELS[0],
      errorCode: "LEAK_SESSION_SENTINEL"
    } as GuiAuthState);
    const healthReady = await fetch(`${handle.origin}/healthz`);
    expect(await healthReady.json()).toEqual({ process: "ready", transport: "online", streams: 0 });

    expect(client.logOut).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
    const logout = await fetch(`${handle.origin}/api/logout`, {
      method: "POST",
      headers: {
        Origin: handle.origin,
        Cookie: session.cookie,
        "X-ChatKJB-CSRF": session.csrf
      }
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toMatch(
      /^chatkjb_gui_[0-9a-f]{16}=; HttpOnly; SameSite=Strict; Path=\/; Max-Age=0$/
    );
    expect(client.logOut).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();

    const stale = await fetch(`${handle.origin}/api/session`, {
      headers: readHeaders(handle.origin, session)
    });
    expect(stale.status).toBe(401);

    await handle.close();
    expect(client.logOut).toHaveBeenCalledOnce();
    expect(client.stop).not.toHaveBeenCalled();
    await expect(fetch(`${handle.origin}/healthz`)).rejects.toThrow();
  });

  it("does not call stop or logout when the server handle closes without logout", async () => {
    const { handle, client } = await startFixture();
    await authenticate(handle);

    await handle.close();

    expect(client.logOut).not.toHaveBeenCalled();
    expect(client.stop).not.toHaveBeenCalled();
    await expect(fetch(`${handle.origin}/healthz`)).rejects.toThrow();
  });
});

describe("멈춘 Telegram 호출이 전송을 영구히 막지 않는다", () => {
  it("응답 없는 전송은 시간 상한 뒤 504로 끊고 동시 실행 슬롯을 반환한다", async () => {
    const client = new FakeGuiServerClient();
    // 절대 완료되지 않는 전송. 상한이 없으면 슬롯이 영구히 점유된다.
    const hung: Array<() => void> = [];
    client.sendText.mockImplementation(
      async () => new Promise<undefined>((resolve) => { hung.push(() => resolve(undefined)); })
    );
    const { handle, diagnostics } = await startFixture({ client, mutationTimeoutMs: 1_000 });
    const session = await authenticate(handle);
    const url = `${handle.origin}/api/topics/42/messages`;
    const send = () => fetch(url, {
      method: "POST",
      headers: jsonHeaders(handle.origin, session),
      body: JSON.stringify({ text: "hung send" })
    });

    // MAX_IN_FLIGHT_MUTATIONS(8)를 넘겨 슬롯을 모두 채운다.
    const pending = Array.from({ length: 8 }, () => send());
    const timedOut = await Promise.all(pending);
    for (const response of timedOut) {
      expect(response.status).toBe(504);
      expect(await response.text()).toContain("TELEGRAM_OPERATION_TIMEOUT");
    }
    expect(diagnostics.some((entry) => entry.code === "TELEGRAM_OPERATION_TIMEOUT")).toBe(true);

    // 슬롯이 반환되었으므로 이후 정상 전송이 다시 가능해야 한다.
    client.sendText.mockImplementation(async () => undefined);
    const recovered = await send();
    expect(recovered.status).toBe(204);

    for (const resolve of hung) resolve();
  });

  it("시간 상한은 1초에서 300초 사이만 허용한다", async () => {
    const client = new FakeGuiServerClient();
    await expect(startGuiServer({ client, mutationTimeoutMs: 999 })).rejects.toThrow(
      "mutationTimeoutMs must be an integer from 1000 to 300000"
    );
    await expect(startGuiServer({ client, mutationTimeoutMs: 300_001 })).rejects.toThrow(
      "mutationTimeoutMs must be an integer from 1000 to 300000"
    );
  });
});
