#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function npmRun(script, ...args) {
  execFileSync("npm", ["run", script, ...args], { cwd: projectDir, stdio: "inherit" });
}

npmRun("typecheck");
npmRun("test");
npmRun("build");
npmRun("gui:render:check");
npmRun("gui:macos:smoke");
npmRun("gui:macos:audit");
npmRun("audit:portability");
execFileSync("/usr/bin/git", ["diff", "--check"], { cwd: projectDir, stdio: "inherit" });

process.stdout.write("ChatKJB Terminal final quality gate passed\n");
