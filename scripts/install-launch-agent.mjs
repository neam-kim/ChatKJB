import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const label = "com.neam.telegram-claude-orchestrator";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const agentDir = join(homedir(), "Library", "LaunchAgents");
const agentPath = join(agentDir, `${label}.plist`);
const runtimeDir = join(homedir(), ".local", "share", "telegram-claude-orchestrator", "runtime");
const runtimeDist = join(runtimeDir, "dist");
const runtimePreload = join(runtimeDir, "ensure-local-node-modules.mjs");
const runtimeEnv = join(runtimeDir, ".env");
const runtimeProjects = join(runtimeDir, "projects.json");
const runtimeData = join(runtimeDir, "data");
const projectNodeModules = join(projectDir, "node_modules");
const localNodeModules = join(homedir(), ".local", "share", "telegram-claude-orchestrator", "node_modules");
const uid = process.getuid?.();

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function relocate(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function nodeModulesBackupPath() {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? stamp : `${stamp}-${index}`;
    const candidate = `${projectNodeModules}.cloudstorage-broken-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("node_modules 백업 경로를 만들 수 없습니다.");
}

function ensureLocalNodeModules() {
  const stat = existsSync(projectNodeModules) ? lstatSync(projectNodeModules) : null;
  if (stat?.isSymbolicLink()) return;

  mkdirSync(dirname(localNodeModules), { recursive: true });
  if (!stat) {
    if (existsSync(localNodeModules)) symlinkSync(localNodeModules, projectNodeModules);
    return;
  }
  if (!stat.isDirectory()) return;

  if (existsSync(localNodeModules)) {
    const backup = nodeModulesBackupPath();
    renameSync(projectNodeModules, backup);
    symlinkSync(localNodeModules, projectNodeModules);
    console.log(`node_modules preserved: ${localNodeModules}`);
    console.log(`cloud node_modules moved aside: ${backup}`);
    return;
  }

  relocate(projectNodeModules, localNodeModules);
  symlinkSync(localNodeModules, projectNodeModules);
  console.log(`node_modules relocated: ${localNodeModules}`);
}

function copyRuntimeConfig() {
  const projectEnv = join(projectDir, ".env");
  if (existsSync(projectEnv)) {
    copyFileSync(projectEnv, runtimeEnv);
    chmodSync(runtimeEnv, 0o600);
  }

  if (!existsSync(runtimeProjects)) {
    const projectProjects = join(projectDir, "projects.json");
    if (existsSync(projectProjects)) copyFileSync(projectProjects, runtimeProjects);
  }

  if (!existsSync(runtimeData)) {
    const projectData = join(projectDir, "data");
    if (existsSync(projectData)) cpSync(projectData, runtimeData, { recursive: true });
  }
}

ensureLocalNodeModules();
mkdirSync(join(projectDir, "data"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
copyRuntimeConfig();
rmSync(runtimeDist, { recursive: true, force: true });
cpSync(join(projectDir, "dist"), runtimeDist, { recursive: true });
copyFileSync(join(projectDir, "scripts", "ensure-local-node-modules.mjs"), runtimePreload);
chmodSync(runtimePreload, 0o644);

// 프로젝트가 iCloud/SynologyDrive 등 File Provider(CloudStorage) 경로에 있으면,
// launchd(xpcproxy)는 exec 전에 StandardOut/ErrPath 로그 파일을 그 경로에 직접 열려다
// EX_CONFIG(78)로 실패한다(아무 로그도 안 남고 재시작만 반복). 실행 중인 node 프로세스는
// CloudStorage에 정상 기록하므로 sqlite DB(data/)는 그대로 두되, launchd가 직접 여는
// 로그만 CloudStorage 밖(~/Library/Logs/<label>/)으로 뺀다. doctor.ts도 같은 경로를 읽는다.
const logDir = join(homedir(), "Library", "Logs", label);
mkdirSync(logDir, { recursive: true });
const stdoutLog = join(logDir, "stdout.log");
const stderrLog = join(logDir, "stderr.log");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CHATKJB_PROJECT_DIR</key>
    <string>${xml(projectDir)}</string>
    <key>CHATKJB_ENV_PATH</key>
    <string>${xml(runtimeEnv)}</string>
    <key>CHATKJB_CONFIG_BASE_DIR</key>
    <string>${xml(runtimeDir)}</string>
    <key>CHATKJB_SKIP_PROJECT_DIRECTORY_VALIDATION</key>
    <string>1</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>--import</string>
    <string>${xml(pathToFileURL(runtimePreload).href)}</string>
    <string>${xml(join(runtimeDist, "index.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <!-- launchd가 띄운 프로세스의 기본 NOFILE 소프트 리밋은 256이다. /synth는 Claude·Codex·agy
       서브프로세스(각자 파이프 fd)와 다수의 동시 모듈 읽기를 한꺼번에 일으켜 그 한계를 건드릴
       수 있고, 그 순간 저수준 read 실패(errno 11)가 봇을 내린 정황이 있다. 넉넉히 올린다. -->
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrLog)}</string>
</dict>
</plist>
`;

writeFileSync(agentPath, plist, { encoding: "utf8", mode: 0o644 });
chmodSync(agentPath, 0o644);

if (uid === undefined) {
  throw new Error("현재 사용자 ID를 확인할 수 없습니다.");
}

const target = `gui/${uid}/${label}`;
try {
  execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
} catch {
  // The agent may not be loaded yet.
}
let lastBootstrapError;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  try {
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, agentPath], { stdio: "inherit" });
    lastBootstrapError = undefined;
    break;
  } catch (error) {
    lastBootstrapError = error;
    if (attempt === 5) break;
    sleepMs(attempt * 500);
  }
}
if (lastBootstrapError) throw lastBootstrapError;
console.log(`LaunchAgent installed: ${agentPath}`);
