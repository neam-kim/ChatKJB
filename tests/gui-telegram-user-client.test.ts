import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GENERAL_TOPIC_ID,
  safeHttpUrl,
  type GuiAuthState,
  type GuiTelegramUpdate,
  type HistoryCursor
} from "../src/gui/protocol.js";
import {
  GUI_ALLOWED_UPLOAD_MIME_TYPES,
  GUI_MAX_UPLOAD_BYTES,
  MAX_SUPPORTED_UPLOAD_PARTS,
  ReadConfirmationPendingError,
  TelegramUserClient,
  validateTelegramUploadMetadata,
  type ResolvedForumPeer,
  type TelegramUploadInput,
  type TelegramUserAdapter,
  type TelegramUserIdentity
} from "../src/gui/telegram-user-client.js";
import { readTelegramSession, writeTelegramSession } from "../src/gui/telegram-session.js";

const CHAT_ID = -1_000_000_000_123;
const API_HASH = "0123456789abcdef0123456789abcdef";
const directories: string[] = [];
const REPLY_PANEL_ROWS = [
  ["\u2699\ufe0f \uc0c8 \uc138\uc158 \uae30\ubcf8\uac12", "\ud83e\udde0 \ubaa8\ub378: GPT-5.6-Sol"],
  ["\ud83e\udd16 \uc81c\uacf5\uc790: Codex", "\ud83d\udcad \ucd94\ub860: \ub9e4\uc6b0 \ub192\uc74c (xHigh)"],
  ["\u2796", "\ud83d\udd11 \ud1a0\ud070: #3"]
] as const;

function replyKeyboardMarkup(rows: readonly (readonly string[])[] = REPLY_PANEL_ROWS): unknown {
  return {
    className: "ReplyKeyboardMarkup",
    rows: rows.map((buttons) => ({
      className: "KeyboardButtonRow",
      buttons: buttons.map((text) => ({ className: "KeyboardButton", text }))
    }))
  };
}

function temporarySessionPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-client-"));
  directories.push(directory);
  return join(directory, "user.session");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function topicResult() {
  return {
    topics: [
      {
        className: "ForumTopic",
        id: GENERAL_TOPIC_ID,
        title: "General",
        topMessage: 11,
        unreadCount: 1,
        pinned: true
      },
      {
        className: "ForumTopic",
        id: 42,
        title: "프로젝트 작업",
        topMessage: 90,
        unreadCount: 2
      },
      { className: "ForumTopicDeleted", id: 77 }
    ],
    messages: [
      { id: 11, date: 100 },
      { id: 90, date: 200 }
    ]
  };
}

function topicReadReceipt(input: {
  topicId: number;
  topMessageId: number;
  readInboxMaxId: number;
  unreadCount: number;
}): unknown {
  return {
    topics: [{
      className: "ForumTopic",
      id: input.topicId,
      topMessage: input.topMessageId,
      readInboxMaxId: input.readInboxMaxId,
      unreadCount: input.unreadCount
    }]
  };
}

function appConfig(defaultParts = 4_000, premiumParts = 8_000): unknown {
  return {
    className: "help.AppConfig",
    config: {
      className: "JsonObject",
      value: [
        {
          className: "JsonObjectValue",
          key: "upload_max_fileparts_default",
          value: { className: "JsonNumber", value: defaultParts }
        },
        {
          className: "JsonObjectValue",
          key: "upload_max_fileparts_premium",
          value: { className: "JsonNumber", value: premiumParts }
        }
      ]
    }
  };
}

