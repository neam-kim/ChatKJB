#!/usr/bin/env node
// 09:00~03:00(다음날) 세 시간 간격으로 dump-transcripts.mjs를 실행하는 LaunchAgent를 설치한다.
// 오케스트레이터 본체 LaunchAgent(install-launch-agent.mjs)와 같은 규약을 따른다:
//   - node 경로는 이 스크립트를 실행한 런타임(process.execPath)을 사용.
//   - CloudStorage(File Provider) 경로에 launchd가 직접 로그를 열면 EX_CONFIG(78)로
//     실패하므로 StandardOut/ErrPath는 ~/Library/Logs/<label>/ 로 뺀다.
//
// 사용: node scripts/install-transcript-dump-agent.mjs
//       node scripts/install-transcript-dump-agent.mjs --start-hour 9 --end-hour 3 --minute 0 --interval-hours 3

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const label = "com.neam.telegram-claude-orchestrator.transcript-dump";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const scriptPath = join(projectDir, "scripts", "dump-transcripts.mjs");
const runtimeDir = join(homedir(), ".local", "share", "telegram-claude-orchestrator", "runtime");

function argval(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
}
// 09:00부터 03:00까지(다음날) 세 시간 간격으로 실행한다. 04~08시는 건너뛴다.
const startHour = argval("--start-hour", 9);
const endHour = argval("--end-hour", 3);
const minute = argval("--minute", 0);
const intervalHours = argval("--interval-hours", 3);

function hourRange(start, end, step) {
  if (!Number.isInteger(step) || step < 1 || step > 23) {
    throw new Error("--interval-hours는 1~23 사이의 정수여야 합니다.");
  }
  const hours = [];
  let h = start;
  for (let i = 0; i < 24; i++) {
    hours.push(h);
    if (h === end) break;
    h = (h + step) % 24;
  }
  return hours;
}
const hours = hourRange(startHour, endHour, intervalHours);

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
mkdirSync(runtimeDir, { recursive: true });
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
    <string>--no-warnings</string>
    <string>${xml(scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDir)}</string>
  <key>StartCalendarInterval</key>
  <array>
${hours
  .map(
    (h) =>
      `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>${minute}</integer>\n    </dict>`
  )
  .join("\n")}
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(stderrLog)}</string>
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

console.log(`Transcript-dump LaunchAgent installed: ${agentPath}`);
console.log(
  `  schedule: ${intervalHours}시간 간격 ${hours.map((h) => String(h).padStart(2, "0")).join(",")}:${String(minute).padStart(2, "0")} (${hours.length}회/일)`
);
console.log(`  runs: ${nodePath} ${scriptPath}`);
console.log(`  logs: ${logDir}`);
console.log(`수동 실행: launchctl kickstart -k ${target}`);
