import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts", "migrate-macos-state.mjs");
const apiHash = "0123456789abcdef0123456789abcdef";
const secretSentinel = "BOT_SECRET_MUST_NOT_LEAK";
const sessionSentinel = "GUI_SESSION_PAYLOAD_MUST_NOT_LEAK";
const temporaryDirectories: string[] = [];

function mode(path: string) {
  return lstatSync(path).mode & 0o777;
}

function hash(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function environment(overrides: Record<string, string> = {}) {
  return {
    TELEGRAM_API_ID: "12345678",
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_CHAT_ID: "-1001234567890",
    TELEGRAM_ALLOWED_USER_IDS: "123456,987654",
    TELEGRAM_BOT_TOKEN: secretSentinel,
    DATABASE_PATH: "./data/state.sqlite",
    ...overrides
  };
}

function environmentText(values: Record<string, string> = environment()) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-macos-migration-"));
  temporaryDirectories.push(directory);
  chmodSync(directory, 0o700);
  const source = join(directory, "source");
  const target = join(directory, "target");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(join(source, "data"), { mode: 0o700 });
  writeFileSync(join(source, ".env"), environmentText(), { mode: 0o600 });
  writeFileSync(join(source, "data", "telegram-gui.session"), sessionSentinel, { mode: 0o600 });
  return { directory, source, target };
}

function run(command: "migrate" | "rollback", source: string | null, target: string) {
  const arguments_ = [script, command];
  if (source) arguments_.push("--source", source);
  arguments_.push("--target", target);
  return spawnSync(process.execPath, arguments_, {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(target, "test-home")
    }
  });
}

