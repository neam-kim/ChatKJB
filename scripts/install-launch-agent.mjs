import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const label = "com.neam.telegram-claude-orchestrator";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const agentDir = join(homedir(), "Library", "LaunchAgents");
const agentPath = join(agentDir, `${label}.plist`);
const uid = process.getuid?.();

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

mkdirSync(join(projectDir, "data"), { recursive: true });
mkdirSync(agentDir, { recursive: true });

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
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>--import</string>
    <string>${xml(pathToFileURL(join(projectDir, "scripts", "ensure-local-node-modules.mjs")).href)}</string>
    <string>${xml(join(projectDir, "dist", "index.js"))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
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
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, agentPath], { stdio: "inherit" });
console.log(`LaunchAgent installed: ${agentPath}`);
