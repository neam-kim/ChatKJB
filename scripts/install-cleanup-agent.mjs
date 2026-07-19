#!/usr/bin/env node
// 매일 1회 cleanup-old-sessions.mjs를 실행하는 LaunchAgent를 설치한다.
// 덤프 에이전트(install-transcript-dump-agent.mjs)와 같은 규약:
//   - node 경로는 이 스크립트를 실행한 런타임(process.execPath)을 사용.
//   - 기본 로그는 ~/Library/Logs/<label>/, CHATKJB_LOG_ROOT 설정 시 해당 경로를 사용한다.
//   - 덤프는 09~03시에 도므로, 정리는 그 창 밖인 05시(기본)에 돌려 충돌을 피한다.
//
// 사용: node scripts/install-cleanup-agent.mjs
//       node scripts/install-cleanup-agent.mjs --hour 5 --minute 0

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAgentConfig } from "./launch-agent-paths.mjs";
import { buildDaemonApp } from "./build-daemon-app.mjs";

const label = "com.chatkjb.session-cleanup";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 설치를 실행한 런타임이 곧 provider CLI가 설치된 Node다.
const realNodeBin = dirname(process.execPath);
// 봇 데몬과 같은 ChatKJB.app 번들을 통해 실행한다. Node를 직접 실행하면
// macOS 권한 화면에 "node"로만 표시되어 어떤 프로세스인지 구분할 수 없다.
const nodePath = buildDaemonApp({ log: (message) => console.log(message) }).executablePath;
const scriptPath = join(projectDir, "scripts", "cleanup-old-sessions.mjs");

function argval(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
const hour = argval("--hour", 5);
const minute = argval("--minute", 0);

const agentDir = join(homedir(), "Library", "LaunchAgents");
const agentPath = join(agentDir, `${label}.plist`);
const uid = process.getuid?.();
if (uid === undefined) throw new Error("현재 사용자 ID를 확인할 수 없습니다.");

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

mkdirSync(agentDir, { recursive: true });
const launchConfig = launchAgentConfig(projectDir, label, nodePath, [
  nodePath,
  "--no-warnings",
  scriptPath
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
    <!-- 데몬은 ChatKJB.app 번들로 실행되므로 process.execPath로는 provider CLI가 설치된
         Node bin을 알 수 없다. 설치 시점의 실제 Node bin을 넘겨 PATH 조립에 쓴다. -->
    <key>CHATKJB_NODE_BIN</key>
    <string>${xml(realNodeBin)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(launchConfig.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(launchConfig.stderrPath)}</string>
</dict>
</plist>
`;

writeFileSync(agentPath, plist, { encoding: "utf8", mode: 0o644 });
chmodSync(agentPath, 0o644);

const target = `gui/${uid}/${label}`;
try {
  execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
} catch {
  // 아직 로드 전일 수 있음.
}
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, agentPath], {
  stdio: "inherit",
});

console.log(`Session-cleanup LaunchAgent installed: ${agentPath}`);
console.log(
  `  schedule: 매일 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} (호스트 현지 시간)`
);
console.log(`  runs: ${nodePath} ${scriptPath}`);
console.log(`  logs: ${launchConfig.logDir}`);
console.log(`수동 실행: launchctl kickstart -k ${target}`);
console.log(`드라이런: CLEANUP_DRY_RUN=1 ${nodePath} --no-warnings ${scriptPath}`);
