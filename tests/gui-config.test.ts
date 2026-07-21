import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API_HASH = "0123456789abcdef0123456789abcdef";
const originalEnv = { ...process.env };
const directories: string[] = [];

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function loadFromEnvironmentFile(
  lines: readonly string[],
  mode = 0o600
) {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-"));
  directories.push(directory);
  const envPath = join(directory, ".env");
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode });
  process.env = {
    HOME: directory,
    CHATKJB_CONFIG_BASE_DIR: directory,
    // 테스트 격리: 실제 LaunchAgent/봇 프로젝트로 폴백하지 않도록 동일 디렉터리를 가리킨다.
    CHATKJB_PROJECT_DIR: directory,
    CHATKJB_ENV_PATH: envPath
  };
  const { loadTelegramGuiConfig } = await import("../src/config.js");
  return { config: loadTelegramGuiConfig(), directory, envPath };
}

function requiredEnvironment(overrides: Record<string, string> = {}): string[] {
  const values = {
    TELEGRAM_API_ID: "12345678",
    TELEGRAM_API_HASH: API_HASH,
    TELEGRAM_CHAT_ID: "-1001234567890",
    TELEGRAM_ALLOWED_USER_ID: "123456",
    ...overrides
  };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}

describe("Telegram GUI configuration", () => {
  it("loads only the GUI Telegram settings with separate default session paths", async () => {
    const { config, directory } = await loadFromEnvironmentFile([
      ...requiredEnvironment({ TELEGRAM_ALLOWED_USER_IDS: "123456, 987654" }),
      "TELEGRAM_BOT_TOKEN=x",
      "DATABASE_PATH=",
      "PROJECTS_PATH=/definitely/missing/projects.json",
      "CLAUDE_CODE_OAUTH_TOKEN=malformed",
      "CODEX_EXECUTABLE=/opt/test/bin/codex",
      "GROK_EXECUTABLE=/opt/test/bin/grok"
    ]);

    await expect(config).resolves.toEqual({
      apiId: 12345678,
      apiHash: API_HASH,
      chatId: -1_001_234_567_890,
      allowedUserIds: [123456, 987654],
      sessionPath: join(directory, "data", "telegram-gui.session"),
      databasePath: join(directory, "data", "state.sqlite"),
      codexExecutable: "/opt/test/bin/codex",
      grokExecutable: "/opt/test/bin/grok",
      // 머신에 ChatGPT 구독 auth.json이 있으면 폴백 홈 1개, 없으면 빈 배열.
      codexAccountHomes: expect.any(Array)
    });
  });

  it("requires a 0600 environment file", async () => {
    const { config, envPath } = await loadFromEnvironmentFile(requiredEnvironment());
    await expect(config).resolves.toBeDefined();

    chmodSync(envPath, 0o644);
    vi.resetModules();
    const { loadTelegramGuiConfig } = await import("../src/config.js");
    await expect(loadTelegramGuiConfig()).rejects.toThrow(".env permissions must be 0600");
  });

  it.each([
    {
      label: "missing API ID",
      lines: requiredEnvironment().filter((line) => !line.startsWith("TELEGRAM_API_ID="))
    },
    {
      label: "missing API hash",
      lines: requiredEnvironment().filter((line) => !line.startsWith("TELEGRAM_API_HASH="))
    },
    {
      label: "malformed API ID",
      lines: requiredEnvironment({ TELEGRAM_API_ID: "not-an-integer" })
    },
    {
      label: "malformed API hash",
      lines: requiredEnvironment({ TELEGRAM_API_HASH: "not-a-hash" })
    },
    {
      label: "missing chat ID",
      lines: requiredEnvironment().filter((line) => !line.startsWith("TELEGRAM_CHAT_ID="))
    },
    {
      label: "malformed chat ID",
      lines: requiredEnvironment({ TELEGRAM_CHAT_ID: "not-an-integer" })
    },
    {
      label: "non-group chat ID",
      lines: requiredEnvironment({ TELEGRAM_CHAT_ID: "42" })
    },
    {
      label: "missing allowed user ID",
      lines: requiredEnvironment().filter((line) => !line.startsWith("TELEGRAM_ALLOWED_USER_ID="))
    },
    {
      label: "malformed allowed user ID",
      lines: requiredEnvironment({ TELEGRAM_ALLOWED_USER_ID: "not-an-integer" })
    },
    {
      label: "non-positive allowed user ID",
      lines: requiredEnvironment({ TELEGRAM_ALLOWED_USER_ID: "-1" })
    }
  ])("rejects $label", async ({ lines }) => {
    const { config } = await loadFromEnvironmentFile(lines);
    await expect(config).rejects.toThrow();
  });

  it("rejects lexically equivalent GUI and bot session paths", async () => {
    const { config } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: "./data/shared.session",
      TELEGRAM_MTPROTO_SESSION_PATH: "./data/../data/shared.session"
    }));

    await expect(config).rejects.toThrow(
      "TELEGRAM_GUI_SESSION_PATH must be distinct from TELEGRAM_MTPROTO_SESSION_PATH"
    );
  });

  it("rejects a GUI session path that collides with the existing bot database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-database-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    writeFileSync(databasePath, "database canary\n", { mode: 0o600 });
    const { config } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: databasePath,
      DATABASE_PATH: databasePath
    }));

    await expect(config).rejects.toThrow(
      "TELEGRAM_GUI_SESSION_PATH must be distinct from DATABASE_PATH"
    );
  });

  it("rejects different path strings that resolve to the same existing file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-alias-"));
    directories.push(directory);
    const target = join(directory, "target.session");
    const alias = join(directory, "alias.session");
    writeFileSync(target, "session\n", { mode: 0o600 });
    symlinkSync(target, alias);
    const { config } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: alias,
      TELEGRAM_MTPROTO_SESSION_PATH: target
    }));

    await expect(config).rejects.toThrow(
      "TELEGRAM_GUI_SESSION_PATH must be distinct from TELEGRAM_MTPROTO_SESSION_PATH"
    );
  });

  it("rejects not-yet-created session leaves that share a symlinked parent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-parent-alias-"));
    directories.push(directory);
    const realParent = join(directory, "real");
    const aliasParent = join(directory, "alias");
    mkdirSync(realParent);
    symlinkSync(realParent, aliasParent);
    const { config } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: join(aliasParent, "shared.session"),
      TELEGRAM_MTPROTO_SESSION_PATH: join(realParent, "shared.session")
    }));

    await expect(config).rejects.toThrow(
      "TELEGRAM_GUI_SESSION_PATH must be distinct from TELEGRAM_MTPROTO_SESSION_PATH"
    );
  });

  it.each(["-wal", "-shm", "-journal"])("rejects the SQLite %s sidecar path", async (suffix) => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-sidecar-"));
    directories.push(directory);
    const databasePath = join(directory, "state.sqlite");
    const { config } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: `${databasePath}${suffix}`,
      DATABASE_PATH: databasePath
    }));

    await expect(config).rejects.toThrow(
      "TELEGRAM_GUI_SESSION_PATH must be distinct from DATABASE_PATH"
    );
  });

  it("accepts distinct existing GUI and bot session files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-config-distinct-"));
    directories.push(directory);
    const guiSession = join(directory, "gui.session");
    const botSession = join(directory, "bot.session");
    writeFileSync(guiSession, "gui\n", { mode: 0o600 });
    writeFileSync(botSession, "bot\n", { mode: 0o600 });
    const { config, directory: configDirectory } = await loadFromEnvironmentFile(requiredEnvironment({
      TELEGRAM_GUI_SESSION_PATH: guiSession,
      TELEGRAM_MTPROTO_SESSION_PATH: botSession,
      CODEX_EXECUTABLE: "/opt/test/bin/codex",
      GROK_EXECUTABLE: "/opt/test/bin/grok"
    }));

    await expect(config).resolves.toEqual({
      apiId: 12345678,
      apiHash: API_HASH,
      chatId: -1_001_234_567_890,
      allowedUserIds: [123456],
      sessionPath: guiSession,
      databasePath: join(configDirectory, "data", "state.sqlite"),
      codexExecutable: "/opt/test/bin/codex",
      grokExecutable: "/opt/test/bin/grok",
      codexAccountHomes: expect.any(Array)
    });
  });
});
