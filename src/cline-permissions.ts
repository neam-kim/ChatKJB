import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolPolicy } from "@cline/sdk";
import type { SessionRecord } from "./types.js";

export const CLINE_AUDITED_TOOL_NAMES = [
  "read_files",
  "search_codebase",
  "fetch_web_content",
  "editor",
  "apply_patch",
  "run_commands",
  "skills",
  "ask_question"
] as const;

export type ClineAuditedToolName = typeof CLINE_AUDITED_TOOL_NAMES[number];

export interface ClineToolBoundary {
  enableReadFiles: boolean;
  enableSearch: boolean;
  enableWebFetch: boolean;
  enableEditor: boolean;
  enableApplyPatch: boolean;
  enableBash: boolean;
  enableSkills: boolean;
  enableAskQuestion: boolean;
  policies: Record<ClineAuditedToolName, ToolPolicy>;
}

/** ChatKJB의 권한 의미를 Cline의 폐쇄형 tool set으로 변환한다. */
export function clineToolBoundary(
  mode: SessionRecord["permissionMode"],
  readOnly = false
): ClineToolBoundary {
  const immutable = readOnly || mode === "plan";
  const edit = !immutable;
  const shell = !immutable && mode !== "dontAsk";
  const editAuto = mode === "acceptEdits" || mode === "dontAsk" || mode === "auto";
  const shellAuto = mode === "auto";
  // plan/read-only/synthesis 경로는 읽기·검색·웹·skills·질문만 자동 허용하고
  // editor/shell/MCP는 거부한다. MCP는 executor가 도구 자체를 등록하지 않는다.
  return {
    enableReadFiles: true,
    enableSearch: true,
    enableWebFetch: true,
    enableEditor: edit,
    enableApplyPatch: edit,
    enableBash: shell,
    enableSkills: true,
    enableAskQuestion: true,
    policies: {
      read_files: { enabled: true, autoApprove: true },
      search_codebase: { enabled: true, autoApprove: true },
      fetch_web_content: { enabled: true, autoApprove: true },
      editor: { enabled: edit, autoApprove: editAuto },
      apply_patch: { enabled: edit, autoApprove: editAuto },
      run_commands: { enabled: shell, autoApprove: shellAuto },
      skills: { enabled: true, autoApprove: true },
      ask_question: { enabled: true, autoApprove: true }
    }
  };
}

const SECRET_TARGET = /(?:^|[/.\s_-])(?:\.env|credentials?|secrets?|tokens?|auth\.json|providers\.json|\.ssh|\.aws|\.gnupg)(?:$|[/.\s_-])/i;

/** 명령 위치(줄 처음 또는 셸 구분자 뒤)에 나타나는 낱말만 잡는다. */
function commandWord(names: string): RegExp {
  return new RegExp(String.raw`(?:^|[\s;&|(\`])(?:${names})(?=$|[\s;&|)\`])`, "i");
}

const REMOTE_TRANSFER = commandWord("curl|wget|ssh|scp|sftp|nc|netcat|telnet|ftp|rsync");
const PRIVILEGE_ESCALATION = commandWord("sudo|su|doas");
const DISK_DESTRUCTIVE = commandWord(String.raw`dd|mkfs(?:\.\w+)?|diskutil|newfs(?:_\w+)?`);
// `rm file`은 통과시키고 재귀·강제 삭제만 막는다.
const RECURSIVE_DELETE = /(?:^|[\s;&|(`])rm\s+(?:[^|;&]*\s)?-{1,2}(?:[a-z]*[rRf]|recursive|force)/i;

/**
 * `auto`에서 쓰는 차단목록이다. auto는 다른 제공자와 같은 의미(격리 해제)여야 하므로
 * 셸 결합·임의 실행 파일·프로젝트 밖 경로를 모두 허용하고, 되돌릴 수 없거나 데이터를
 * 기기 밖으로 내보내는 부류만 남긴다.
 *
 * 주의: 셸 문법을 허용하는 순간 이 검사는 보안 경계가 아니라 사고 방지용 가드다.
 * `sh -c`, 변수 치환, 경로 우회로 얼마든지 회피할 수 있다. 신뢰할 수 없는 프롬프트를
 * auto로 돌리는 상황을 막아 주지는 못한다.
 */
export function classifyClineAutoCommand(command: string, _cwd?: string): {
  allowed: boolean;
  reason?: string;
} {
  const clean = command.trim();
  if (!clean) return { allowed: false, reason: "빈 명령" };
  if (SECRET_TARGET.test(clean)) return { allowed: false, reason: "비밀/인증 대상 금지" };
  if (REMOTE_TRANSFER.test(clean)) return { allowed: false, reason: "원격 전송 명령 금지" };
  if (PRIVILEGE_ESCALATION.test(clean)) return { allowed: false, reason: "권한 상승 명령 금지" };
  if (DISK_DESTRUCTIVE.test(clean)) return { allowed: false, reason: "디스크 파괴 명령 금지" };
  if (RECURSIVE_DELETE.test(clean)) return { allowed: false, reason: "재귀·강제 삭제 금지" };
  return { allowed: true };
}

export function isPathWithinWorkspace(path: string, cwd: string): boolean {
  try {
    const root = realpathSync(cwd);
    const candidate = realpathSync(path);
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    // 새 파일은 가장 가까운 기존 부모의 realpath를 별도 executor에서 재검사한다.
    const candidate = resolve(cwd, path);
    const rel = relative(resolve(cwd), candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
}

