import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readTelegramSession,
  removeTelegramSession,
  writeTelegramSession
} from "../src/gui/telegram-session.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-gui-session-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Telegram GUI session storage", () => {
  it("returns an empty string for a missing session and reads a 0600 file trimmed", async () => {
    const path = join(temporaryDirectory(), "nested", "user.session");

    await expect(readTelegramSession(path)).resolves.toBe("");
    await writeTelegramSession(path, "  session-value  ");

    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("session-value\n");
    await expect(readTelegramSession(path)).resolves.toBe("session-value");
  });

  it("rejects a session file whose permissions are not exactly 0600", async () => {
    const path = join(temporaryDirectory(), "user.session");
    writeFileSync(path, "session-value\n", { mode: 0o600 });
    chmodSync(path, 0o640);

    await expect(readTelegramSession(path)).rejects.toThrow(/permissions must be 0600/);
  });

  it("atomically replaces an existing file without leaving a temporary file", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "user.session");
    writeFileSync(path, "old-session\n", { mode: 0o600 });

    await writeTelegramSession(path, "new-session");

    expect(readFileSync(path, "utf8")).toBe("new-session\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(directory)).toEqual([basename(path)]);
  });

  it("rejects empty and whitespace-only session values", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "user.session");

    await expect(writeTelegramSession(path, "")).rejects.toThrow(/persistent session/);
    await expect(writeTelegramSession(path, "  \n\t")).rejects.toThrow(/persistent session/);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("fails closed for symbolic links", async () => {
    const directory = temporaryDirectory();
    const target = join(directory, "target.session");
    const path = join(directory, "user.session");
    writeFileSync(target, "target-session\n", { mode: 0o600 });
    symlinkSync(target, path);

    await expect(readTelegramSession(path)).rejects.toThrow(/regular file/);
    await expect(writeTelegramSession(path, "replacement-session")).rejects.toThrow(/regular file/);
    await expect(removeTelegramSession(path)).rejects.toThrow(/regular file/);
    expect(readFileSync(target, "utf8")).toBe("target-session\n");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it("fails closed for non-regular files without leaving a temporary file", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "user.session");
    mkdirSync(path);

    await expect(readTelegramSession(path)).rejects.toThrow(/regular file/);
    await expect(writeTelegramSession(path, "replacement-session")).rejects.toThrow(/regular file/);
    await expect(removeTelegramSession(path)).rejects.toThrow(/regular file/);
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readdirSync(directory)).toEqual([basename(path)]);
  });

  it("removes a regular session and ignores a missing one", async () => {
    const path = join(temporaryDirectory(), "user.session");
    writeFileSync(path, "session-value\n", { mode: 0o600 });

    await removeTelegramSession(path);
    await expect(readTelegramSession(path)).resolves.toBe("");
    await expect(removeTelegramSession(path)).resolves.toBeUndefined();
  });
});
