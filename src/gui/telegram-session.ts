import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function isEnoent(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isEloop(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ELOOP";
}

function assertRegularFile(info: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Telegram session must be a regular file: ${path}`);
  }
}

async function assertExistingTargetIsRegular(path: string): Promise<void> {
  try {
    assertRegularFile(await lstat(path), path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

export async function readTelegramSession(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    assertRegularFile(info, path);
    const permissions = info.mode & 0o777;
    if (permissions !== 0o600) {
      throw new Error(
        `Telegram session permissions must be 0600, received ${permissions.toString(8)}: ${path}`
      );
    }
    return (await handle.readFile("utf8")).trim();
  } catch (error) {
    if (isEnoent(error)) return "";
    if (isEloop(error)) {
      throw new Error(`Telegram session must be a regular file: ${path}`);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeTelegramSession(path: string, value: string): Promise<void> {
  const session = value.trim();
  if (!session) {
    throw new Error("Telegram authorization did not produce a persistent session");
  }

  await mkdir(dirname(path), { recursive: true });
  await assertExistingTargetIsRegular(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${session}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function removeTelegramSession(path: string): Promise<void> {
  try {
    assertRegularFile(await lstat(path), path);
    await unlink(path);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}
