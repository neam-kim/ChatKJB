#!/usr/bin/env node
// sync-agents.mjs(에이전트 리컨실러)를 매일 정해진 시각에 실행하는 LaunchAgent를 설치한다.
// 오케스트레이터 본체/덤프 에이전트와 같은 규약:
//   - node 경로는 이 스크립트를 실행한 런타임(process.execPath).
//   - 기본 로그는 ~/Library/Logs/<label>/, CHATKJB_LOG_ROOT 설정 시 해당 경로를 사용.
//   - 기본 스케줄 04:15(덤프 03시 종료 ~ 세션정리 05시 사이 빈 시간대).
//
// 사용: node scripts/install-agent-sync-agent.mjs
//       node scripts/install-agent-sync-agent.mjs --hour 4 --minute 15

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAgentConfig } from "./launch-agent-paths.mjs";
import { buildDaemonApp } from "./build-daemon-app.mjs";

const label = "com.chatkjb.agent-sync";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 봇 데몬과 같은 ChatKJB.app 번들을 통해 실행한다. Node를 직접 실행하면
// macOS 권한 화면에 "node"로만 표시되어 어떤 프로세스인지 구분할 수 없다.
const nodePath = buildDaemonApp({ log: (message) => console.log(message) }).executablePath;
const scriptPath = join(projectDir, "scripts", "sync-agents.mjs");

function argval(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : fallback;
}
const hour = argval("--hour", 4);
const minute = argval("--minute", 15);

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
    <key>CHATKJB_PROJECT_DIR</key>
    <string>${xml(projectDir)}</string>
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
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, agentPath], { stdio: "inherit" });

console.log(`Agent-sync LaunchAgent installed: ${agentPath}`);
console.log(`  schedule: 매일 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
console.log(`  runs: ${nodePath} ${scriptPath}`);
console.log(`  logs: ${launchConfig.logDir}`);
console.log(`수동 실행: launchctl kickstart -k ${target}`);
