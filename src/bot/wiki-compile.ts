import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POST_COMPILE_TIMEOUT_MS = 10 * 60 * 1000;

/** Telegram Bot API sendMessage 본문 상한(UTF-16 코드 유닛 기준, JS string length와 동일). */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** 재시도해도 의미 없는 클라이언트 오류(길이 초과·잘못된 요청 등). */
const NON_RETRYABLE_TELEGRAM_CODES = new Set([400, 401, 403, 404]);

/**
 * launchd 데몬 PATH는 매우 짧다. 후처리 스크립트가 python3/ssh/tar를 찾을 수 있도록
 * 흔한 시스템·Homebrew·CHATKJB_NODE_BIN 경로를 앞에 보강한다(이미 있으면 중복하지 않음).
 */
export function buildPostCompileEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env = { ...source };
  const extras = [
    source.CHATKJB_NODE_BIN?.trim(),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter((value): value is string => Boolean(value));
  const existing = (env.PATH ?? "").split(":").filter(Boolean);
  const merged: string[] = [];
  for (const part of [...extras, ...existing]) {
    if (!merged.includes(part)) merged.push(part);
  }
  env.PATH = merged.join(":");
  return env;
}

/** 진단·통지용: 후처리 스크립트 설정 상태를 한 줄로 설명한다. */
export function describeKjbWikiPostCompileConfig(
  env: NodeJS.ProcessEnv = process.env
): { configured: boolean; path?: string; detail: string; } {
  const configured = env.KJB_WIKI_POST_COMPILE_SCRIPT?.trim() ?? "";
  if (!configured) {
    return {
      configured: false,
      detail: "KJB_WIKI_POST_COMPILE_SCRIPT 미설정 — /compile 후 KJB Wiki 공개 그래프 배포를 건너뜁니다."
    };
  }
  if (!isAbsolute(configured)) {
    return {
      configured: false,
      path: configured,
      detail: `KJB_WIKI_POST_COMPILE_SCRIPT가 절대경로가 아닙니다: ${configured}`
    };
  }
  if (!existsSync(configured)) {
    return {
      configured: false,
      path: configured,
      detail: `KJB Wiki 후처리 스크립트를 찾지 못했습니다: ${configured}`
    };
  }
  return {
    configured: true,
    path: configured,
    detail: `KJB Wiki 후처리 준비됨: ${configured}`
  };
}

export async function runConfiguredKjbWikiPostCompile(): Promise<string | undefined> {
  const status = describeKjbWikiPostCompileConfig();
  if (!status.configured) {
    // 설정 누락은 오류가 아니라 선택 기능 비활성. 다만 무음 스킵이면 "배포가 안 된다"로 오인된다.
    console.warn(`[compile] ${status.detail}`);
    return undefined;
  }
  const configured = status.path!;
  console.log(`[compile] KJB Wiki 후처리 시작: ${configured} --deploy`);
  const { stdout, stderr } = await execFileAsync(configured, ["--deploy"], {
    cwd: dirname(configured),
    env: buildPostCompileEnvironment(),
    encoding: "utf8",
    timeout: POST_COMPILE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  });
  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

/**
 * Telegram 한 메시지 한도 안에서 순차 전송할 조각으로 나눈다.
 * 가능하면 줄 경계 → 공백 경계에서 자르고, 불가피하면 하드 컷한다. 내용은 버리지 않는다.
 */
export function splitTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const value = String(text ?? "");
  if (value.length === 0) return [""];
  if (limit < 1) throw new Error("Telegram text limit must be at least 1");
  if (value.length <= limit) return [value];

  const chunks: string[] = [];
  let remaining = value;
  const minSoftCut = Math.max(1, Math.floor(limit * 0.5));

  while (remaining.length > limit) {
    // 경계 문자는 앞 조각에 포함해 join("")으로 원문을 그대로 복원 가능하게 한다.
    let cut = remaining.lastIndexOf("\n", limit - 1);
    if (cut >= minSoftCut) {
      cut += 1;
    } else {
      cut = remaining.lastIndexOf(" ", limit - 1);
      if (cut >= minSoftCut) {
        cut += 1;
      } else {
        cut = limit;
      }
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks.length > 0 ? chunks : [""];
}

/**
 * 네트워크/한도 초과처럼 잠시 뒤 재시도할 가치가 있는 오류만 true.
 * `message is too long` 같은 400은 같은 본문으로 재시도해도 영원히 실패한다.
 */
export function isTransientTelegramError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const value = error as {
    error_code?: number;
    errorCode?: number;
    description?: string;
    message?: string;
    parameters?: { retry_after?: number; };
  };
  const code = value.error_code ?? value.errorCode;
  const detail = `${value.description ?? ""} ${value.message ?? ""}`.toLowerCase();
  if (detail.includes("message is too long")) return false;
  if (typeof code === "number" && NON_RETRYABLE_TELEGRAM_CODES.has(code)) {
    // 429 Too Many Requests 는 재시도 대상(아래 별도 분기 없음 — 코드 집합에 없음).
    return false;
  }
  return true;
}

/** 제목 + 선택 요약본을 조합한다. 길이 초과 시 호출 측에서 분할 전송한다. */
export function buildCompileNotifyText(title: string, detail = ""): string {
  const head = String(title ?? "").trim() || "LLM-Wiki compile";
  const body = detail.trim();
  if (!body) return head;
  return `${head}\n\n${body}`;
}

export function summarizeCompileOutput(text: string): string {
  const raw = String(text ?? "");
  const summary = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join("\n");
  return summary;
}

export function buildWikiCompilePrompt(vault: string, arg: string): string {
  const commandPath = join(vault, ".claude", "commands", "compile.md");
  if (!existsSync(commandPath)) {
    throw new Error(`compile 규약 파일을 찾지 못했습니다: ${commandPath}`);
  }
  return (
    `LLM-Wiki 저장소 \`${vault}\`에서 /compile을 배치 모드로 실행하십시오.\n\n`
    + `1. \`${commandPath}\`를 먼저 읽고 그 규약을 따르십시오.\n`
    + `2. 대상은 ${arg ? `\`${arg}\`` : "`10-inbox/`의 미컴파일 소스 전부"}입니다.\n`
    + `3. 컴파일 세션이나 ChatKJB 토픽을 만들 필요가 없습니다.\n`
    + `4. 배치 모드이므로 사용자에게 되묻지 말고, 불확실한 항목은 규약대로 표시하십시오.\n`
    + `5. 소스를 하나씩 완결 처리하십시오. 한 소스의 위키 반영(source/entity/concept 페이지·인덱스 갱신)과 원본의 \`20-raw/\` 이동(규약 Step 7)을 끝낸 뒤에야 다음 소스로 넘어가고, 이동을 마지막에 몰아서 하지 마십시오. 시간이 초과되어 중단되더라도 이미 raw로 옮겨진 소스는 완료로 보존되고 인박스에는 미처리 소스만 남아, 다음 /compile 실행이 남은 소스만 자동으로 이어받습니다.\n`
    + `6. 이 저장소는 git repo입니다. 소스 하나를 완결할 때마다 그 즉시 \`git add -A && git commit\`으로 커밋하여(규약 Step 8을 소스 단위로 앞당김) 각 소스가 온전한 체크포인트로 남게 하십시오. 모든 소스를 마친 뒤 마지막에 한 번 \`git push\`를 시도하되, push가 실패해도(네트워크/인증) 오류로 취급하지 말고 로컬 커밋은 이미 안전하므로 그대로 진행·보고하십시오.\n`
    + `7. 마지막 출력은 완료 또는 오류 요약만 간결하게 작성하십시오.`
  );
}
