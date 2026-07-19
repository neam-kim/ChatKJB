#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

const textExtensions = new Set([
  ".json", ".md", ".mjs", ".mts", ".py", ".sh", ".ts", ".txt", ".yaml", ".yml"
]);
const placeholderUsers = new Set(["example", "me", "tester", "user", "x"]);
// 공개 문서에 의도적으로 싣는 프로젝트 대표 연락처는 개인 식별자로 보지 않는다.
const publicContactEmails = new Set(["contact@kimjb.com"]);
const findings = [];

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean)
  .filter(existsSync)
  .filter((file) => textExtensions.has(extname(file)) || file === ".env.example");

for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
      const user = match[1];
      if (!user || user.startsWith(".") || placeholderUsers.has(user.toLowerCase())) continue;
      findings.push(`${file}:${index + 1}: 개인 홈 절대 경로 (${match[0]})`);
    }
    for (const match of line.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
      if (/@(?:2x|3x)\.(?:png|jpe?g|pdf)$/i.test(match[0])) continue;
      if (publicContactEmails.has(match[0].toLowerCase())) continue;
      const domain = match[1]?.toLowerCase();
      if (!domain || domain === "example.com") continue;
      findings.push(`${file}:${index + 1}: 실제 이메일처럼 보이는 값 (${match[0]})`);
    }
  }
}

if (findings.length > 0) {
  console.error("이식성 감사 실패:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`이식성 감사 통과: 추적 중인 텍스트 파일 ${files.length}개`);
