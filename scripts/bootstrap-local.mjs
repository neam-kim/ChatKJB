#!/usr/bin/env node
// 첫 설치용 로컬 파일 준비. 시크릿·개인 경로는 만들지 않고 예제만 복사한다.
//
// 사용: npm run setup
//  - .env.example → .env (없을 때만)
//  - projects.example.json → projects.json (없을 때만)
//  - data/ 디렉터리 생성
//  - 다음 단계 체크리스트 출력

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envExample = join(projectDir, ".env.example");
const envPath = join(projectDir, ".env");
const projectsExample = join(projectDir, "projects.example.json");
const projectsPath = join(projectDir, "projects.json");
const dataDir = join(projectDir, "data");

const steps = [];

if (!existsSync(envExample)) {
  console.error(".env.example 이 없습니다. 저장소가 손상되었을 수 있습니다.");
  process.exit(1);
}

if (!existsSync(envPath)) {
  copyFileSync(envExample, envPath);
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* Windows 등에서 chmod 실패해도 계속 */
  }
  steps.push("created .env (from .env.example, mode 0600)");
} else {
  steps.push("kept existing .env");
}

if (!existsSync(projectsPath)) {
  if (!existsSync(projectsExample)) {
    console.error("projects.example.json 이 없습니다.");
    process.exit(1);
  }
  copyFileSync(projectsExample, projectsPath);
  steps.push("created projects.json (from projects.example.json)");
} else {
  steps.push("kept existing projects.json");
}

mkdirSync(dataDir, { recursive: true });
steps.push("ensured data/");

console.log("ChatKJB local bootstrap");
for (const step of steps) console.log(`  · ${step}`);
console.log("");
console.log("다음 단계 (본인 값만 채우면 됩니다):");
console.log("  1. .env  — Telegram 설정과 사용할 AI 제공자 인증(Claude/Codex/Antigravity/Grok 중 하나 이상)");
console.log("  2. projects.json  — 선택 사항. 비워 두고 Telegram /new에서 폴더를 골라도 됩니다.");
console.log("  3. 제공자 로그인  — npm run auth:setup / codex login / agy·grok CLI 로그인");
console.log("  4. npm install && npm run build");
console.log("  5. npm start  또는  npm run launchd:install");
console.log("  6. Telegram에서 /doctor 로 점검");
console.log("");
console.log("선택 기능 (일반 설치에 불필요):");
console.log("  · 스킬/MCP: 각자 설치하거나 공유 카탈로그 동기화 후, 인증·API 키만 본인 것 사용");
console.log("  · NAS/CloudStorage 미러: CHATKJB_NAS_SSH / CHATKJB_MIRROR_DEST 설정 후 npm run nas-mirror:install-agent 등");
console.log("");
console.log("자세한 설치: README.md 2부");
