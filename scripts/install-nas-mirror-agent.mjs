#!/usr/bin/env node
// mirror-to-nas.mjs를 하루 여러 번 실행하는 LaunchAgent를 설치한다(선택적 NAS 직접 미러).
// 다른 보조 에이전트와 같은 규약: node 경로=process.execPath, 로그는 CloudStorage 밖.
// CHATKJB_LOG_ROOT가 있으면 해당 상위 경로를 사용한다.
//
// 사전 조건: .env 또는 셸에 CHATKJB_NAS_SSH 설정
// 사용: node scripts/install-nas-mirror-agent.mjs
//       node scripts/install-nas-mirror-agent.mjs --hours 2,8,14,20

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchAgentConfig } from "./launch-agent-paths.mjs";

const label = "com.chatkjb.nas-mirror";
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const scriptPath = join(projectDir, "scripts", "mirror-to-nas.mjs");

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  const out = {};
  for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function argstr(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const hours = argstr("--hours", "2,8,14,20")
  .split(",")
  .map((h) => Number(h.trim()))
  .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23);
if (hours.length === 0) throw new Error("--hours 파싱 실패");

const dotenv = loadDotEnv(join(projectDir, ".env"));
const nasSsh = (process.env.CHATKJB_NAS_SSH || dotenv.CHATKJB_NAS_SSH || "").trim();
const nasPort = (process.env.CHATKJB_NAS_PORT || dotenv.CHATKJB_NAS_PORT || "22").trim();
const nasRemoteDir = (
  process.env.CHATKJB_NAS_REMOTE_DIR ||
  dotenv.CHATKJB_NAS_REMOTE_DIR ||
  ""
).trim();
if (!nasSsh) {
  console.error(
    "CHATKJB_NAS_SSH 가 필요합니다. .env에 CHATKJB_NAS_SSH=user@nas-host 를 넣거나 셸에서 export 하십시오."
  );
  console.error("NAS 미러는 선택적 개인 백업 기능이며 일반 설치에는 필요하지 않습니다.");
  process.exit(1);
}

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

const calendar = hours
  .map(
    (h) =>
      `    <dict>\n      <key>Hour</key>\n      <integer>${h}</integer>\n      <key>Minute</key>\n      <integer>0</integer>\n    </dict>`
  )
  .join("\n");

const envEntries = [
  ["CHATKJB_PROJECT_DIR", projectDir],
  ["CHATKJB_NAS_SSH", nasSsh],
  ["CHATKJB_NAS_PORT", nasPort]
];
if (nasRemoteDir) envEntries.push(["CHATKJB_NAS_REMOTE_DIR", nasRemoteDir]);

const envXml = envEntries
  .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
  .join("\n");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectDir)}</string>
  <key>StartCalendarInterval</key>
  <array>
${calendar}
  </array>
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

console.log(`NAS-mirror LaunchAgent installed: ${agentPath}`);
console.log(`  remote: ${nasSsh} port ${nasPort}`);
console.log(`  schedule: 매일 ${hours.map((h) => String(h).padStart(2, "0")).join(",")}:00 (${hours.length}회/일)`);
console.log(`  runs: ${nodePath} ${scriptPath}`);
console.log(`  logs: ${launchConfig.logDir}`);
console.log(`수동 실행: launchctl kickstart -k ${target}`);
