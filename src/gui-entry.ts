import { closeSync, realpathSync, writeSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { GuiAuthState } from "./gui/protocol.js";
import type { GuiServerHandle } from "./gui/server.js";
import type { TelegramUserClient } from "./gui/telegram-user-client.js";

type PrivateControlEvent =
  | { type: "heartbeat"; }
  | { type: "ready"; origin: string; bootstrapUrl: string; }
  | { type: "auth_state"; state: GuiAuthState["state"]; errorCode?: string; }
  | { type: "qr"; token: string; expiresAt: number; }
  | { type: "fatal"; code: string; };

export const GUI_RUNTIME_SELF_TEST_MARKER = "CHATKJB_GUI_RUNTIME_SELF_TEST_OK";

export function isGuiRuntimeSelfTestMode(argv: readonly string[]): boolean {
  return argv.length === 1 && argv[0] === "--runtime-self-test";
}

async function runGuiRuntimeSelfTest(): Promise<boolean> {
  const emitWarning = process.emitWarning;
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  try {
    await import("teleproto");
    await import("teleproto/Helpers.js");
    await import("teleproto/extensions/Logger.js");
    await import("teleproto/network/index.js");
    for (const asset of ["index.html", "styles.css", "app.js", "manifest.webmanifest"] as const) {
      const url = new URL(`./web/${asset}`, import.meta.url);
      await access(url);
      if ((await readFile(url)).byteLength === 0) return false;
    }
    writeSync(process.stdout.fd, `${GUI_RUNTIME_SELF_TEST_MARKER}\n`);
    return true;
  } catch {
    return false;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function parseGuiControlFd(argv: readonly string[]): number {
  const index = argv.indexOf("--control-fd");
  const raw = index === -1 ? undefined : argv[index + 1];
  if (!raw || !/^\d+$/.test(raw)) throw new Error("--control-fd <inherited fd> is required");
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1_024) {
    throw new Error("--control-fd must be an inherited descriptor from 3 to 1024");
  }
  return fd;
}

function publicAuthState(state: GuiAuthState): PrivateControlEvent {
  const errorCode = typeof state.errorCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(state.errorCode)
    ? state.errorCode
    : undefined;
  return {
    type: "auth_state",
    state: state.state,
    ...(errorCode ? { errorCode } : {})
  };
}

async function run(): Promise<void> {
  const controlFd = parseGuiControlFd(process.argv.slice(2));
  let server: GuiServerHandle | null = null;
  let client: TelegramUserClient | null = null;
  let shuttingDown = false;
  let controlOpen = true;
  let parentWatch: NodeJS.Timeout | null = null;
  let latestAuthState: GuiAuthState["state"] = "signed_out";
  const expectedParentPid = process.ppid;

  const emitPrivate = (event: PrivateControlEvent): boolean => {
    if (!controlOpen) return false;
    try {
      writeSync(controlFd, `${JSON.stringify(event)}\n`);
      return true;
    } catch {
      controlOpen = false;
      return false;
    }
  };

  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (parentWatch) clearInterval(parentWatch);
    parentWatch = null;
    await Promise.all([
      server?.close().catch(() => undefined),
      client?.stop().catch(() => undefined)
    ]);
    if (controlOpen) {
      try {
        closeSync(controlFd);
      } catch {
        // The native parent may already have closed its end of the private pipe.
      }
      controlOpen = false;
    }
    process.exit(exitCode);
  };

  parentWatch = setInterval(() => {
    if (process.ppid !== expectedParentPid || process.ppid <= 1 || !emitPrivate({ type: "heartbeat" })) {
      void shutdown(1);
    }
  }, 1_000);

  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      void shutdown(code);
    });
  }

  try {
    const [configModule, protocolModule, serverModule, clientModule, usageSourceModule] = await Promise.all([
      import("./config.js"),
      import("./gui/protocol.js"),
      import("./gui/server.js"),
      import("./gui/telegram-user-client.js"),
      import("./gui/usage-source.js")
    ]);
    const { loadTelegramGuiConfig } = configModule;
    const { safeTelegramErrorCode } = protocolModule;
    const { startGuiServer } = serverModule;
    const { TelegramUserClient } = clientModule;
    const { createUsageProvider } = usageSourceModule;
    const config = await loadTelegramGuiConfig();
    client = new TelegramUserClient({
      apiId: config.apiId,
      apiHash: config.apiHash,
      chatId: config.chatId,
      allowedUserIds: config.allowedUserIds,
      sessionPath: config.sessionPath,
      onAuthState: (state) => {
        latestAuthState = state.state;
        server?.publishAuthState(state);
        if (!emitPrivate(publicAuthState(state))) void shutdown(1);
      },
      onQrCode: (token, expiresAt) => {
        const encoded = Buffer.from(token).toString("base64url");
        if (!emitPrivate({ type: "qr", token: encoded, expiresAt })) void shutdown(1);
      },
      onUpdate: (update) => server?.publishUpdate(update)
    });
    // 진단 이벤트를 버리면 전송 실패 원인을 사후에 추적할 수 없다. 비밀값이 섞이지
    // 않는 유형과 코드만 stderr로 남긴다.
    server = await startGuiServer({
      client,
      // 작성창 사용량 스트립 소스. 공유 DB read-only + codex/grok 라이브 조회.
      usageProvider: createUsageProvider({
        databasePath: config.databasePath,
        codexExecutable: config.codexExecutable,
        grokExecutable: config.grokExecutable,
        // Codex 다계정(CODEX_ACCOUNT_HOMES) 각각의 사용량을 계정별 줄로 표시한다.
        codexAccountHomes: config.codexAccountHomes,
        // 데몬 호스트면 local, 다른 Mac 의 Terminal 이면 데몬 공유 캐시(파일 또는 HTTP)만 읽는다.
        sourceMode: config.usageSourceMode,
        usageCachePaths: config.usageCachePaths,
        usageCacheUrls: config.usageCacheUrls,
        preferDaemonClaudeCache: config.preferDaemonClaudeCache,
        ...(config.usageHttpToken ? { usageHttpToken: config.usageHttpToken } : {})
      }),
      onDiagnostic: ({ type, code }) => {
        process.stderr.write(`[gui] ${type}: ${code}\n`);
      }
    });
    if (!emitPrivate({ type: "ready", origin: server.origin, bootstrapUrl: server.takeBootstrapUrl() })) {
      await shutdown(1);
      return;
    }
    try {
      await client.start();
    } catch (error: unknown) {
      emitPrivate({ type: "fatal", code: safeTelegramErrorCode(error) });
      await shutdown(1);
      return;
    }
    if (latestAuthState === "signed_out") {
      void client.beginQrLogin().catch(() => undefined);
    }
  } catch {
    emitPrivate({ type: "fatal", code: "GUI_START_FAILED" });
    await shutdown(1);
  }
}

const isMain = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (isGuiRuntimeSelfTestMode(process.argv.slice(2))) {
    process.exit(await runGuiRuntimeSelfTest() ? 0 : 1);
  }
  await run();
}
