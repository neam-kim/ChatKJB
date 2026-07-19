#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceApp = join(projectDir, ".artifacts", "ChatKJB Terminal.app");
if (!existsSync(sourceApp)) throw new Error("Build ChatKJB Terminal.app before running its smoke test");

const smokeRoot = mkdtempSync(join(tmpdir(), "chatkjb-portable-smoke-"));
const relocatedDirectory = join(smokeRoot, "Portable App Copy");
const appPath = join(relocatedDirectory, "ChatKJB Terminal.app");
const executable = join(appPath, "Contents", "MacOS", "ChatKJBTerminal");
const runtimePath = join(appPath, "Contents", "Resources", "Runtime", "node");
const backendPath = join(appPath, "Contents", "Resources", "Backend", "gui-entry.mjs");
const configRoot = join(smokeRoot, "Config Root");
const configurationSelfTestRoot = join(smokeRoot, "Configuration Self Test");
const homeRoot = join(smokeRoot, "Home");
const temporaryRoot = join(smokeRoot, "Tmp");

for (const path of [relocatedDirectory, configRoot, homeRoot, temporaryRoot]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
cpSync(sourceApp, appPath, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
writeFileSync(join(configRoot, ".env"), [
  "TELEGRAM_API_ID=12345678",
  "TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef",
  "TELEGRAM_CHAT_ID=-1001234567890",
  "TELEGRAM_ALLOWED_USER_IDS=123456",
  ""
].join("\n"), { mode: 0o600, flag: "wx" });

const smokeEnvironment = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: homeRoot,
  TMPDIR: temporaryRoot,
  USER: "chatkjb-smoke",
  LOGNAME: "chatkjb-smoke",
  LANG: "C",
  CHATKJB_CONFIG_BASE_DIR: configRoot
};

function processRows() {
  return execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
    });
}

function guiBackends() {
  return processRows().filter((row) =>
    row.command.includes(runtimePath)
    && row.command.includes(backendPath)
    && row.command.includes("--control-fd 3")
  );
}

function guiSupervisors() {
  return processRows().filter((row) => row.command.includes(executable) && row.command.includes("--backend-supervisor"));
}

function guiProcesses() {
  return [...guiSupervisors(), ...guiBackends()].sort((left, right) => left.pid - right.pid);
}

function botPids() {
  const botEntry = join(projectDir, "dist", "index.js");
  return processRows().filter((row) => row.command.includes(botEntry)).map((row) => row.pid).sort((a, b) => a - b);
}

function assertPortableProcess(row) {
  if (
    row.command.includes(projectDir)
    || row.command.includes(process.execPath)
    || row.command.includes("/.nvm/")
  ) throw new Error(`Relocated app process leaked a build-host runtime path: pid ${row.pid}`);
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function waitForExit(child, timeoutMs = 25_000) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("ChatKJB Terminal did not exit in time")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}

function spawnApp(arguments_, stdio = "ignore") {
  return spawn(executable, arguments_, {
    cwd: configRoot,
    env: smokeEnvironment,
    stdio
  });
}

function runRuntimeSelfTest() {
  const result = spawnSync(runtimePath, [backendPath, "--runtime-self-test"], {
    cwd: configRoot,
    env: smokeEnvironment,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024
  });
  if (result.status !== 0 || !result.stdout.includes("CHATKJB_GUI_RUNTIME_SELF_TEST_OK")) {
    throw new Error("Relocated bundled backend runtime self-test failed");
  }
}

function runConfigurationSelfTest() {
  const result = spawnSync(executable, ["--config-self-test", configurationSelfTestRoot], {
    cwd: smokeRoot,
    env: smokeEnvironment,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 64 * 1024
  });
  if (result.status !== 0 || !result.stdout.includes("CHATKJB_GUI_CONFIG_SELF_TEST_OK")) {
    throw new Error("Relocated native configuration self-test failed");
  }
}

async function runNormalSmoke() {
  const child = spawnApp(["--smoke-test"], ["ignore", "pipe", "pipe"]);
  let output = "";
  child.stdout.on("data", (chunk) => { if (output.length < 16_384) output += String(chunk); });
  child.stderr.on("data", () => {});
  try {
    const result = await waitForExit(child);
    const authTransition = output.includes("CHATKJB_GUI_SMOKE_AUTH_SIGNED_OUT")
      || output.includes("CHATKJB_GUI_SMOKE_AUTH_READY");
    if (result.code !== 0 || !authTransition || !output.includes("CHATKJB_GUI_SMOKE_READY")) {
      throw new Error("Relocated WKWebView smoke did not reach both the auth transition and ready page");
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function runParentLossSmoke() {
  const child = spawnApp(["--lifecycle-test"]);
  try {
    const supervisor = await waitFor(
      () => guiSupervisors().find((row) => row.ppid === child.pid),
      "relocated GUI backend supervisor"
    );
    const backend = await waitFor(
      () => guiBackends().find((row) => row.pgid === supervisor.pgid),
      "relocated GUI Node backend"
    );
    assertPortableProcess(supervisor);
    assertPortableProcess(backend);
    process.kill(child.pid, "SIGKILL");
    await waitFor(
      () => !processRows().some((row) => row.pgid === supervisor.pgid),
      "pre-JavaScript orphan cleanup",
      8_000
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function runBackendCrashSmoke() {
  const child = spawnApp(["--lifecycle-test"]);
  try {
    const supervisor = await waitFor(
      () => guiSupervisors().find((row) => row.ppid === child.pid),
      "relocated GUI backend process group"
    );
    await waitFor(() => guiBackends().find((row) => row.pgid === supervisor.pgid), "relocated GUI backend");
    process.kill(-supervisor.pgid, "SIGKILL");
    await waitForExit(child, 8_000);
    await waitFor(
      () => !processRows().some((row) => row.pgid === supervisor.pgid),
      "crashed backend group cleanup",
      8_000
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

async function runSupervisorCrashSmoke() {
  const child = spawnApp(["--lifecycle-test"]);
  try {
    const supervisor = await waitFor(
      () => guiSupervisors().find((row) => row.ppid === child.pid),
      "relocated GUI backend supervisor-only crash target"
    );
    const backend = await waitFor(
      () => guiBackends().find((row) => row.pgid === supervisor.pgid),
      "relocated GUI Node in supervisor process group"
    );
    assertPortableProcess(supervisor);
    assertPortableProcess(backend);
    process.kill(supervisor.pid, "SIGKILL");
    await waitForExit(child, 8_000);
    await waitFor(
      () => !processRows().some((row) => row.pgid === supervisor.pgid),
      "supervisor-only crash cleanup",
      8_000
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function terminateRelocatedProcessGroups() {
  for (const pgid of new Set(guiProcesses().map((row) => row.pgid))) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
}

const botBefore = botPids();
try {
  runConfigurationSelfTest();
  runRuntimeSelfTest();
  await runNormalSmoke();
  await runParentLossSmoke();
  await runBackendCrashSmoke();
  await runSupervisorCrashSmoke();
  await runNormalSmoke();
  await waitFor(() => guiProcesses().length === 0, "relocated GUI process cleanup");
  if (JSON.stringify(botPids()) !== JSON.stringify(botBefore)) {
    throw new Error("macOS smoke changed the existing ChatKJB bot process");
  }
} finally {
  terminateRelocatedProcessGroups();
  rmSync(smokeRoot, { recursive: true, force: true });
}

process.stdout.write("ChatKJB Terminal portable macOS smoke passed: repo-external path with spaces, isolated config, runtime self-test, auth transition, WKWebView ready, normal stop, parent loss, backend/supervisor crash and relaunch, no GUI orphan\n");
