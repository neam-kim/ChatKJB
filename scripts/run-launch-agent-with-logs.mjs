#!/usr/bin/env node

import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
if (separator < 4 || process.argv[2] === "" || process.argv[3] === "") {
  process.exit(64);
}

const stdoutPath = process.argv[2];
const stderrPath = process.argv[3];
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);
if (!command) process.exit(64);

mkdirSync(dirname(stdoutPath), { recursive: true });
mkdirSync(dirname(stderrPath), { recursive: true });
const stdoutFd = openSync(stdoutPath, "a", 0o600);
const stderrFd = openSync(stderrPath, "a", 0o600);

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["ignore", stdoutFd, stderrFd]
});
closeSync(stdoutFd);
closeSync(stderrFd);

let finished = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"]) {
  process.on(signal, () => {
    if (!finished && child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on("error", (error) => {
  appendFileSync(stderrPath, `[launch-agent-wrapper] ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  finished = true;
  if (code !== null) {
    process.exitCode = code;
    return;
  }
  const signalExitCodes = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 };
  process.exitCode = signalExitCodes[signal] ?? 1;
});