function receipt(target: string) {
  return JSON.parse(readFileSync(join(target, "migration-receipt.json"), "utf8"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChatKJB Terminal macOS state migration", () => {
  it("atomically creates a private GUI-only configuration and session while preserving the source", () => {
    const { source, target } = fixture();
    const sourceEnvironment = readFileSync(join(source, ".env"));
    const sourceSession = readFileSync(join(source, "data", "telegram-gui.session"));

    const result = run("migrate", source, target);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("CHATKJB_MACOS_STATE_MIGRATION_OK\n");
    expect(result.stderr).toBe("");
    expect(mode(target)).toBe(0o700);
    expect(mode(join(target, "data"))).toBe(0o700);
    expect(mode(join(target, ".env"))).toBe(0o600);
    expect(mode(join(target, "data", "telegram-gui.session"))).toBe(0o600);
    expect(mode(join(target, "migration-receipt.json"))).toBe(0o600);
    expect(readFileSync(join(target, ".env"), "utf8")).toBe([
      "TELEGRAM_API_ID=12345678",
      `TELEGRAM_API_HASH=${apiHash}`,
      "TELEGRAM_CHAT_ID=-1001234567890",
      "TELEGRAM_ALLOWED_USER_IDS=123456,987654",
      ""
    ].join("\n"));
    expect(readFileSync(join(target, "data", "telegram-gui.session"))).toEqual(sourceSession);
    expect(readFileSync(join(source, ".env"))).toEqual(sourceEnvironment);
    expect(readFileSync(join(source, "data", "telegram-gui.session"))).toEqual(sourceSession);

    const record = receipt(target);
    expect(record.files.environment).toMatchObject({ action: "created", mode: "0600" });
    expect(record.files.guiSession).toMatchObject({ action: "created", mode: "0600" });
    expect(record.files.environment.sha256).toBe(hash(readFileSync(join(target, ".env"))));
    expect(record.files.guiSession.sha256).toBe(hash(sourceSession));
  });

  it("reuses valid existing target files without overwriting them", () => {
    const { source, target } = fixture();
    mkdirSync(target, { mode: 0o700 });
    mkdirSync(join(target, "data"), { mode: 0o700 });
    const existingEnvironment = environmentText({
      TELEGRAM_API_ID: "87654321",
      TELEGRAM_API_HASH: "abcdefabcdefabcdefabcdefabcdefab",
      TELEGRAM_CHAT_ID: "-1009999999999",
      TELEGRAM_ALLOWED_USER_ID: "999999"
    });
    const existingSession = Buffer.from("existing-gui-session");
    writeFileSync(join(target, ".env"), existingEnvironment, { mode: 0o600 });
    writeFileSync(join(target, "data", "telegram-gui.session"), existingSession, { mode: 0o600 });

    const result = run("migrate", source, target);

    expect(result.status).toBe(0);
    expect(readFileSync(join(target, ".env"), "utf8")).toBe(existingEnvironment);
    expect(readFileSync(join(target, "data", "telegram-gui.session"))).toEqual(existingSession);
    const record = receipt(target);
    expect(record.files.environment).toEqual({
      path: ".env",
      action: "reused",
      sha256: hash(existingEnvironment),
      mode: "0600"
    });
    expect(record.files.guiSession).toEqual({
      path: "data/telegram-gui.session",
      action: "reused",
      sha256: hash(existingSession),
      mode: "0600"
    });
  });

  it("fails closed for invalid source or existing target configuration", () => {
    const first = fixture();
    writeFileSync(join(first.source, ".env"), environmentText(environment({
      TELEGRAM_API_HASH: "invalid"
    })), { mode: 0o600 });
    expect(run("migrate", first.source, first.target).status).toBe(1);
    expect(existsSync(first.target)).toBe(false);

    const second = fixture();
    mkdirSync(second.target, { mode: 0o700 });
    writeFileSync(join(second.target, ".env"), environmentText(), { mode: 0o600 });
    const result = run("migrate", second.source, second.target);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ENVIRONMENT_NOT_GUI_ONLY");
    expect(existsSync(join(second.target, "migration-receipt.json"))).toBe(false);
  });

  it.each([
    ["export prefix", "export TELEGRAM_API_ID=12345678"],
    ["space before separator", "TELEGRAM_API_ID =12345678"]
  ])("rejects a native-incompatible existing environment with %s", (_label, firstLine) => {
    const { source, target } = fixture();
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, ".env"), [
      firstLine,
      `TELEGRAM_API_HASH=${apiHash}`,
      "TELEGRAM_CHAT_ID=-1001234567890",
      "TELEGRAM_ALLOWED_USER_IDS=123456",
      ""
    ].join("\n"), { mode: 0o600 });

    const result = run("migrate", source, target);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("CHATKJB_MACOS_STATE_ERROR ENVIRONMENT_NATIVE_INCOMPATIBLE\n");
    expect(existsSync(join(target, "migration-receipt.json"))).toBe(false);
  });

  it("rejects symlinked targets and unsafe directory or file permissions", () => {
    const linked = fixture();
    const realTarget = join(linked.directory, "real-target");
    mkdirSync(realTarget, { mode: 0o700 });
    symlinkSync(realTarget, linked.target);
    expect(run("migrate", linked.source, linked.target).status).toBe(1);
    expect(existsSync(join(realTarget, ".env"))).toBe(false);

    const directoryMode = fixture();
    mkdirSync(directoryMode.target, { mode: 0o700 });
    chmodSync(directoryMode.target, 0o755);
    expect(run("migrate", directoryMode.source, directoryMode.target).status).toBe(1);

    const fileMode = fixture();
    mkdirSync(fileMode.target, { mode: 0o700 });
    writeFileSync(join(fileMode.target, ".env"), environmentText({
      TELEGRAM_API_ID: "12345678",
      TELEGRAM_API_HASH: apiHash,
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_ALLOWED_USER_ID: "123456"
    }), { mode: 0o600 });
    chmodSync(join(fileMode.target, ".env"), 0o644);
    expect(run("migrate", fileMode.source, fileMode.target).status).toBe(1);
  });

  it("does not expose source secrets or session content in argv, output, errors, or the receipt", () => {
    const { source, target } = fixture();
    const result = run("migrate", source, target);
    const commandLine = [script, "migrate", "--source", source, "--target", target].join(" ");
    const observable = `${commandLine}\n${result.stdout}\n${result.stderr}\n${JSON.stringify(receipt(target))}`;

    expect(observable).not.toContain(secretSentinel);
    expect(observable).not.toContain(sessionSentinel);
    expect(readFileSync(join(target, ".env"), "utf8")).not.toContain(secretSentinel);
  });

  it("uses a safe custom GUI session path and ignores a stale default session", () => {
    const { source, target } = fixture();
    const customDirectory = join(source, "custom");
    const customSession = Buffer.from("custom-active-gui-session");
    mkdirSync(customDirectory, { mode: 0o700 });
    writeFileSync(join(customDirectory, "active.session"), customSession, { mode: 0o600 });
    writeFileSync(join(source, ".env"), environmentText({
      ...environment(),
      TELEGRAM_GUI_SESSION_PATH: "./custom/active.session"
    }), { mode: 0o600 });

    const result = run("migrate", source, target);

    expect(result.status).toBe(0);
    expect(readFileSync(join(target, "data", "telegram-gui.session"))).toEqual(customSession);
    expect(readFileSync(join(target, ".env"), "utf8")).not.toContain("TELEGRAM_GUI_SESSION_PATH");
  });

  it("accepts a safe absolute custom GUI session path inside an allowed source scope", () => {
    const { source, target } = fixture();
    const absoluteSession = join(source, "absolute-active.session");
    const activeSession = Buffer.from("absolute-active-gui-session");
    writeFileSync(absoluteSession, activeSession, { mode: 0o600 });
    writeFileSync(join(source, ".env"), environmentText({
      ...environment(),
      TELEGRAM_GUI_SESSION_PATH: absoluteSession
    }), { mode: 0o600 });

    expect(run("migrate", source, target).status).toBe(0);
    expect(readFileSync(join(target, "data", "telegram-gui.session"))).toEqual(activeSession);
  });

  it("rejects a custom GUI session below a symlinked source parent", () => {
    const { directory, source, target } = fixture();
    const externalDirectory = join(directory, "external-source");
    mkdirSync(externalDirectory, { mode: 0o700 });
    const externalCanary = join(externalDirectory, "active.session");
    writeFileSync(externalCanary, "external-active-session", { mode: 0o600 });
    symlinkSync(externalDirectory, join(source, "linked-source"));
    writeFileSync(join(source, ".env"), environmentText({
      ...environment(),
      TELEGRAM_GUI_SESSION_PATH: "./linked-source/active.session"
    }), { mode: 0o600 });

    const result = run("migrate", source, target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SYMLINK_FORBIDDEN");
    expect(readFileSync(externalCanary, "utf8")).toBe("external-active-session");
  });

  it.each([
    ["relative traversal", "../outside.session"],
    ["empty path", ""]
  ])("rejects an unsafe custom GUI session path with %s", (_label, configuredPath) => {
    const { directory, source, target } = fixture();
    writeFileSync(join(directory, "outside.session"), "outside", { mode: 0o600 });
    writeFileSync(join(source, ".env"), environmentText({
      ...environment(),
      TELEGRAM_GUI_SESSION_PATH: configuredPath
    }), { mode: 0o600 });

    const result = run("migrate", source, target);

    expect(result.status).toBe(1);
    expect(existsSync(join(target, "data", "telegram-gui.session"))).toBe(false);
  });

  it("rolls back only files created by the receipt and leaves reused files intact", () => {
    const { source, target } = fixture();
    mkdirSync(target, { mode: 0o700 });
    const existingEnvironment = environmentText({
      TELEGRAM_API_ID: "12345678",
      TELEGRAM_API_HASH: apiHash,
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_ALLOWED_USER_ID: "123456"
    });
    writeFileSync(join(target, ".env"), existingEnvironment, { mode: 0o600 });
    expect(run("migrate", source, target).status).toBe(0);

    const result = run("rollback", null, target);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("CHATKJB_MACOS_STATE_ROLLBACK_OK removed=1\n");
    expect(readFileSync(join(target, ".env"), "utf8")).toBe(existingEnvironment);
    expect(existsSync(join(target, "data", "telegram-gui.session"))).toBe(false);
    expect(existsSync(join(target, "migration-receipt.json"))).toBe(true);
  });

  it("refuses the whole rollback when a created file has a user change", () => {
    const { source, target } = fixture();
    expect(run("migrate", source, target).status).toBe(0);
    const changedSession = "user-changed-session";
    writeFileSync(join(target, "data", "telegram-gui.session"), changedSession, { mode: 0o600 });

    const result = run("rollback", null, target);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("CHATKJB_MACOS_STATE_ERROR ROLLBACK_USER_CHANGE_DETECTED\n");
    expect(existsSync(join(target, ".env"))).toBe(true);
    expect(readFileSync(join(target, "data", "telegram-gui.session"), "utf8")).toBe(changedSession);
  });

  it("refuses rollback after the data directory is replaced by a symlink", () => {
    const { directory, source, target } = fixture();
    expect(run("migrate", source, target).status).toBe(0);
    const originalSession = readFileSync(join(target, "data", "telegram-gui.session"));
    const preservedDataDirectory = join(target, "preserved-data");
    const externalDirectory = join(directory, "external-data");
    renameSync(join(target, "data"), preservedDataDirectory);
    mkdirSync(externalDirectory, { mode: 0o700 });
    const externalCanary = join(externalDirectory, "telegram-gui.session");
    writeFileSync(externalCanary, originalSession, { mode: 0o600 });
    symlinkSync(externalDirectory, join(target, "data"));

    const result = run("rollback", null, target);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ROLLBACK_DIRECTORY_UNSAFE");
    expect(readFileSync(externalCanary)).toEqual(originalSession);
    expect(existsSync(join(target, ".env"))).toBe(true);
    expect(existsSync(join(preservedDataDirectory, "telegram-gui.session"))).toBe(true);
  });
});
