import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function projectSourceDir(): string {
  const configured = process.env.CHATKJB_PROJECT_DIR?.trim();
  const expanded = configured?.replace(/^~(?=\/|$)/, homedir());
  return expanded ? resolve(expanded) : sourceRoot;
}
