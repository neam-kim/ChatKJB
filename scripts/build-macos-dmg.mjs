#!/usr/bin/env node
// ChatKJB Terminal.app을 배포용 디스크 이미지(.dmg)로 포장한다.
//
// 앱 자체는 scripts/build-macos-app.mjs가 만든 .artifacts/ChatKJB Terminal.app을
// 그대로 쓴다. 이 스크립트는 포장만 담당한다.
//
// 담기는 것
//   · ChatKJB Terminal.app
//   · /Applications 심볼릭 링크 — 창을 열었을 때 끌어다 놓기만 하면 설치되도록
//
// 사용
//   node scripts/build-macos-dmg.mjs [--out <경로>]
//   기본 출력: .artifacts/ChatKJB Terminal.dmg

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appName = "ChatKJB Terminal";
const appPath = join(projectDir, ".artifacts", `${appName}.app`);

function parseOutPath() {
  const index = process.argv.indexOf("--out");
  if (index === -1) return join(projectDir, ".artifacts", `${appName}.dmg`);
  const value = process.argv[index + 1];
  if (!value) throw new Error("--out 다음에 출력 경로가 필요합니다.");
  return resolve(value);
}

const outPath = parseOutPath();

if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
  throw new Error(
    `앱 번들을 찾지 못했습니다: ${appPath}\n먼저 npm run gui:macos:build 를 실행하십시오.`
  );
}

// 서명이 깨진 앱을 그대로 포장해 배포하지 않도록 확인한다.
execFileSync("/usr/bin/codesign", ["--verify", "--deep", appPath], { stdio: "inherit" });

const staging = mkdtempSync(join(tmpdir(), "chatkjb-dmg-"));
try {
  // ditto는 확장 속성과 심링크를 보존한다. cp -r로는 번들이 손상될 수 있다.
  execFileSync("/usr/bin/ditto", [appPath, join(staging, `${appName}.app`)], { stdio: "inherit" });
  symlinkSync("/Applications", join(staging, "Applications"));

  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });

  execFileSync("/usr/bin/hdiutil", [
    "create",
    "-volname", appName,
    "-srcfolder", staging,
    "-fs", "HFS+",
    "-format", "UDZO",   // 압축 읽기 전용 이미지
    "-ov",
    outPath
  ], { stdio: "inherit" });

  execFileSync("/usr/bin/hdiutil", ["verify", outPath], { stdio: "inherit" });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const sizeMb = (statSync(outPath).size / (1024 * 1024)).toFixed(1);
console.log(`disk image built: ${outPath} (${sizeMb} MB)`);
process.stdout.write(`${outPath}\n`);
