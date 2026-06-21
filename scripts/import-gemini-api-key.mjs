#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const source = resolve(process.argv[2] ?? "");
if (!source || !existsSync(source)) {
  throw new Error("Usage: import-gemini-api-key.mjs <rtf-or-text-file>");
}

const converted = spawnSync(
  "/usr/bin/textutil",
  ["-convert", "txt", "-stdout", source],
  { encoding: "utf8" }
);
if (converted.status !== 0) {
  throw new Error(converted.stderr || "Failed to read Gemini API key source.");
}

const key = converted.stdout.replace(/\s+/g, "").trim();
if (!/^[A-Za-z0-9._-]{30,}$/.test(key)) {
  throw new Error("The source does not contain a valid-looking Gemini API key.");
}

const envPath = resolve(".env");
const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const line = `GEMINI_API_KEY=${key}`;
const next = /^GEMINI_API_KEY=.*$/m.test(existing)
  ? existing.replace(/^GEMINI_API_KEY=.*$/m, line)
  : `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n" : ""}${line}\n`;

writeFileSync(envPath, next, { mode: 0o600 });
chmodSync(envPath, 0o600);
console.log("Gemini API key imported into .env with mode 0600.");
