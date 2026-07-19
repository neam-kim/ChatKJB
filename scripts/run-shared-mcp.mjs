#!/usr/bin/env node

import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [registryPath, serverName, ...flags] = process.argv.slice(2);
if (!registryPath || !serverName) {
  console.error("usage: run-shared-mcp.mjs <registry.json> <server-name> [--single-owner-per-parent]");
  process.exit(2);
}

let ownerLock = null;

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function releaseOwnerLock() {
  if (!ownerLock) return;
  try {
    const owner = Number.parseInt(readFileSync(join(ownerLock, "pid"), "utf8"), 10);
    if (owner === process.pid) rmSync(ownerLock, { recursive: true, force: true });
  } catch {
    // 이미 정리되었거나 다른 소유자가 회수한 lock은 건드리지 않는다.
  }
  ownerLock = null;
}

function acquireParentOwner() {
  if (!flags.includes("--single-owner-per-parent")) return true;
  const key = createHash("sha256")
    .update(`${process.ppid}\0${registryPath}\0${serverName}`)
    .digest("hex")
    .slice(0, 24);
  const lockPath = join(tmpdir(), `chatkjb-mcp-owner-${key}`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(join(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600 });
      ownerLock = lockPath;
      process.once("exit", releaseOwnerLock);
      return true;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number.parseInt(readFileSync(join(lockPath, "pid"), "utf8"), 10);
      } catch {
        // 생성 도중인 lock은 현재 소유자가 곧 채운다.
      }
      if (processExists(owner) || owner === 0) return false;
      rmSync(lockPath, { recursive: true, force: true });
    }
  }
  return false;
}

// Codex는 현재 custom child의 MCP 비활성화를 부모 상속 위에 적용하지 못한다. 루트의
// wrapper가 먼저 소유권을 잡고, 같은 Codex 프로세스가 띄운 child 중복 wrapper는 즉시
// 정상 종료해 실제 커넥터 프로세스 곱셈을 막는다. 다른 provider에는 이 flag를 쓰지 않는다.
if (!acquireParentOwner()) process.exit(0);

function readSecretEnv(registryPath, serverName) {
  const secretPath = registryPath.replace(/connectors\.json$/, `secrets/${serverName}.env`);
  let text;
  try {
    text = readFileSync(secretPath, "utf8");
  } catch {
    return {};
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return result;
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const server = registry[serverName];
if (!server || server.type !== "stdio" || typeof server.command !== "string") {
  console.error(`shared MCP stdio server not found: ${serverName}`);
  process.exit(2);
}

const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
  env: { ...process.env, ...(server.env ?? {}), ...readSecretEnv(registryPath, serverName) },
  stdio: "inherit",
  detached: true
});

let terminating = false;
let killFallback;

function signalChildTree(signal) {
  if (child.exitCode !== null || child.killed) return;
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error && error.code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

function terminate(signal) {
  if (terminating) return;
  terminating = true;
  signalChildTree(signal);
  killFallback = setTimeout(() => signalChildTree("SIGKILL"), 2_000);
  killFallback.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => terminate(signal));
}

child.on("error", (error) => {
  releaseOwnerLock();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (killFallback) clearTimeout(killFallback);
  releaseOwnerLock();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
