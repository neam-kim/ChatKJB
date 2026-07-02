import { resolve } from "node:path";

export function projectSourceDir(): string {
  const configured = process.env.CHATKJB_PROJECT_DIR?.trim();
  return configured ? resolve(configured) : process.cwd();
}
