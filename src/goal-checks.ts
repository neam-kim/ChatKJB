// /goal 목표 평가를 Structure2.md의 Tier 0 철학에 맞게 보강하기 위한 모듈.
// 목표 문자열에 `check: <명령>` 줄을 넣으면 그 명령을 결정론적 게이트로 먼저 실행하고,
// 그 pass/fail 근거를 판관 LLM에 packet으로 전달한다(LLM이 사실을 추측하지 않게 한다).

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { classifyRisk, type RiskSignals } from "./orchestration/engine.js";
import type { RiskLevel } from "./orchestration/types.js";

const execAsync = promisify(exec);

/**
 * 목표 텍스트에서 Structure2.md Risk_Level을 보수적으로 추정한다(순수 함수, 저장소 미접근).
 * 목표 본문의 위험 키워드(security/migration/schema/architecture/public API/통합)와
 * check: 게이트 수만 신호로 쓴다. 키워드가 전혀 없으면 게이트 수에 따라 L1/L2로 떨어진다.
 */
export function estimateGoalRisk(condition: string): RiskLevel {
  const spec = parseGoalChecks(condition);
  const text = condition.toLowerCase();
  // 영문 키워드는 단어 경계(\b)로 부분 오매칭을 막고, 한글 키워드는 토큰 경계가 없으므로
  // 부분 문자열로 매칭한다(\b는 한글 같은 비ASCII에는 작동하지 않으므로 분리한다).
  const hasEn = (...words: string[]) =>
    new RegExp(`\\b(?:${words.join("|")})\\b`).test(text);
  const hasKo = (...words: string[]) => words.some((w) => text.includes(w));
  const signals: RiskSignals = {
    docsOrFormatOnly:
      (hasEn("docs?", "format", "readme", "typo") || hasKo("문서", "포맷", "주석", "오타")) &&
      spec.checks.length === 0,
    securityOrDataIntegrity:
      hasEn("security", "auth", "secret", "data\\s*integrity") ||
      hasKo("보안", "취약", "토큰", "데이터 무결"),
    schemaOrMigration:
      hasEn("schema", "migration", "migrate", "db", "database") ||
      hasKo("스키마", "마이그레이션"),
    architectureChange:
      hasEn("architecture", "refactor") || hasKo("아키텍처", "리팩터", "구조 변경", "재설계"),
    multiService: hasEn("multi-?service", "cross-?service") || hasKo("여러 서비스"),
    publicApiChange:
      hasEn("public\\s*api", "breaking", "backward") || hasKo("공개 api", "호환성"),
    multiFileIntegration:
      hasEn("integration", "multi-?file") || hasKo("통합", "여러 파일", "전반"),
    changedFiles: spec.checks.length
  };
  return classifyRisk(signals);
}

export interface GoalSpec {
  description: string; // check: 줄을 제거한 사람용 목표 텍스트(양끝 trim)
  checks: string[];    // 결정론적 게이트로 실행할 셸 명령(등록 순서, 중복 제거)
}

// 목표 문자열을 정규화한다. 개행은 보존하되 각 줄 안의 연속 공백만 하나로 압축하고 양끝을 trim한다.
// (개행을 통째로 없애면 줄 단위로 추출하는 `check:` 게이트가 깨지므로 줄 구조는 유지한다.)
export function normalizeGoalCondition(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .trim();
}

// 목표 문자열에서 `check:` 명령을 추출한다. 명령이 아닌 줄은 description으로 합친다.
export function parseGoalChecks(raw: string): GoalSpec {
  if (!raw.trim()) {
    return { description: "", checks: [] };
  }
  const lines = raw.split("\n");
  const checks: string[] = [];
  const descriptionLines: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^check:\s*(.+)$/i.exec(line.trim());
    if (match && match[1]) {
      const command = match[1].trim();
      if (command && !seen.has(command)) {
        checks.push(command);
        seen.add(command);
      }
    } else {
      descriptionLines.push(line);
    }
  }
  return {
    description: descriptionLines.join("\n").trim(),
    checks
  };
}

export interface CheckResult {
  command: string;
  passed: boolean;     // 종료코드 0이면 true
  outputTail: string;  // stdout+stderr 결합의 마지막 ~500자(trim)
}

export interface CheckRunResult {
  allPassed: boolean;  // 모든 검사 통과 시 true(검사가 없으면 공허하게 true)
  results: CheckResult[];
}

/**
 * LLM 판정 텍스트(또는 결정론적 판정 텍스트)에서 GOAL_MET/GOAL_UNMET 결과를 추출한다.
 * 마지막 GOAL_(MET|UNMET) 줄을 찾아 { met, reason }을 반환한다.
 */
export function parseGoalVerdict(text: string): { met: boolean; reason: string } {
  const lines = text.split("\n").map((l) => l.trim());
  const line =
    [...lines].reverse().find((l) => /^GOAL_(MET|UNMET)/i.test(l)) ?? text.trim();
  if (/^GOAL_MET/i.test(line)) {
    return { met: true, reason: line.replace(/^GOAL_MET:?\s*/i, "").trim() || "조건 충족" };
  }
  return {
    met: false,
    reason: line.replace(/^GOAL_UNMET:?\s*/i, "").trim() || text.trim().slice(0, 200)
  };
}

// 결정론적 게이트: 각 셸 명령을 cwd에서 순차 실행해 pass/fail과 출력 꼬리를 모은다.
export async function runGoalChecks(
  checks: string[],
  cwd: string,
  timeoutMs = 120000
): Promise<CheckRunResult> {
  if (checks.length === 0) {
    return { allPassed: true, results: [] };
  }
  const results: CheckResult[] = [];
  for (const command of checks) {
    let stdout = "";
    let stderr = "";
    let message = "";
    let passed = false;
    try {
      const out = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024
      });
      stdout = out.stdout ?? "";
      stderr = out.stderr ?? "";
      passed = true;
    } catch (err: unknown) {
      if (err && typeof err === "object") {
        const record = err as Record<string, unknown>;
        if (typeof record["stdout"] === "string") stdout = record["stdout"];
        if (typeof record["stderr"] === "string") stderr = record["stderr"];
        if (typeof record["message"] === "string") message = record["message"];
      }
    }
    const combined = (stdout + stderr).trim();
    const tail = (combined || message).trim().slice(-500);
    results.push({ command, passed, outputTail: tail });
  }
  return { allPassed: results.every((r) => r.passed), results };
}