function temporaryUpload(bytes: Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-upload-client-"));
  directories.push(directory);
  const path = join(directory, "payload");
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

function rawMessage(input: {
  id: number;
  text: string;
  channelId?: number;
  topicId?: number;
  editDate?: number;
  callback?: { data: string; requiresPassword?: boolean; };
  replyMarkup?: unknown;
  entities?: unknown[];
  media?: unknown;
  outgoing?: boolean;
}) {
  return {
    className: "Message",
    id: input.id,
    date: 1_700_000_000,
    message: input.text,
    peerId: { className: "PeerChannel", channelId: input.channelId ?? 123 },
    ...(input.topicId === undefined
      ? {}
      : { replyTo: { forumTopic: true, replyToMsgId: input.topicId } }),
    ...(input.editDate === undefined ? {} : { editDate: input.editDate }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
    ...(input.media === undefined ? {} : { media: input.media }),
    ...(input.outgoing === undefined ? {} : { out: input.outgoing }),
    ...(input.replyMarkup !== undefined
      ? { replyMarkup: input.replyMarkup }
      : input.callback
      ? {
          replyMarkup: {
            rows: [{
              buttons: [{
                className: "KeyboardButtonCallback",
                text: "선택",
                data: Buffer.from(input.callback.data),
                ...(input.callback.requiresPassword ? { requiresPassword: true } : {})
              }]
            }]
          }
        }
      : {})
  };
}

class FakeAdapter implements TelegramUserAdapter {
  authorized = true;
  identity: TelegramUserIdentity = { id: "123456", bot: false, premium: false };
  resolved: ResolvedForumPeer = { peer: { fixed: true }, forum: true, megagroup: true };
  savedSession = "saved-user-session";
  rawHandler: ((update: unknown) => void) | null = null;
  qrLogin: ((callbacks: Parameters<TelegramUserAdapter["signInWithQrCode"]>[0]) => Promise<TelegramUserIdentity>) | null = null;
  forumTopics: unknown = topicResult();
  generalHistory: unknown = { messages: [] };
  topicHistory: unknown = { messages: [] };
  onConnect: (() => void) | null = null;

  readonly connect = vi.fn(async () => {
    this.onConnect?.();
  });
  readonly checkAuthorization = vi.fn(async () => this.authorized);
  readonly getMe = vi.fn(async () => this.identity);
  readonly getAppConfig = vi.fn(async () => appConfig());
  readonly resolveForumPeer = vi.fn(async () => this.resolved);
  readonly getForumTopics = vi.fn(async () => this.forumTopics);
  readonly getForumTopicsById = vi.fn(async (_peer: unknown, topicIds: readonly number[]): Promise<unknown> => ({
    topics: topicIds.map((topicId) => ({
      className: "ForumTopic",
      id: topicId,
      topMessage: topicId === GENERAL_TOPIC_ID ? 10 : 92,
      readInboxMaxId: topicId === GENERAL_TOPIC_ID ? 10 : 92,
      unreadCount: 0
    }))
  }));
  readonly getGeneralHistory = vi.fn(async (
    _peer: unknown,
    _cursor: HistoryCursor,
    _limit: number
  ) => this.generalHistory);
  readonly getTopicHistory = vi.fn(async () => this.topicHistory);
  readonly sendText = vi.fn(async (
    _peer: unknown,
    _input: { text: string; replyToMessageId?: number; topMessageId?: number; }
  ) => ({}));
  readonly sendFile = vi.fn(async (
    _peer: unknown,
    _input: Parameters<TelegramUserAdapter["sendFile"]>[1]
  ) => ({}));
  readonly interruptUploadTransport = vi.fn(async () => undefined);
  readonly downloadMedia = vi.fn(async () => Uint8Array.from([1, 2, 3]));
  readonly pressCallback = vi.fn(async () => ({ message: "ok" }));
  readonly markGeneralRead = vi.fn(async () => undefined);
  readonly markTopicRead = vi.fn(async () => undefined);
  readonly setTyping = vi.fn(async () => undefined);
  readonly catchUp = vi.fn(async () => undefined);
  readonly logOut = vi.fn(async () => undefined);
  readonly disconnect = vi.fn(async () => undefined);

  async signInWithQrCode(callbacks: Parameters<TelegramUserAdapter["signInWithQrCode"]>[0]) {
    if (!this.qrLogin) throw new Error("qrLogin not configured");
    const identity = await this.qrLogin(callbacks);
    this.authorized = true;
    return identity;
  }

  saveSession(): string {
    return this.savedSession;
  }

  addRawUpdateHandler(handler: (update: unknown) => void): void {
    this.rawHandler = handler;
  }

  emit(update: unknown): void {
    this.rawHandler?.(update);
  }
}

function setup(adapter = new FakeAdapter(), options: {
  sessionPath?: string;
  onAuthState?: (state: GuiAuthState) => void;
  onQrCode?: (token: Uint8Array, expiresAt: number) => void;
  onUpdate?: (update: GuiTelegramUpdate) => void;
  allowedUserIds?: number[];
  adapterFactory?: (storedSession: string) => Promise<TelegramUserAdapter>;
} = {}) {
  const client = new TelegramUserClient({
    apiId: 12345,
    apiHash: API_HASH,
    chatId: CHAT_ID,
    allowedUserIds: options.allowedUserIds ?? [123456],
    sessionPath: options.sessionPath ?? temporarySessionPath(),
    adapterFactory: options.adapterFactory ?? (async () => adapter),
    ...(options.onAuthState ? { onAuthState: options.onAuthState } : {}),
    ...(options.onQrCode ? { onQrCode: options.onQrCode } : {}),
    ...(options.onUpdate ? { onUpdate: options.onUpdate } : {})
  });
  return { client, adapter };
}

describe("TelegramUserClient authorization", () => {
  it("runs concurrent start calls through one adapter factory", async () => {
    const adapter = new FakeAdapter();
    let releaseAdapter!: (value: TelegramUserAdapter) => void;
    const factory = vi.fn(async () => await new Promise<TelegramUserAdapter>((resolve) => {
      releaseAdapter = resolve;
    }));
    const { client } = setup(adapter, { adapterFactory: factory });

    const first = client.start();
    const second = client.start();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    releaseAdapter(adapter);

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(adapter.connect).toHaveBeenCalledOnce();
    await client.stop();
  });

  it("does not resurrect a delayed start after stop or logout", async () => {
    for (const close of ["stop", "logOut"] as const) {
      const states: GuiAuthState[] = [];
      const adapter = new FakeAdapter();
      let releaseAdapter!: (value: TelegramUserAdapter) => void;
      const factory = vi.fn(async () => await new Promise<TelegramUserAdapter>((resolve) => {
        releaseAdapter = resolve;
      }));
      const { client } = setup(adapter, {
        adapterFactory: factory,
        onAuthState: (state) => states.push(state)
      });

      const starting = client.start();
      await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
      const closing = client[close]();
      await expect(client.start()).rejects.toThrow(/stopping/);
      await expect(client.beginQrLogin()).rejects.toThrow(/stopping/);
      releaseAdapter(adapter);

      await expect(Promise.all([starting, closing])).resolves.toEqual([undefined, undefined]);
      expect(states.some((state) => state.state === "ready")).toBe(false);
      expect(adapter.connect).toHaveBeenCalledTimes(close === "logOut" ? 1 : 0);
      expect(adapter.logOut).toHaveBeenCalledTimes(close === "logOut" ? 1 : 0);
      expect(adapter.disconnect).toHaveBeenCalledOnce();
    }
  });

  it("revokes an existing server session when logout interrupts start catch-up", async () => {
    const states: GuiAuthState[] = [];
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "existing-session");
    const adapter = new FakeAdapter();
    let releaseCatchUp!: (value: undefined) => void;
    adapter.catchUp.mockImplementationOnce(async () => await new Promise<undefined>((resolve) => {
      releaseCatchUp = resolve;
    }));
    const { client } = setup(adapter, {
      sessionPath,
      onAuthState: (state) => states.push(state)
    });

    const starting = client.start();
    await vi.waitFor(() => expect(adapter.catchUp).toHaveBeenCalledOnce());
    const loggingOut = client.logOut();
    releaseCatchUp(undefined);

    await expect(Promise.all([starting, loggingOut])).resolves.toEqual([undefined, undefined]);
    expect(states.some((state) => state.state === "ready")).toBe(false);
    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("revokes an existing session when logout interrupts QR-path reauthorization", async () => {
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "existing-session");
    const adapter = new FakeAdapter();
    const { client } = setup(adapter, { sessionPath });
    await client.start();
    let releaseCatchUp!: (value: undefined) => void;
    adapter.catchUp.mockImplementationOnce(async () => await new Promise<undefined>((resolve) => {
      releaseCatchUp = resolve;
    }));

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(adapter.catchUp).toHaveBeenCalledTimes(2));
    const loggingOut = client.logOut();
    releaseCatchUp(undefined);

    await expect(Promise.all([login, loggingOut])).resolves.toEqual([undefined, undefined]);
    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("does not silently downgrade logout while a stop is in progress", async () => {
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "preserve-on-stop");
    const adapter = new FakeAdapter();
    let releaseDisconnect!: (value: undefined) => void;
    adapter.disconnect.mockImplementationOnce(async () => await new Promise<undefined>((resolve) => {
      releaseDisconnect = resolve;
    }));
    const { client } = setup(adapter, { sessionPath });
    await client.start();

    const stopping = client.stop();
    await vi.waitFor(() => expect(adapter.disconnect).toHaveBeenCalledOnce());
    await expect(client.logOut()).rejects.toThrow(/retry logout/);
    releaseDisconnect(undefined);

    await expect(stopping).resolves.toBeUndefined();
    expect(adapter.logOut).not.toHaveBeenCalled();
    expect(await readTelegramSession(sessionPath)).toBe("preserve-on-stop");
  });

  it("reconnects and revokes after logout is retried once a stop completes", async () => {
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "preserve-on-stop");
    const firstAdapter = new FakeAdapter();
    const retryAdapter = new FakeAdapter();
    let releaseDisconnect!: (value: undefined) => void;
    firstAdapter.disconnect.mockImplementationOnce(async () => await new Promise<undefined>((resolve) => {
      releaseDisconnect = resolve;
    }));
    const factory = vi.fn(async () => factory.mock.calls.length === 1 ? firstAdapter : retryAdapter);
    const { client } = setup(firstAdapter, { sessionPath, adapterFactory: factory });
    await client.start();

    const stopping = client.stop();
    await vi.waitFor(() => expect(firstAdapter.disconnect).toHaveBeenCalledOnce());
    await expect(client.logOut()).rejects.toThrow(/retry logout/);
    releaseDisconnect(undefined);
    await stopping;
    await expect(client.logOut()).resolves.toBeUndefined();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstAdapter.logOut).not.toHaveBeenCalled();
    expect(retryAdapter.connect).toHaveBeenCalledOnce();
    expect(retryAdapter.logOut).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("preserves the local session when Telegram server logout fails", async () => {
    const states: GuiAuthState[] = [];
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "retryable-session");
    const adapter = new FakeAdapter();
    adapter.logOut.mockRejectedValueOnce(new Error("server logout failed"));
    const { client } = setup(adapter, {
      sessionPath,
      onAuthState: (state) => states.push(state)
    });
    await client.start();

    await expect(client.logOut()).rejects.toThrow(/server logout failed/);

    expect(await readTelegramSession(sessionPath)).toBe("retryable-session");
    expect(states.at(-1)).toEqual({ state: "error", errorCode: "TELEGRAM_LOGOUT_FAILED" });
  });

  it("reconnects the preserved session before a failed server logout is retried", async () => {
    const states: GuiAuthState[] = [];
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "retryable-session");
    const firstAdapter = new FakeAdapter();
    firstAdapter.logOut.mockRejectedValueOnce(new Error("server logout failed"));
    const retryAdapter = new FakeAdapter();
    const factory = vi.fn(async (storedSession: string) => {
      expect(storedSession).toBe("retryable-session");
      return factory.mock.calls.length === 1 ? firstAdapter : retryAdapter;
    });
    const { client } = setup(firstAdapter, {
      sessionPath,
      adapterFactory: factory,
      onAuthState: (state) => states.push(state)
    });
    await client.start();

    await expect(client.logOut()).rejects.toThrow(/server logout failed/);
    expect(await readTelegramSession(sessionPath)).toBe("retryable-session");
    await expect(client.logOut()).resolves.toBeUndefined();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(retryAdapter.connect).toHaveBeenCalledOnce();
    expect(retryAdapter.checkAuthorization).toHaveBeenCalledOnce();
    expect(retryAdapter.logOut).toHaveBeenCalledOnce();
    expect(retryAdapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
    expect(states.at(-1)).toEqual({ state: "signed_out" });
  });

  it("accepts only an allowed non-bot account and resolves the fixed forum", async () => {
    const states: GuiAuthState[] = [];
    const { client, adapter } = setup(undefined, { onAuthState: (state) => states.push(state) });

    await client.start();

    expect(adapter.connect).toHaveBeenCalledOnce();
    expect(adapter.resolveForumPeer).toHaveBeenCalledWith(CHAT_ID);
    expect(adapter.catchUp).toHaveBeenCalledOnce();
    expect(states.map((state) => state.state)).toEqual(["connecting", "ready"]);
    await client.stop();
  });

  it("fails closed for a bot, a different account, and a non-forum target", async () => {
    for (const mutate of [
      (adapter: FakeAdapter) => { adapter.identity = { id: "123456", bot: true, premium: false }; },
      (adapter: FakeAdapter) => { adapter.identity = { id: "999999", bot: false, premium: false }; },
      (adapter: FakeAdapter) => { adapter.resolved = { peer: {}, forum: false, megagroup: true }; }
    ]) {
      const adapter = new FakeAdapter();
      mutate(adapter);
      const { client } = setup(adapter);
      await expect(client.start()).rejects.toThrow(/authorized|forum supergroup/);
      await client.stop().catch(() => undefined);
    }
  });

  it("runs QR and deferred 2FA without putting the token or password in auth state", async () => {
    const states: GuiAuthState[] = [];
    const qrCodes: Array<{ token: string; expiresAt: number; }> = [];
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.qrLogin = async (callbacks) => {
      await callbacks.onQrCode(Buffer.from("private-qr-token"), 123_000);
      const password = await callbacks.onPassword("hint-only");
      expect(password).toBe("private-password");
      return adapter.identity;
    };
    const sessionPath = temporarySessionPath();
    const { client } = setup(adapter, {
      sessionPath,
      onAuthState: (state) => states.push(state),
      onQrCode: (token, expiresAt) => qrCodes.push({ token: Buffer.from(token).toString(), expiresAt })
    });
    await client.start();

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_password"));
    client.submitPassword("private-password");
    await login;

    expect(qrCodes).toEqual([{ token: "private-qr-token", expiresAt: 123_000 }]);
    expect(JSON.stringify(states)).not.toContain("private-qr-token");
    expect(JSON.stringify(states)).not.toContain("private-password");
    expect(await readTelegramSession(sessionPath)).toBe("saved-user-session");
    expect(states.at(-1)).toEqual({ state: "ready" });
    await client.stop();
  });

  it("settles a pending 2FA login when the user cancels", async () => {
    const states: GuiAuthState[] = [];
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.qrLogin = async (callbacks) => {
      await callbacks.onPassword("cancel-me");
      return adapter.identity;
    };
    const { client } = setup(adapter, { onAuthState: (state) => states.push(state) });
    await client.start();

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_password"));
    client.cancelLogin();

    await expect(login).resolves.toBeUndefined();
    expect(states.at(-1)).toEqual({ state: "signed_out" });
    await client.stop();
  });

  it("rejects a concurrent QR login instead of racing adapter cleanup", async () => {
    const states: GuiAuthState[] = [];
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    let attempts = 0;
    adapter.qrLogin = async (callbacks) => {
      attempts += 1;
      await callbacks.onPassword("single-flight");
      return adapter.identity;
    };
    const { client } = setup(adapter, { onAuthState: (state) => states.push(state) });
    await client.start();

    const first = client.beginQrLogin();
    await vi.waitFor(() => expect(states.at(-1)?.state).toBe("waiting_password"));
    await expect(client.beginQrLogin()).rejects.toThrow(/already in progress/);
    expect(attempts).toBe(1);

    client.cancelLogin();
    await expect(first).resolves.toBeUndefined();
    await client.stop();
  });

  it("cancels before QR starts when authorization status is still pending", async () => {
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    let releaseAuthorization!: (authorized: boolean) => void;
    adapter.qrLogin = vi.fn(async () => adapter.identity);
    const { client } = setup(adapter);
    await client.start();
    adapter.checkAuthorization.mockImplementationOnce(async () => await new Promise<boolean>((resolve) => {
      releaseAuthorization = resolve;
    }));

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(adapter.checkAuthorization).toHaveBeenCalledTimes(2));
    const stopping = client.stop();
    releaseAuthorization(false);

    await expect(Promise.all([login, stopping])).resolves.toEqual([undefined, undefined]);
    expect(adapter.qrLogin).not.toHaveBeenCalled();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
  });

  it("revokes a QR session cancelled while forum authorization is still finishing", async () => {
    const states: GuiAuthState[] = [];
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.qrLogin = async () => adapter.identity;
    let releasePeer!: (peer: ResolvedForumPeer) => void;
    adapter.resolveForumPeer.mockImplementationOnce(async () => await new Promise<ResolvedForumPeer>((resolve) => {
      releasePeer = resolve;
    }));
    const sessionPath = temporarySessionPath();
    const { client } = setup(adapter, {
      sessionPath,
      onAuthState: (state) => states.push(state)
    });
    await client.start();

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(adapter.resolveForumPeer).toHaveBeenCalledOnce());
    client.cancelLogin();
    releasePeer(adapter.resolved);

    await expect(login).resolves.toBeUndefined();
    expect(states.some((state) => state.state === "ready")).toBe(false);
    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("waits for ephemeral QR revocation when stopped during forum authorization", async () => {
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.qrLogin = async () => adapter.identity;
    let releasePeer!: (peer: ResolvedForumPeer) => void;
    adapter.resolveForumPeer.mockImplementationOnce(async () => await new Promise<ResolvedForumPeer>((resolve) => {
      releasePeer = resolve;
    }));
    const sessionPath = temporarySessionPath();
    const { client } = setup(adapter, { sessionPath });
    await client.start();

    const login = client.beginQrLogin();
    await vi.waitFor(() => expect(adapter.resolveForumPeer).toHaveBeenCalledOnce());
    const stopping = client.stop();
    releasePeer(adapter.resolved);

    await expect(login).resolves.toBeUndefined();
    await expect(stopping).resolves.toBeUndefined();
    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("revokes a new QR session when the configured forum fails validation", async () => {
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.qrLogin = async () => adapter.identity;
    adapter.resolved = { peer: {}, forum: false, megagroup: true };
    const sessionPath = temporarySessionPath();
    const { client } = setup(adapter, { sessionPath });
    await client.start();

    await expect(client.beginQrLogin()).rejects.toThrow(/forum supergroup/);

    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("preserves the pre-revoke QR snapshot when authorization probes false during cleanup", async () => {
    const adapter = new FakeAdapter();
    adapter.authorized = false;
    adapter.checkAuthorization
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    adapter.qrLogin = async () => adapter.identity;
    adapter.resolved = { peer: {}, forum: false, megagroup: true };
    adapter.savedSession = "qr-retry-session";
    adapter.logOut.mockImplementationOnce(async () => {
      adapter.savedSession = "";
      return false as never;
    });
    const sessionPath = temporarySessionPath();
    const { client } = setup(adapter, { sessionPath });
    await client.start();

    await expect(client.beginQrLogin()).rejects.toThrow(/did not revoke/);

    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("qr-retry-session");
  });

  it("revokes a rejected account and removes its local session", async () => {
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "rejected-session");
    const adapter = new FakeAdapter();
    adapter.identity = { id: "999999", bot: false, premium: false };
    const { client } = setup(adapter, { sessionPath });

    await expect(client.start()).rejects.toThrow(/not authorized/);

    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });

  it("preserves a retry session when rejected-account revocation fails", async () => {
    for (const failure of ["exception", "false"] as const) {
      const sessionPath = temporarySessionPath();
      await writeTelegramSession(sessionPath, "rejected-session");
      const adapter = new FakeAdapter();
      adapter.identity = { id: "999999", bot: false, premium: false };
      if (failure === "exception") {
        adapter.logOut.mockImplementationOnce(async () => {
          adapter.savedSession = "";
          throw new Error("logout unavailable");
        });
      } else {
        adapter.logOut.mockImplementationOnce(async () => {
          adapter.savedSession = "";
          return false as never;
        });
      }
      const { client } = setup(adapter, { sessionPath });

      await expect(client.start()).rejects.toThrow(/logout unavailable|did not revoke/);

      expect(adapter.disconnect).toHaveBeenCalledOnce();
      expect(await readTelegramSession(sessionPath)).toBe("saved-user-session");
    }
  });

  it("does not publish raw updates before account and forum scope authorization", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const adapter = new FakeAdapter();
    adapter.identity = { id: "999999", bot: false, premium: false };
    adapter.onConnect = () => {
      adapter.emit({
        className: "UpdateNewChannelMessage",
        message: rawMessage({ id: 92, text: "must stay private", topicId: 42 })
      });
    };
    const { client } = setup(adapter, { onUpdate: (update) => updates.push(update) });

    await expect(client.start()).rejects.toThrow(/not authorized/);

    expect(updates).toEqual([]);
  });

  it("publishes ready only after catch-up and session persistence succeed", async () => {
    const catchUpStates: GuiAuthState[] = [];
    const catchUpAdapter = new FakeAdapter();
    catchUpAdapter.catchUp.mockRejectedValueOnce(new Error("catch-up failed"));
    const { client: catchUpClient } = setup(catchUpAdapter, {
      onAuthState: (state) => catchUpStates.push(state)
    });

    await expect(catchUpClient.start()).rejects.toThrow(/catch-up failed/);
    expect(catchUpStates.some((state) => state.state === "ready")).toBe(false);
    await expect(catchUpClient.sendText(1, "blocked")).rejects.toThrow(/not authorized and ready/);
    expect(catchUpAdapter.disconnect).toHaveBeenCalledOnce();

    const persistStates: GuiAuthState[] = [];
    const persistAdapter = new FakeAdapter();
    persistAdapter.authorized = false;
    persistAdapter.savedSession = "";
    persistAdapter.qrLogin = async () => persistAdapter.identity;
    const { client: persistClient } = setup(persistAdapter, {
      onAuthState: (state) => persistStates.push(state)
    });
    await persistClient.start();

    await expect(persistClient.beginQrLogin()).rejects.toThrow(/persistent session/);
    expect(persistStates.some((state) => state.state === "ready")).toBe(false);
    await expect(persistClient.sendText(1, "blocked")).rejects.toThrow(/not authorized and ready/);
    expect(persistAdapter.disconnect).toHaveBeenCalledOnce();
  });

  it("rejects malformed allowed-user identifiers at the configuration boundary", () => {
    expect(() => setup(undefined, { allowedUserIds: [0] })).toThrow(/allowedUserId/);
    expect(() => setup(undefined, { allowedUserIds: [Number.NaN] })).toThrow(/allowedUserId/);
  });
});

describe("TelegramUserClient forum scope and actions", () => {
  it("allowlists UTF-16 text entities and opaque fixed-message attachments", async () => {
    const adapter = new FakeAdapter();
    const text = "한😀 code\nblock https://example.com";
    adapter.topicHistory = {
      messages: [rawMessage({
        id: 92,
        text,
        topicId: 42,
        entities: [
          { className: "MessageEntityCode", offset: 4, length: 4 },
          { className: "MessageEntityPre", offset: 9, length: 5, language: "text" },
          { className: "MessageEntityUrl", offset: 15, length: 19 },
          { className: "MessageEntityPhone", offset: 0, length: 1 },
          { className: "MessageEntityPre", offset: -1, length: 2, language: "<script>" }
        ],
        media: {
          className: "MessageMediaPhoto",
          photo: {
            className: "Photo",
            sizes: [{ className: "PhotoSize", w: 800, h: 600, size: 2048 }]
          }
        }
      })]
    };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();

    const [normalized] = (await client.listMessages(42)).messages;
    expect(normalized?.entities).toEqual([
      { kind: "code", offset: 4, length: 4 },
      { kind: "pre", offset: 9, length: 5, language: "text" },
      { kind: "url", offset: 15, length: 19, url: "https://example.com/" }
    ]);
    expect(normalized?.attachment).toMatchObject({
      kind: "image",
      name: "photo-92.jpg",
      filenameSource: "generated",
      mimeType: "image/jpeg",
      size: 2048,
      width: 800,
      height: 600
    });
    expect(normalized?.attachment?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(normalized)).not.toContain("accessHash");
    expect(JSON.stringify(normalized)).not.toContain("fileReference");

    const downloaded = await client.downloadAttachment(normalized!.attachment!.token!);
    expect(downloaded).toEqual({
      kind: "image",
      name: "photo-92.jpg",
      mimeType: "image/jpeg",
      bytes: Uint8Array.from([1, 2, 3])
    });
    expect(adapter.downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ id: 92 }),
      20 * 1024 * 1024,
      undefined
    );
    await expect(client.downloadAttachment("A".repeat(43))).rejects.toThrow(/attachment/);
    await client.stop();
  });

  it("preserves attachment identity independent from the bounded download token", async () => {
    const adapter = new FakeAdapter();
    adapter.topicHistory = {
      messages: [
        rawMessage({
          id: 101,
          text: "safe raster document",
          topicId: 42,
          media: {
            className: "MessageMediaDocument",
            document: {
              className: "Document",
              id: "101",
              size: 4096,
              mimeType: "image/png",
              attributes: [
                { className: "DocumentAttributeFilename", fileName: "diagram.png" },
                { className: "DocumentAttributeImageSize", w: 640, h: 480 }
              ]
            }
          }
        }),
        rawMessage({
          id: 102,
          text: "sanitized",
          topicId: 42,
          media: {
            className: "MessageMediaDocument",
            document: {
              className: "Document",
              id: "102",
              size: 20 * 1024 * 1024 + 1,
              mimeType: "application/pdf",
              attributes: [{ className: "DocumentAttributeFilename", fileName: "../secret\u202ereport.pdf" }]
            }
          }
        }),
        rawMessage({
          id: 103,
          text: "missing name",
          topicId: 42,
          media: {
            className: "MessageMediaDocument",
            document: {
              className: "Document",
              id: "103",
              size: 512,
              mimeType: "application/octet-stream",
              attributes: []
            }
          }
        })
      ]
    };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();

    const messages = (await client.listMessages(42)).messages;
    expect(messages[0]?.attachment).toMatchObject({
      kind: "image",
      name: "diagram.png",
      filenameSource: "telegram",
      mimeType: "image/png",
      size: 4096,
      width: 640,
      height: 480
    });
    expect(messages[0]?.attachment?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(messages[1]?.attachment).toEqual({
      kind: "document",
      name: ".._secret_report.pdf",
      filenameSource: "sanitized",
      mimeType: "application/pdf",
      size: 20 * 1024 * 1024 + 1
    });
    expect(JSON.stringify(messages[1])).not.toContain("../secret");
    expect(messages[2]?.attachment).toMatchObject({
      kind: "document",
      name: "document-103.bin",
      filenameSource: "generated",
      mimeType: "application/octet-stream",
      size: 512
    });
    expect(messages[2]?.attachment?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await client.stop();
  });

  it("rotates and revokes attachment authority on edit, delete, and reconciliation", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const adapter = new FakeAdapter();
    const attachmentMessage = (editDate?: number, id = 92) => rawMessage({
      id,
      text: "attachment",
      topicId: 42,
      ...(editDate === undefined ? {} : { editDate }),
      media: {
        className: "MessageMediaPhoto",
        photo: {
          className: "Photo",
          id: "media-id-sentinel",
          accessHash: "ACCESS_HASH_SENTINEL",
          fileReference: "FILE_REFERENCE_SENTINEL",
          sizes: [{ className: "PhotoSize", w: 640, h: 480, size: 1024 }]
        }
      }
    });
    adapter.topicHistory = { messages: [attachmentMessage()] };
    const { client } = setup(adapter, { onUpdate: (update) => updates.push(update) });
    await client.start();
    await client.listTopics();
    const first = (await client.listMessages(42)).messages[0]!.attachment!.token!;
    const repeated = (await client.listMessages(42)).messages[0]!.attachment!.token!;
    expect(repeated).toBe(first);

    adapter.emit({ className: "UpdateEditChannelMessage", message: attachmentMessage(1_700_000_001) });
    const edited = updates.findLast((update) => update.type === "message_upsert");
    expect(edited?.type).toBe("message_upsert");
    const second = edited?.type === "message_upsert" ? edited.message.attachment?.token : undefined;
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    await expect(client.downloadAttachment(first)).rejects.toThrow(/not available/);
    await expect(client.downloadAttachment(second!)).resolves.toMatchObject({ name: "photo-92.jpg" });

    adapter.emit({ className: "UpdateDeleteChannelMessages", channelId: 123, messages: [92] });
    await expect(client.downloadAttachment(second!)).rejects.toThrow(/not available/);

    adapter.topicHistory = { messages: [attachmentMessage(1_700_000_002, 93)] };
    const third = (await client.listMessages(42)).messages[0]!.attachment!.token!;
    adapter.emit({ className: "ChatKjbConnectionRestored" });
    await expect(client.downloadAttachment(third)).rejects.toThrow(/not available/);
    await client.stop();
  });

  it("merges known live edits and deletes into delayed history but rejects authority invalidation", async () => {
    const adapter = new FakeAdapter();
    const attachment = (editDate?: number) => rawMessage({
      id: 92,
      text: "attachment",
      topicId: 42,
      ...(editDate === undefined ? {} : { editDate }),
      media: {
        className: "MessageMediaPhoto",
        photo: {
          className: "Photo",
          id: editDate === undefined ? "old-media" : "new-media",
          sizes: [{ className: "PhotoSize", w: 32, h: 32, size: 128 }]
        }
      }
    });
    adapter.topicHistory = { messages: [attachment()] };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const oldToken = (await client.listMessages(42)).messages[0]!.attachment!.token!;

    let releaseEdit!: (value: unknown) => void;
    adapter.getTopicHistory.mockImplementationOnce(async () => await new Promise((resolve) => {
      releaseEdit = resolve;
    }));
    const staleEdit = client.listMessages(42);
    await vi.waitFor(() => expect(adapter.getTopicHistory).toHaveBeenCalledTimes(2));
    adapter.emit({ className: "UpdateEditChannelMessage", message: attachment(1_700_000_001) });
    releaseEdit({ messages: [attachment()] });
    await expect(staleEdit).resolves.toMatchObject({ messages: [] });
    await expect(client.downloadAttachment(oldToken)).rejects.toThrow(/not available/);

    let releaseDelete!: (value: unknown) => void;
    adapter.getTopicHistory.mockImplementationOnce(async () => await new Promise((resolve) => {
      releaseDelete = resolve;
    }));
    const staleDelete = client.listMessages(42);
    await vi.waitFor(() => expect(adapter.getTopicHistory).toHaveBeenCalledTimes(3));
    adapter.emit({ className: "UpdateDeleteChannelMessages", channelId: 123, messages: [92] });
    releaseDelete({ messages: [attachment(1_700_000_001)] });
    await expect(staleDelete).resolves.toMatchObject({ messages: [] });
    adapter.topicHistory = { messages: [attachment(1_700_000_001)] };
    await expect(client.listMessages(42)).resolves.toMatchObject({ messages: [] });

    const reconnectAttachment = rawMessage({
      id: 93,
      text: "reconnect attachment",
      topicId: 42,
      media: {
        className: "MessageMediaPhoto",
        photo: {
          className: "Photo",
          id: "reconnect-media",
          sizes: [{ className: "PhotoSize", w: 32, h: 32, size: 128 }]
        }
      }
    });
    adapter.topicHistory = { messages: [reconnectAttachment] };
    const reconnectToken = (await client.listMessages(42)).messages[0]!.attachment!.token!;

    let releaseReconcile!: (value: unknown) => void;
    adapter.getTopicHistory.mockImplementationOnce(async () => await new Promise((resolve) => {
      releaseReconcile = resolve;
    }));
    const staleReconcile = client.listMessages(42);
    await vi.waitFor(() => expect(adapter.getTopicHistory).toHaveBeenCalledTimes(6));
    adapter.emit({ className: "ChatKjbConnectionRestored" });
    releaseReconcile({ messages: [reconnectAttachment] });
    await expect(staleReconcile).rejects.toMatchObject({
      name: "HistoryInvalidatedError",
      code: "HISTORY_INVALIDATED"
    });
    await expect(client.downloadAttachment(reconnectToken)).rejects.toThrow(/not available/);
    await client.stop();
  });

  it("drops a download whose attachment authority is reconciled while bytes are in flight", async () => {
    const adapter = new FakeAdapter();
    adapter.topicHistory = { messages: [rawMessage({
      id: 92,
      text: "attachment",
      topicId: 42,
      media: {
        className: "MessageMediaPhoto",
        photo: { className: "Photo", sizes: [{ className: "PhotoSize", w: 1, h: 1, size: 1 }] }
      }
    })] };
    let release!: (bytes: Uint8Array<ArrayBuffer>) => void;
    adapter.downloadMedia.mockImplementationOnce(async () => await new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
      release = resolve;
    }));
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const token = (await client.listMessages(42)).messages[0]!.attachment!.token!;

    const downloading = client.downloadAttachment(token);
    await vi.waitFor(() => expect(adapter.downloadMedia).toHaveBeenCalledOnce());
    adapter.emit({ className: "ChatKjbConnectionRestored" });
    release(Uint8Array.of(1));

    await expect(downloading).rejects.toThrow(/not available/);
    await client.stop();
  });

  it("blocks loopback, private-network, credentialed, and active-content links", () => {
    expect(safeHttpUrl("https://example.com/path")).toBe("https://example.com/path");
    for (const value of [
      "javascript:alert(1)",
      "http://127.0.0.1:8080/private",
      "http://localhost/private",
      "http://10.0.0.1/private",
      "http://192.168.1.1/private",
      "http://[::ffff:127.0.0.1]/private",
      "http://[::ffff:10.0.0.1]/private",
      "http://[::ffff:192.168.1.1]/private",
      "http://[::ffff:0:127.0.0.1]/private",
      "http://[fec0::1]/private",
      "http://[64:ff9b::7f00:1]/private",
      "https://user:password@example.com/private"
    ]) expect(safeHttpUrl(value)).toBeNull();
  });

  it("paginates topics and separates General from ordinary topic history", async () => {
    const adapter = new FakeAdapter();
    adapter.generalHistory = {
      messages: [
        rawMessage({ id: 10, text: "general" }),
        rawMessage({ id: 91, text: "other topic", topicId: 42 }),
        {
          ...rawMessage({ id: 42, text: "" }),
          action: { className: "MessageActionTopicCreate" }
        }
      ]
    };
    adapter.topicHistory = { messages: [rawMessage({ id: 92, text: "topic", topicId: 42 })] };
    const { client } = setup(adapter);
    await client.start();

    const topics = await client.listTopics();
    expect(topics.topics.map((topic) => topic.id)).toEqual([1, 42]);
    expect(topics.nextCursor).toBeNull();
    await expect(client.listMessages(999)).rejects.toThrow(/verified forum topic set/);
    expect((await client.listMessages(1)).messages.map((message) => message.text)).toEqual(["general"]);
    expect((await client.listMessages(42)).messages.map((message) => message.text)).toEqual(["topic"]);
    await client.stop();
  });

  it("advances General history with the raw page cursor even when every item is filtered", async () => {
    const adapter = new FakeAdapter();
    adapter.generalHistory = {
      messages: [rawMessage({ id: 200, text: "topic only", topicId: 42 })]
    };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();

    const first = await client.listMessages(GENERAL_TOPIC_ID);
    expect(first.messages).toEqual([]);
    expect(first.nextCursor).toEqual({ offsetId: 200, offsetDate: 1_700_000_000 });

    adapter.generalHistory = {
      messages: [rawMessage({ id: 199, text: "older General" })]
    };
    const second = await client.listMessages(GENERAL_TOPIC_ID, first.nextCursor!);
    expect(second.messages.map((message) => message.text)).toEqual(["older General"]);
    expect(adapter.getGeneralHistory.mock.calls[1]?.[1]).toEqual(first.nextCursor);
    await client.stop();
  });

  it("normalizes only an exact safe ChatKJB 3x2 reply panel in General history and live updates", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const adapter = new FakeAdapter();
    const valid = rawMessage({ id: 300, text: "panel", replyMarkup: replyKeyboardMarkup() });
    adapter.generalHistory = { messages: [valid] };
    const { client } = setup(adapter, { onUpdate: (update) => updates.push(update) });
    await client.start();

    const [message] = (await client.listMessages(GENERAL_TOPIC_ID)).messages;
    expect(message?.replyPanel).toEqual({ messageId: 300, rows: REPLY_PANEL_ROWS });

    adapter.emit({
      className: "UpdateNewChannelMessage",
      message: rawMessage({ id: 301, text: "new panel", replyMarkup: replyKeyboardMarkup() })
    });
    expect(updates).toContainEqual({
      type: "message_upsert",
      message: expect.objectContaining({
        id: 301,
        replyPanel: { messageId: 301, rows: REPLY_PANEL_ROWS }
      })
    });
    await client.stop();
  });

  it("rejects malformed, unsafe, oversized, and non-General reply panels", async () => {
    const mutateRows = (row: number, column: number, value: string): string[][] => {
      const rows: string[][] = REPLY_PANEL_ROWS.map((source) => [...source]);
      rows[row]![column] = value;
      return rows;
    };
    const wrongRow = replyKeyboardMarkup() as { rows: Array<Record<string, unknown>>; };
    wrongRow.rows[0] = { ...wrongRow.rows[0], className: "KeyboardButtonRowWrong" };
    const wrongButton = replyKeyboardMarkup() as { rows: Array<{ buttons: Array<Record<string, unknown>>; }>; };
    wrongButton.rows[0]!.buttons[0] = { className: "KeyboardButtonUrl", text: REPLY_PANEL_ROWS[0][0] };
    const invalidMarkups = [
      { ...(replyKeyboardMarkup() as Record<string, unknown>), className: "ReplyInlineMarkup" },
      wrongRow,
      wrongButton,
      replyKeyboardMarkup(REPLY_PANEL_ROWS.slice(0, 2)),
      replyKeyboardMarkup(mutateRows(0, 1, "\ud83d\udca5 \ubaa8\ub378")),
      replyKeyboardMarkup(mutateRows(0, 0, "")),
      replyKeyboardMarkup(mutateRows(1, 1, "\ud83d\udcad \ucd94\ub860\nHigh")),
      replyKeyboardMarkup(mutateRows(1, 1, "\ud83d\udcad \ucd94\ub860: \u202eHigh")),
      replyKeyboardMarkup(mutateRows(0, 1, `\ud83e\udde0 \ubaa8\ub378: ${"\uac00".repeat(50)}`))
    ];
    const adapter = new FakeAdapter();
    adapter.generalHistory = {
      messages: invalidMarkups.map((replyMarkup, index) => rawMessage({
        id: 400 - index,
        text: "invalid panel",
        replyMarkup
      }))
    };
    const { client } = setup(adapter);
    await client.start();

    const page = await client.listMessages(GENERAL_TOPIC_ID);
    expect(page.messages).toHaveLength(invalidMarkups.length);
    expect(page.messages.every((message) => message.replyPanel === undefined)).toBe(true);

    const topicPanel = rawMessage({ id: 450, text: "topic panel", topicId: 42, replyMarkup: replyKeyboardMarkup() });
    adapter.generalHistory = { messages: [topicPanel] };
    adapter.topicHistory = { messages: [topicPanel] };
    await client.listTopics();
    expect((await client.listMessages(42)).messages[0]?.replyPanel).toBeUndefined();
    expect(await client.findGeneralReplyPanel()).toBeNull();
    await client.stop();
  });

  it("finds the newest valid General panel while filtering wrong chat and topic sources", async () => {
    const adapter = new FakeAdapter();
    adapter.generalHistory = {
      messages: [
        rawMessage({ id: 503, text: "wrong chat", channelId: 999, replyMarkup: replyKeyboardMarkup() }),
        rawMessage({ id: 502, text: "wrong topic", topicId: 42, replyMarkup: replyKeyboardMarkup() }),
        rawMessage({ id: 501, text: "valid", replyMarkup: replyKeyboardMarkup() })
      ]
    };
    const { client } = setup(adapter);
    await client.start();

    await expect(client.findGeneralReplyPanel()).resolves.toEqual({
      messageId: 501,
      rows: REPLY_PANEL_ROWS
    });
    expect(adapter.getGeneralHistory).toHaveBeenCalledWith(
      adapter.resolved.peer,
      { offsetId: 0, offsetDate: 0 },
      100
    );
    await client.stop();
  });

  it("bounds the dedicated General panel lookup at exactly 1000 raw messages", async () => {
    const adapter = new FakeAdapter();
    adapter.getGeneralHistory.mockImplementation(async (_peer, _cursor, limit) => {
      const page = adapter.getGeneralHistory.mock.calls.length;
      return {
        messages: Array.from({ length: limit }, (_, index) => rawMessage({
          id: 10_000 - ((page - 1) * limit) - index,
          text: "no panel"
        }))
      };
    });
    const { client } = setup(adapter);
    await client.start();

    await expect(client.findGeneralReplyPanel()).resolves.toBeNull();
    expect(adapter.getGeneralHistory).toHaveBeenCalledTimes(10);
    expect(adapter.getGeneralHistory.mock.calls.every((call) => call[2] === 100)).toBe(true);
    await client.stop();
  });

  it("invalidates a General panel lookup when Telegram authority changes in flight", async () => {
    const adapter = new FakeAdapter();
    let release!: (value: unknown) => void;
    adapter.getGeneralHistory.mockImplementationOnce(async () => await new Promise((resolve) => {
      release = resolve;
    }));
    const { client } = setup(adapter);
    await client.start();

    const lookup = client.findGeneralReplyPanel();
    await vi.waitFor(() => expect(adapter.getGeneralHistory).toHaveBeenCalledOnce());
    adapter.emit({ className: "ChatKjbConnectionRestored" });
    release({ messages: [rawMessage({ id: 600, text: "stale", replyMarkup: replyKeyboardMarkup() })] });

    await expect(lookup).rejects.toMatchObject({
      name: "HistoryInvalidatedError",
      code: "HISTORY_INVALIDATED"
    });
    await client.stop();
  });

  it("drops stale verified topics when the first topic page is reconciled", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();
    await expect(client.sendText(42, "before refresh")).resolves.toBeUndefined();

    adapter.forumTopics = {
      topics: [{ className: "ForumTopic", id: 1, title: "General", topMessage: 11 }],
      messages: [{ id: 11, date: 100 }]
    };
    await client.listTopics();

    await expect(client.sendText(42, "after refresh")).rejects.toThrow(/verified forum topic set/);
    await client.stop();
  });

  it("commits a paginated topic refresh atomically and restarts staging after failure", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();
    await expect(client.sendText(42, "known before refresh")).resolves.toBeUndefined();

    const generalOnly = {
      topics: [{ className: "ForumTopic", id: 1, title: "General", topMessage: 11 }],
      messages: [{ id: 11, date: 100 }]
    };
    adapter.getForumTopics.mockResolvedValueOnce(generalOnly);
    const first = await client.listTopics(undefined, 1);
    await expect(client.sendText(42, "still known while staged")).resolves.toBeUndefined();

    adapter.getForumTopics.mockRejectedValueOnce(new Error("topic page failed"));
    await expect(client.listTopics(first.nextCursor!, 1)).rejects.toThrow(/topic page failed/);
    await expect(client.sendText(42, "still known after failure")).resolves.toBeUndefined();
    await expect(client.listTopics(first.nextCursor!, 1)).rejects.toMatchObject({
      code: "HISTORY_INVALIDATED"
    });

    adapter.getForumTopics
      .mockResolvedValueOnce(generalOnly)
      .mockResolvedValueOnce({ topics: [], messages: [] });
    const restarted = await client.listTopics(undefined, 1);
    await client.listTopics(restarted.nextCursor!, 1);
    await expect(client.sendText(42, "removed only after terminal page"))
      .rejects.toThrow(/verified forum topic set/);
    await client.stop();
  });

  it("uses the raw topic count when a full page contains filtered deleted topics", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();

    adapter.getForumTopics
      .mockResolvedValueOnce({
        topics: [
          { className: "ForumTopic", id: 1, title: "General", topMessage: 11 },
          { className: "ForumTopicDeleted", id: 41 }
        ],
        messages: [{ id: 11, date: 100 }]
      })
      .mockResolvedValueOnce({
        topics: [{ className: "ForumTopic", id: 77, title: "Later", topMessage: 77 }],
        messages: [{ id: 77, date: 99 }]
      });

    const first = await client.listTopics(undefined, 2);
    expect(first.nextCursor).not.toBeNull();
    await expect(client.sendText(77, "not committed yet")).rejects.toThrow(/verified forum topic set/);
    const second = await client.listTopics(first.nextCursor!, 2);
    expect(second.nextCursor).toBeNull();
    await expect(client.sendText(77, "committed after raw short page")).resolves.toBeUndefined();
    await client.stop();
  });

  it("builds General and forum topic send, read, and typing requests", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();

    await client.sendText(1, " general message ");
    await client.sendText(1, "reply", 10);
    await client.sendText(42, "topic root");
    await client.sendText(42, "topic reply", 92);
    await client.markRead(1, 10);
    await client.markRead(42, 92);
    await client.setTyping(42, true);

    expect(adapter.sendText.mock.calls.map((call) => call[1])).toEqual([
      { text: " general message " },
      { text: "reply", replyToMessageId: 10 },
      { text: "topic root", replyToMessageId: 42 },
      { text: "topic reply", replyToMessageId: 92, topMessageId: 42 }
    ]);
    expect(adapter.markGeneralRead).toHaveBeenCalledWith(adapter.resolved.peer, 10);
    expect(adapter.markTopicRead).toHaveBeenCalledWith(adapter.resolved.peer, 42, 92);
    expect(adapter.getForumTopicsById.mock.calls).toEqual([
      [adapter.resolved.peer, [GENERAL_TOPIC_ID]],
      [adapter.resolved.peer, [42]]
    ]);
    expect(adapter.setTyping).toHaveBeenCalledWith(adapter.resolved.peer, 42, true);
    await client.stop();
  });

  it("waits for an authoritative exact-topic read receipt before resolving", async () => {
    vi.useFakeTimers();
    try {
      const { client, adapter } = setup();
      await client.start();
      await client.listTopics();
      adapter.getForumTopicsById
        .mockResolvedValueOnce(topicReadReceipt({
          topicId: 42,
          topMessageId: 92,
          readInboxMaxId: 90,
          unreadCount: 2
        }))
        .mockResolvedValueOnce(topicReadReceipt({
          topicId: 42,
          topMessageId: 92,
          readInboxMaxId: 92,
          unreadCount: 0
        }));

      let resolved = false;
      const reading = client.markRead(42, 92).then(() => { resolved = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.markTopicRead).toHaveBeenCalledOnce();
      expect(adapter.getForumTopicsById).toHaveBeenCalledOnce();
      expect(resolved).toBe(false);

      await vi.runAllTimersAsync();
      await reading;
      expect(adapter.getForumTopicsById).toHaveBeenCalledTimes(2);
      expect(resolved).toBe(true);
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies only four stale exact-topic read receipts as confirmation pending", async () => {
    vi.useFakeTimers();
    try {
      const { client, adapter } = setup();
      await client.start();
      await client.listTopics();
      adapter.getForumTopicsById.mockResolvedValue(topicReadReceipt({
        topicId: 42,
        topMessageId: 92,
        readInboxMaxId: 90,
        unreadCount: 2
      }));

      const reading = client.markRead(42, 92);
      const rejection = expect(reading).rejects.toMatchObject({
        name: "ReadConfirmationPendingError",
        code: "READ_CONFIRMATION_PENDING"
      });
      await vi.runAllTimersAsync();
      await rejection;
      expect(adapter.getForumTopicsById).toHaveBeenCalledTimes(4);
      expect(ReadConfirmationPendingError).toBeTypeOf("function");
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts outgoing-top and newer-message confirmation boundaries", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();
    adapter.getForumTopicsById
      .mockResolvedValueOnce(topicReadReceipt({
        topicId: 42,
        topMessageId: 92,
        readInboxMaxId: 90,
        unreadCount: 0
      }))
      .mockResolvedValueOnce(topicReadReceipt({
        topicId: 42,
        topMessageId: 94,
        readInboxMaxId: 92,
        unreadCount: 1
      }));

    await expect(client.markRead(42, 92)).resolves.toBeUndefined();
    await expect(client.markRead(42, 92)).resolves.toBeUndefined();
    expect(adapter.getForumTopicsById).toHaveBeenCalledTimes(2);
    await client.stop();
  });

  it("rejects missing or malformed exact-topic read receipts", async () => {
    vi.useFakeTimers();
    try {
      for (const invalid of [
        { topics: [] },
        topicReadReceipt({ topicId: 42, topMessageId: 92, readInboxMaxId: 93, unreadCount: 0 }),
        topicReadReceipt({ topicId: 42, topMessageId: 92, readInboxMaxId: 92, unreadCount: -1 })
      ]) {
        const { client, adapter } = setup();
        await client.start();
        await client.listTopics();
        adapter.getForumTopicsById.mockResolvedValue(invalid);
        const reading = client.markRead(42, 92);
        const rejection = expect(reading).rejects.not.toBeInstanceOf(ReadConfirmationPendingError);
        await vi.runAllTimersAsync();
        await rejection;
        await client.stop();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds path-only General and forum topic file requests", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();
    const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff]);
    const documentBytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46]);
    const svgBytes = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    const imagePath = temporaryUpload(imageBytes);
    const documentPath = temporaryUpload(documentBytes);
    const svgPath = temporaryUpload(svgBytes);
    const signals = [new AbortController(), new AbortController(), new AbortController()];

    await client.sendFile(GENERAL_TOPIC_ID, {
      name: "photo.jpg",
      mimeType: "image/jpeg",
      path: imagePath,
      size: imageBytes.byteLength,
      signal: signals[0]!.signal,
      caption: "photo"
    });
    await client.sendFile(42, {
      name: "report.pdf",
      mimeType: "application/pdf",
      path: documentPath,
      size: documentBytes.byteLength,
      signal: signals[1]!.signal
    });
    await client.sendFile(42, {
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      path: svgPath,
      size: svgBytes.byteLength,
      signal: signals[2]!.signal
    });

    expect(adapter.sendFile.mock.calls).toEqual([
      [adapter.resolved.peer, {
        name: "photo.jpg",
        mimeType: "image/jpeg",
        path: imagePath,
        size: imageBytes.byteLength,
        signal: signals[0]!.signal,
        caption: "photo",
        forceDocument: true
      }],
      [adapter.resolved.peer, {
        name: "report.pdf",
        mimeType: "application/pdf",
        path: documentPath,
        size: documentBytes.byteLength,
        signal: signals[1]!.signal,
        forceDocument: true,
        replyToMessageId: 42,
        topMessageId: 42
      }],
      [adapter.resolved.peer, {
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        path: svgPath,
        size: svgBytes.byteLength,
        signal: signals[2]!.signal,
        forceDocument: true,
        replyToMessageId: 42,
        topMessageId: 42
      }]
    ]);
    await client.stop();
  });

  it("publishes only an exact outgoing sent file and ignores unsafe return shapes", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const { client, adapter } = setup(undefined, { onUpdate: (update) => updates.push(update) });
    await client.start();
    await client.listTopics();
    updates.length = 0;
    const sent = rawMessage({
      id: 104,
      text: "caption",
      topicId: 42,
      outgoing: true,
      media: {
        className: "MessageMediaDocument",
        document: {
          className: "Document",
          id: "104",
          size: 4,
          mimeType: "application/pdf",
          attributes: [{ className: "DocumentAttributeFilename", fileName: "report.pdf" }]
        }
      }
    });
    const sentMedia = (id: string, size: number) => ({
      className: "MessageMediaDocument",
      document: {
        className: "Document",
        id,
        size,
        mimeType: "application/pdf",
        attributes: [{ className: "DocumentAttributeFilename", fileName: "report.pdf" }]
      }
    });
    adapter.sendFile
      .mockResolvedValueOnce(sent)
      .mockResolvedValueOnce({ className: "Updates" })
      .mockResolvedValueOnce(rawMessage({ id: 105, text: "incoming", topicId: 42, outgoing: false, media: sentMedia("105", 1) }))
      .mockResolvedValueOnce(rawMessage({ id: 106, text: "text only", topicId: 42, outgoing: true }))
      .mockResolvedValueOnce(rawMessage({ id: 107, text: "wrong size", topicId: 42, outgoing: true, media: sentMedia("107", 2) }))
      .mockResolvedValueOnce(rawMessage({ id: 108, text: "wrong topic", topicId: 77, outgoing: true, media: sentMedia("108", 1) }))
      .mockResolvedValueOnce(rawMessage({ id: 109, text: "wrong chat", channelId: 999, topicId: 42, outgoing: true, media: sentMedia("109", 1) }));
    const firstPath = temporaryUpload(Uint8Array.of(1, 2, 3, 4));
    const oneBytePath = temporaryUpload(Uint8Array.of(1));

    await expect(client.sendFile(42, {
      name: "report.pdf",
      mimeType: "application/pdf",
      path: firstPath,
      size: 4,
      signal: new AbortController().signal,
      caption: "caption"
    })).resolves.toBeUndefined();
    expect(updates).toEqual([{
      type: "message_upsert",
      message: expect.objectContaining({
        id: 104,
        topicId: 42,
        text: "caption",
        outgoing: true,
        attachment: expect.objectContaining({
          kind: "document",
          name: "report.pdf",
          filenameSource: "telegram",
          token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)
        })
      })
    }]);

    for (const name of ["invalid-shape.pdf", "incoming.pdf", "text-only.pdf", "wrong-size.pdf", "wrong-topic.pdf", "wrong-chat.pdf"]) {
      await expect(client.sendFile(42, {
        name,
        mimeType: "application/pdf",
        path: oneBytePath,
        size: 1,
        signal: new AbortController().signal
      })).resolves.toBeUndefined();
    }
    expect(updates).toHaveLength(1);

    adapter.topicHistory = { messages: [sent] };
    adapter.emit({ className: "UpdateNewChannelMessage", message: sent });
    expect(updates).toHaveLength(2);
    const immediate = updates[0]?.type === "message_upsert" ? updates[0].message : null;
    const native = updates[1]?.type === "message_upsert" ? updates[1].message : null;
    expect(native).toEqual(immediate);
    const history = await client.listMessages(42);
    expect(history.messages).toEqual([immediate]);
    await client.stop();
  });

  it("validates upload metadata at UTF-8, caption, and MIME boundaries", () => {
    const exactUtf8Name = `${"가".repeat(84)}abc`;
    expect(Buffer.byteLength(exactUtf8Name)).toBe(255);
    expect(validateTelegramUploadMetadata(exactUtf8Name, "application/pdf", "x".repeat(1024)))
      .toEqual({ name: exactUtf8Name, mimeType: "application/pdf", caption: "x".repeat(1024) });
    for (const mimeType of GUI_ALLOWED_UPLOAD_MIME_TYPES) {
      expect(validateTelegramUploadMetadata("safe.bin", mimeType)).toEqual({ name: "safe.bin", mimeType });
    }

    for (const unsafeName of [
      "",
      "가".repeat(86),
      ".",
      "..",
      "folder/file.txt",
      "folder\\file.txt",
      "nul\0name.txt",
      "control\u001fname.txt",
      "delete\u007fname.txt",
      "c1\u0085name.txt",
      "bidi\u202ename.txt"
    ]) {
      expect(() => validateTelegramUploadMetadata(unsafeName, "text/plain")).toThrow(/filename|basename/);
    }
    expect(() => validateTelegramUploadMetadata("safe.txt", "text/html")).toThrow(/MIME/);
    expect(() => validateTelegramUploadMetadata("safe.txt", "text/plain", "x".repeat(1025)))
      .toThrow(/caption/);
  });

  it("selects strict runtime standard and Premium upload part limits with bounded fallback", async () => {
    const inheritedAuthority = appConfig(3_000, 7_000) as { config: unknown; };
    const inheritedConfig = Object.create({
      className: "help.AppConfig",
      config: inheritedAuthority.config
    });
    const cases: Array<{
      premium: unknown;
      config: unknown;
      expected: number;
    }> = [
      { premium: false, config: appConfig(3_000, 7_000), expected: 3_000 * 512 * 1024 },
      { premium: true, config: appConfig(3_000, 7_000), expected: 7_000 * 512 * 1024 },
      { premium: true, config: appConfig(4_000, 8_000), expected: 4_194_304_000 },
      { premium: true, config: appConfig(4_000, 8_001), expected: 4_194_304_000 },
      { premium: false, config: appConfig(7_000, 3_000), expected: 2_097_152_000 },
      { premium: "yes", config: appConfig(3_000, 7_000), expected: 3_000 * 512 * 1024 },
      { premium: true, config: { className: "help.AppConfigNotModified" }, expected: 4_194_304_000 },
      { premium: true, config: inheritedConfig, expected: 4_194_304_000 },
      { premium: false, config: appConfig(2_147_483_647, 2_147_483_647), expected: 2_097_152_000 }
    ];
    for (const fixture of cases) {
      const adapter = new FakeAdapter();
      adapter.identity = { id: "123456", bot: false, premium: fixture.premium } as TelegramUserIdentity;
      adapter.getAppConfig.mockResolvedValue(fixture.config);
      const { client } = setup(adapter);
      await client.start();
      expect(client.uploadLimitBytes()).toBe(fixture.expected);
      await client.stop();
      expect(client.uploadLimitBytes()).toBe(2_097_152_000);
    }

    const missingDefault = new FakeAdapter();
    missingDefault.identity.premium = true;
    missingDefault.getAppConfig.mockResolvedValue({
      className: "help.AppConfig",
      config: {
        className: "JsonObject",
        value: [{
          className: "JsonObjectValue",
          key: "upload_max_fileparts_premium",
          value: { className: "JsonNumber", value: 6_000 }
        }]
      }
    });
    const { client: missingClient } = setup(missingDefault);
    await missingClient.start();
    expect(missingClient.uploadLimitBytes()).toBe(6_000 * 512 * 1024);
    await missingClient.stop();

    const unavailable = new FakeAdapter();
    unavailable.identity.premium = true;
    unavailable.getAppConfig.mockRejectedValue(new Error("unavailable"));
    const { client: unavailableClient } = setup(unavailable);
    await unavailableClient.start();
    expect(unavailableClient.uploadLimitBytes()).toBe(4_194_304_000);
    await unavailableClient.stop();
  });

  it("accepts the exact 8000-part Premium boundary without allocating a GiB heap buffer", async () => {
    const adapter = new FakeAdapter();
    adapter.identity.premium = true;
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const path = temporaryUpload(Uint8Array.of(0));
    truncateSync(path, GUI_MAX_UPLOAD_BYTES);

    await expect(client.sendFile(GENERAL_TOPIC_ID, {
      name: "large.bin",
      mimeType: "application/octet-stream",
      path,
      size: GUI_MAX_UPLOAD_BYTES,
      signal: new AbortController().signal
    })).resolves.toBeUndefined();
    expect(adapter.sendFile).toHaveBeenCalledWith(adapter.resolved.peer, expect.objectContaining({
      path,
      size: GUI_MAX_UPLOAD_BYTES,
      forceDocument: true
    }));
    await client.stop();
  });

  it("releases the file after abort settlement and interrupts only after the 15-second grace", async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const adapter = new FakeAdapter();
      let rejectSend!: (error: Error) => void;
      adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }));
      adapter.interruptUploadTransport.mockImplementationOnce(async () => {
        events.push("interrupt");
        rejectSend(new Error("transport interrupted"));
      });
      const { client } = setup(adapter);
      await client.start();
      await client.listTopics();
      adapter.connect.mockImplementation(async () => {
        events.push("recovery-connect");
      });
      const controller = new AbortController();
      const path = temporaryUpload(Uint8Array.of(1));
      const sending = client.sendFile(42, {
        name: "cancel.txt",
        mimeType: "text/plain",
        path,
        size: 1,
        signal: controller.signal,
        onFileReleased: () => { events.push("release"); }
      });
      const rejected = expect(sending).rejects.toThrow(/transport interrupted/);
      await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(adapter.interruptUploadTransport).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(existsSync(path)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      await rejected;
      expect(events.slice(0, 3)).toEqual(["interrupt", "release", "recovery-connect"]);
      expect(adapter.interruptUploadTransport).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the file but bounds a hanging interrupt hook before reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter();
      let rejectSend!: (error: Error) => void;
      adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }));
      adapter.interruptUploadTransport.mockImplementationOnce(async () => {
        rejectSend(new Error("transport interrupted"));
        await new Promise<never>(() => undefined);
      });
      const { client } = setup(adapter);
      await client.start();
      await client.listTopics();
      const controller = new AbortController();
      const path = temporaryUpload(Uint8Array.of(1));
      let releases = 0;
      const sending = client.sendFile(42, {
        name: "hung-interrupt.txt",
        mimeType: "text/plain",
        path,
        size: 1,
        signal: controller.signal,
        onFileReleased: () => { releases += 1; }
      });
      const rejected = expect(sending).rejects.toThrow(/recovery failed/);
      await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(releases).toBe(1);
      expect(adapter.connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await rejected;
      expect(releases).toBe(1);
      expect(adapter.connect).toHaveBeenCalledOnce();
      expect(adapter.interruptUploadTransport).toHaveBeenCalledOnce();
      expect(adapter.disconnect).toHaveBeenCalled();
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not interrupt when the adapter honors cancellation during the grace period", async () => {
    const adapter = new FakeAdapter();
    adapter.sendFile.mockImplementationOnce(async (_peer, request) => await new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("cancelled by signal")), { once: true });
    }));
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const controller = new AbortController();
    let releases = 0;
    const sending = client.sendFile(42, {
      name: "cooperative.txt",
      mimeType: "text/plain",
      path: temporaryUpload(Uint8Array.of(1)),
      size: 1,
      signal: controller.signal,
      onFileReleased: () => { releases += 1; }
    });
    const rejected = expect(sending).rejects.toThrow(/cancelled by signal/);
    await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
    controller.abort();

    await rejected;
    expect(adapter.interruptUploadTransport).not.toHaveBeenCalled();
    expect(releases).toBe(1);
    await client.stop();
  });

  it("bounds post-interrupt recovery to two minutes and enters error state", async () => {
    vi.useFakeTimers();
    try {
      const states: GuiAuthState[] = [];
      const adapter = new FakeAdapter();
      let rejectSend!: (error: Error) => void;
      adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }));
      adapter.interruptUploadTransport.mockImplementationOnce(async () => {
        rejectSend(new Error("transport interrupted"));
      });
      const { client } = setup(adapter, { onAuthState: (state) => states.push(state) });
      await client.start();
      await client.listTopics();
      adapter.connect.mockImplementation(async () => await new Promise<never>(() => undefined));
      const controller = new AbortController();
      const path = temporaryUpload(Uint8Array.of(1));
      let releases = 0;
      const sending = client.sendFile(42, {
        name: "timeout.txt",
        mimeType: "text/plain",
        path,
        size: 1,
        signal: controller.signal,
        onFileReleased: () => { releases += 1; }
      });
      const rejected = expect(sending).rejects.toThrow(/recovery failed/);
      await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(releases).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      await rejected;
      expect(states.map((state) => state.state)).toContain("reconnecting");
      expect(states.at(-1)?.state).toBe("error");
      expect(adapter.disconnect).toHaveBeenCalled();
      expect(releases).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["checkAuthorization", "getMe", "getAppConfig", "resolveForumPeer", "catchUp"] as const)(
    "bounds a hanging recovery %s stage to the same two-minute deadline",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const adapter = new FakeAdapter();
        let rejectSend!: (error: Error) => void;
        adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
          rejectSend = reject;
        }));
        adapter.interruptUploadTransport.mockImplementationOnce(async () => {
          rejectSend(new Error("transport interrupted"));
        });
        const { client } = setup(adapter);
        await client.start();
        await client.listTopics();
        adapter[stage].mockImplementation(async () => await new Promise<never>(() => undefined));
        const controller = new AbortController();
        const path = temporaryUpload(Uint8Array.of(1));
        let releases = 0;
        const sending = client.sendFile(42, {
          name: `${stage}.txt`,
          mimeType: "text/plain",
          path,
          size: 1,
          signal: controller.signal,
          onFileReleased: () => { releases += 1; }
        });
        const rejected = expect(sending).rejects.toThrow(/recovery failed/);
        await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
        controller.abort();
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.advanceTimersByTimeAsync(2 * 60_000);

        await rejected;
        expect(releases).toBe(1);
        expect(adapter.disconnect).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it.each([
    ["connect", "checkAuthorization"],
    ["checkAuthorization", "getMe"],
    ["getMe", "getAppConfig"],
    ["getAppConfig", "resolveForumPeer"],
    ["resolveForumPeer", "catchUp"],
    ["catchUp", null]
  ] as const)(
    "does not continue after a late recovery %s stage settles past its deadline",
    async (stage, nextStage) => {
      vi.useFakeTimers();
      try {
        const adapter = new FakeAdapter();
        let rejectSend!: (error: Error) => void;
        adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
          rejectSend = reject;
        }));
        adapter.interruptUploadTransport.mockImplementationOnce(async () => {
          rejectSend(new Error("transport interrupted"));
        });
        const states: GuiAuthState[] = [];
        const { client } = setup(adapter, { onAuthState: (state) => states.push(state) });
        await client.start();
        await client.listTopics();
        const stageCallsBefore = adapter[stage].mock.calls.length;
        const nextCallsBefore = nextStage === null ? 0 : adapter[nextStage].mock.calls.length;
        let resolveStage!: () => void;
        adapter[stage].mockImplementation(async () => await new Promise<never>((resolve) => {
          resolveStage = resolve as unknown as () => void;
        }));
        const controller = new AbortController();
        const path = temporaryUpload(Uint8Array.of(1));
        const sending = client.sendFile(42, {
          name: `late-${stage}.txt`,
          mimeType: "text/plain",
          path,
          size: 1,
          signal: controller.signal
        });
        const rejected = expect(sending).rejects.toThrow(/recovery failed/);
        await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
        controller.abort();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(adapter[stage].mock.calls.length).toBe(stageCallsBefore + 1);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await rejected;
        expect(states.at(-1)?.state).toBe("error");
        const disconnectsAtDeadline = adapter.disconnect.mock.calls.length;

        resolveStage();
        await vi.advanceTimersByTimeAsync(0);
        if (nextStage !== null) expect(adapter[nextStage].mock.calls.length).toBe(nextCallsBefore);
        expect(adapter.disconnect.mock.calls.length).toBeGreaterThan(disconnectsAtDeadline);
        expect(states.at(-1)?.state).toBe("error");
        await client.stop();
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("fails recovery closed when Telegram authorization is lost", async () => {
    vi.useFakeTimers();
    try {
      const states: GuiAuthState[] = [];
      const adapter = new FakeAdapter();
      let rejectSend!: (error: Error) => void;
      adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }));
      adapter.interruptUploadTransport.mockImplementationOnce(async () => {
        rejectSend(new Error("transport interrupted"));
      });
      const { client } = setup(adapter, { onAuthState: (state) => states.push(state) });
      await client.start();
      await client.listTopics();
      adapter.checkAuthorization.mockResolvedValueOnce(false);
      const controller = new AbortController();
      const path = temporaryUpload(Uint8Array.of(1));
      let releases = 0;
      const sending = client.sendFile(42, {
        name: "authorization-lost.txt",
        mimeType: "text/plain",
        path,
        size: 1,
        signal: controller.signal,
        onFileReleased: () => { releases += 1; }
      });
      const rejected = expect(sending).rejects.toThrow(/recovery failed/);
      await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);

      await rejected;
      expect(releases).toBe(1);
      expect(states.at(-1)?.state).toBe("error");
      await client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a hanging recovery immediately when lifecycle close begins", async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter();
      let rejectSend!: (error: Error) => void;
      adapter.sendFile.mockImplementationOnce(async () => await new Promise<never>((_resolve, reject) => {
        rejectSend = reject;
      }));
      adapter.interruptUploadTransport.mockImplementationOnce(async () => {
        rejectSend(new Error("transport interrupted"));
      });
      const { client } = setup(adapter);
      await client.start();
      await client.listTopics();
      adapter.connect.mockImplementation(async () => await new Promise<never>(() => undefined));
      const controller = new AbortController();
      const path = temporaryUpload(Uint8Array.of(1));
      const sending = client.sendFile(42, {
        name: "closing.txt",
        mimeType: "text/plain",
        path,
        size: 1,
        signal: controller.signal
      });
      const rejected = expect(sending).rejects.toThrow(/recovery failed/);
      await vi.waitFor(() => expect(adapter.sendFile).toHaveBeenCalledOnce());
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(() => expect(adapter.connect).toHaveBeenCalled());

      await client.stop();
      await rejected;
      expect(adapter.disconnect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects empty, oversized, malformed, and authority-bearing uploads before adapter use", async () => {
    const { client, adapter } = setup();
    await client.start();
    await client.listTopics();
    const path = temporaryUpload(Uint8Array.of(1));
    const base: TelegramUploadInput = {
      name: "safe.txt",
      mimeType: "text/plain",
      path,
      size: 1,
      signal: new AbortController().signal
    };
    expect(MAX_SUPPORTED_UPLOAD_PARTS).toBe(8_000);
    expect(GUI_MAX_UPLOAD_BYTES).toBe(4_194_304_000);
    expect(client.uploadLimitBytes()).toBe(2_097_152_000);

    const invalidInputs: unknown[] = [
      { ...base, size: 0 },
      { ...base, size: client.uploadLimitBytes() + 1 },
      { ...base, size: 2 },
      { ...base, path: "relative/payload" },
      { ...base, path: join(tmpdir(), "missing-chatkjb-upload") },
      { ...base, signal: {} },
      { ...base, name: "../escape.txt" },
      { ...base, mimeType: "text/html" },
      { ...base, caption: "x".repeat(1025) },
      { ...base, bytes: Uint8Array.of(1) },
      ...["url", "chat", "peer", "reply"].map((field) => ({ ...base, [field]: "forbidden" }))
    ];

    for (const input of invalidInputs) {
      await expect(client.sendFile(GENERAL_TOPIC_ID, input as TelegramUploadInput)).rejects.toThrow();
    }
    expect(adapter.sendFile).not.toHaveBeenCalled();

    await expect(client.sendFile(GENERAL_TOPIC_ID, base)).resolves.toBeUndefined();
    expect(adapter.sendFile).toHaveBeenCalledOnce();
    await client.stop();
  });

  it("allows only cached non-password callback data from the fixed message", async () => {
    const adapter = new FakeAdapter();
    adapter.topicHistory = {
      messages: [
        rawMessage({ id: 92, text: "choose", topicId: 42, callback: { data: "allowed" } }),
        rawMessage({ id: 93, text: "secure", topicId: 42, callback: { data: "secure", requiresPassword: true } })
      ]
    };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const page = await client.listMessages(42);
    const allowed = page.messages[0]!.buttons[0]![0]!.callbackData!;
    const secure = page.messages[1]!.buttons[0]![0]!.callbackData!;

    await expect(client.pressCallback(92, allowed)).resolves.toEqual({ message: "ok" });
    await expect(client.pressCallback(92, Buffer.from("other").toString("base64url")))
      .rejects.toThrow(/not present/);
    await expect(client.pressCallback(93, secure)).rejects.toThrow(/not present/);
    expect(adapter.pressCallback).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it("invalidates cached callback authority as soon as reconciliation is required", async () => {
    const adapter = new FakeAdapter();
    adapter.topicHistory = {
      messages: [rawMessage({ id: 92, text: "choose", topicId: 42, callback: { data: "allowed" } })]
    };
    const { client } = setup(adapter);
    await client.start();
    await client.listTopics();
    const page = await client.listMessages(42);
    const callbackData = page.messages[0]!.buttons[0]![0]!.callbackData!;
    await expect(client.pressCallback(92, callbackData)).resolves.toEqual({ message: "ok" });

    adapter.emit({ className: "ChatKjbConnectionRestored" });

    await expect(client.pressCallback(92, callbackData)).rejects.toThrow(/not present/);
    expect(adapter.pressCallback).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it("blocks sends, callbacks, and raw updates immediately when closing starts", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const adapter = new FakeAdapter();
    adapter.topicHistory = {
      messages: [rawMessage({ id: 92, text: "choose", topicId: 42, callback: { data: "allowed" } })]
    };
    let releaseDisconnect!: (value: undefined) => void;
    adapter.disconnect.mockImplementationOnce(async () => await new Promise<undefined>((resolve) => {
      releaseDisconnect = resolve;
    }));
    const { client } = setup(adapter, { onUpdate: (update) => updates.push(update) });
    await client.start();
    await client.listTopics();
    const page = await client.listMessages(42);
    const callbackData = page.messages[0]!.buttons[0]![0]!.callbackData!;
    const beforeClose = updates.length;

    const stopping = client.stop();
    await expect(client.sendText(42, "must not send")).rejects.toThrow(/stopping|verified forum/);
    await expect(client.pressCallback(92, callbackData)).rejects.toThrow(/not present|stopping/);
    adapter.emit({
      className: "UpdateNewChannelMessage",
      message: rawMessage({ id: 93, text: "must not publish", topicId: 42 })
    });
    expect(updates).toHaveLength(beforeClose);
    releaseDisconnect(undefined);

    await expect(stopping).resolves.toBeUndefined();
    expect(adapter.sendText).not.toHaveBeenCalled();
    expect(adapter.pressCallback).not.toHaveBeenCalled();
  });

  it("filters live updates to the fixed channel and maps edits and deletes to known topics", async () => {
    const updates: GuiTelegramUpdate[] = [];
    const { client, adapter } = setup(undefined, { onUpdate: (update) => updates.push(update) });
    await client.start();
    await client.listTopics();

    adapter.emit({ className: "UpdateNewChannelMessage", message: rawMessage({ id: 92, text: "new", topicId: 42 }) });
    adapter.emit({ className: "UpdateEditChannelMessage", message: rawMessage({ id: 92, text: "edited", topicId: 42, editDate: 1_700_000_001 }) });
    adapter.emit({ className: "UpdateNewChannelMessage", message: rawMessage({ id: 500, text: "other", channelId: 999, topicId: 42 }) });
    adapter.emit({ className: "UpdateDeleteChannelMessages", channelId: 999, messages: [92] });
    adapter.emit({ className: "UpdateDeleteChannelMessages", channelId: 123, messages: [92, 42, 999] });
    adapter.emit({ className: "UpdateChannelTooLong", channelId: 123 });

    expect(updates.map((update) => update.type)).toEqual([
      "reconcile_required",
      "message_upsert",
      "message_upsert",
      "topic_delete",
      "message_delete",
      "reconcile_required",
      "reconcile_required"
    ]);
    expect(updates[2]).toMatchObject({ type: "message_upsert", message: { id: 92, text: "edited" } });
    expect(updates[4]).toEqual({ type: "message_delete", topicId: 42, messageIds: [92] });
    await client.stop();
  });

  it("logs out on Telegram before removing the local user session", async () => {
    const sessionPath = temporarySessionPath();
    await writeTelegramSession(sessionPath, "persisted");
    const { client, adapter } = setup(undefined, { sessionPath });
    await client.start();

    await client.logOut();

    expect(adapter.logOut).toHaveBeenCalledOnce();
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(await readTelegramSession(sessionPath)).toBe("");
  });
});
