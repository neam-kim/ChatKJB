import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAgentConfig, loadDotEnv } from "./launch-agent-paths.mjs";
import { buildDaemonApp } from "./build-daemon-app.mjs";

const label = "com.chatkjb.bot";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 설치를 실행한 런타임이 곧 provider CLI가 설치된 Node다.
const realNodeBin = dirname(process.execPath);
// /compile 성공 후 KJB Wiki 공개 그래프 배포 스크립트. dotenv에만 있으면 launchd
// 환경에는 안 보이므로, 설치 시 plist에도 넣어 두어 로딩 실패 시에도 후처리가 동작하게 한다.
const dotenvForAgent = loadDotEnv(join(projectDir, ".env"));
const kjbWikiPostCompileScript = (
  process.env.KJB_WIKI_POST_COMPILE_SCRIPT
  || dotenvForAgent.KJB_WIKI_POST_COMPILE_SCRIPT
  || ""
).trim();

// LaunchAgent가 Node 실행 파일을 직접 실행하면 macOS 권한 화면에 "node"로만
// 표시되어 어떤 프로세스인지 구분할 수 없다. Node를 그대로 담은 ChatKJB.app
// 번들을 통해 실행해 권한 화면에 ChatKJB 이름과 아이콘이 나타나게 한다.
const daemonApp = buildDaemonApp({ log: (message) => console.log(message) });
const nodePath = daemonApp.executablePath;
const agentDir = join(homedir(), "Library", "LaunchAgents");
const agentPath = join(agentDir, `${label}.plist`);
const projectNodeModules = join(projectDir, "node_modules");
const localNodeModules = join(homedir(), ".local", "share", "chatkjb", "node_modules");
const legacyRuntimeData = join(
  homedir(),
  ".local",
  "share",
  "telegram-claude-orchestrator",
  "runtime",
  "data"
);
const legacyLabels = new Set(
  (process.env.CHATKJB_LEGACY_LAUNCH_AGENT_LABELS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
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
    const candidate = `${projectNodeModules}.backup-${suffix}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("node_modules 백업 경로를 만들 수 없습니다.");
}

function ensureLocalNodeModules() {
  const stat = existsSync(projectNodeModules) ? lstatSync(projectNodeModules) : null;
  mkdirSync(dirname(localNodeModules), { recursive: true });

  if (stat?.isSymbolicLink()) {
    const target = resolve(dirname(projectNodeModules), readlinkSync(projectNodeModules));
    if (target === localNodeModules) return;
    if (!existsSync(localNodeModules)) relocate(target, localNodeModules);
    unlinkSync(projectNodeModules);
    symlinkSync(localNodeModules, projectNodeModules);
    console.log(`node_modules migrated: ${localNodeModules}`);
    return;
  }

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
    console.log(`project node_modules moved aside: ${backup}`);
    return;
  }

  relocate(projectNodeModules, localNodeModules);
  symlinkSync(localNodeModules, projectNodeModules);
  console.log(`node_modules relocated: ${localNodeModules}`);
}

function migrateNewerLegacyStateDatabase() {
  const source = join(legacyRuntimeData, "state.sqlite");
  const destination = join(projectDir, "data", "state.sqlite");
  if (!existsSync(source)) return;

  const sourceStat = statSync(source);
  const destinationStat = existsSync(destination) ? statSync(destination) : undefined;
  if (destinationStat && sourceStat.mtimeMs <= destinationStat.mtimeMs) return;

  if (destinationStat) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    renameSync(destination, `${destination}.before-direct-launch-${stamp}`);
  }
  rmSync(`${destination}-wal`, { force: true });
  rmSync(`${destination}-shm`, { force: true });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
  console.log("migrated newer session DB from legacy runtime");
}

function removeLegacyProjectAgents() {
  const projectMarker = xml(projectDir);
  for (const entry of readdirSync(agentDir)) {
    if (entry === `${label}.plist` || !entry.endsWith(".plist")) continue;
    const candidate = join(agentDir, entry);
    const legacyLabel = entry.slice(0, -".plist".length);
    if (!legacyLabels.has(legacyLabel)) continue;
    try {
      const plist = readFileSync(candidate, "utf8");
      if (!plist.includes(projectMarker)) continue;
      try {
        execFileSync("launchctl", ["bootout", `gui/${uid}/${legacyLabel}`], { stdio: "ignore" });
      } catch {
        // 등록되지 않은 과거 plist도 아래에서 제거한다.
      }
      rmSync(candidate, { force: true });
      console.log(`removed legacy LaunchAgent: ${legacyLabel}`);
    } catch {
      // 읽을 수 없는 다른 plist는 건드리지 않는다.
    }
  }
}

ensureLocalNodeModules();
mkdirSync(join(projectDir, "data"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
migrateNewerLegacyStateDatabase();

// 기본 로그는 홈에 두되, 직접 접근 가능한 경로는 CHATKJB_LOG_ROOT로 옮길 수 있다.
const launchConfig = launchAgentConfig(projectDir, label, nodePath, [
  nodePath,
  join(projectDir, "dist", "index.js")
]);
mkdirSync(launchConfig.logDir, { recursive: true });
const programArgumentsXml = launchConfig.programArguments
  .map((value) => `    <string>${xml(value)}</string>`)
  .join("\n");

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
    <!-- 데몬은 ChatKJB.app 번들로 실행되므로 process.execPath로는 provider CLI가 설치된
         Node bin을 알 수 없다. 설치 시점의 실제 Node bin을 넘겨 PATH 조립에 쓴다. -->
    <key>CHATKJB_NODE_BIN</key>
    <string>${xml(realNodeBin)}</string>${kjbWikiPostCompileScript ? `
    <key>KJB_WIKI_POST_COMPILE_SCRIPT</key>
    <string>${xml(kjbWikiPostCompileScript)}</string>` : ""}
  </dict>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>8192</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(launchConfig.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(launchConfig.stderrPath)}</string>
</dict>
</plist>
`;

writeFileSync(agentPath, plist, { encoding: "utf8", mode: 0o644 });
chmodSync(agentPath, 0o644);

if (uid === undefined) throw new Error("현재 사용자 ID를 확인할 수 없습니다.");

removeLegacyProjectAgents();

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
