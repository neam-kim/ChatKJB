#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const [registryPath, serverName] = process.argv.slice(2);
if (!registryPath || !serverName) {
  console.error("usage: run-shared-mcp.mjs <registry.json> <server-name>");
  process.exit(2);
}

const registry = JSON.parse(readFileSync(registryPath, "utf8"));
const server = registry[serverName];
if (!server || server.type !== "stdio" || typeof server.command !== "string") {
  console.error(`shared MCP stdio server not found: ${serverName}`);
  process.exit(2);
}

const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
  env: { ...process.env, ...(server.env ?? {}) },
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
