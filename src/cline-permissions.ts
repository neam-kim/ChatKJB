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

const UNSAFE_SHELL_SYNTAX = /[;&|><`$(){}\[\]\n\r\\]/;
const SECRET_TARGET = /(?:^|[/.\s_-])(?:\.env|credentials?|secrets?|tokens?|auth\.json|providers\.json|\.ssh|\.aws|\.gnupg)(?:$|[/.\s_-])/i;
const UNSAFE_COMMAND = /^(?:curl|wget|ssh|scp|sftp|nc|netcat|telnet|ftp|rsync|rm|rmdir|mv|cp|chmod|chown|kill|pkill|killall|sudo|su|dd|mkfs|diskutil|launchctl|open|osascript|env|printenv|security)$/i;
const SAFE_GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse"]);
const SAFE_NPM_SCRIPTS = new Set(["test", "typecheck", "build"]);

/**
 * `auto`에서만 쓰는 보수적 명령 분류기다. 셸 문법을 해석하지 않고 안전성을 입증할 수
 * 없는 입력은 모두 거부한다. 쓰기는 editor/apply_patch로만 수행한다.
 */
export function classifyClineAutoCommand(command: string, cwd: string): {
  allowed: boolean;
  reason?: string;
} {
  const clean = command.trim();
  if (!clean) return { allowed: false, reason: "빈 명령" };
  if (UNSAFE_SHELL_SYNTAX.test(clean)) return { allowed: false, reason: "셸 결합·치환·리디렉션 금지" };
  if (SECRET_TARGET.test(clean)) return { allowed: false, reason: "비밀/인증 대상 금지" };
  const argv = clean.split(/\s+/);
  if (argv.some((part) => part === ".." || part.startsWith("../") || part.includes("/../"))) {
    return { allowed: false, reason: "상위 경로 금지" };
  }
  if (argv.some((part) => isAbsolute(part) && !isPathWithinWorkspace(part, cwd))) {
    return { allowed: false, reason: "프로젝트 밖 절대 경로 금지" };
  }
  const executable = argv[0]?.replace(/^.*\//, "") ?? "";
  if (UNSAFE_COMMAND.test(executable)) return { allowed: false, reason: "외부/파괴/권한 명령 금지" };
  if (["pwd", "ls", "rg"].includes(executable)) return { allowed: true };
  if (executable === "git" && argv[1] && SAFE_GIT_SUBCOMMANDS.has(argv[1])) {
    return { allowed: true };
  }
  if (executable === "npm") {
    const script = argv[1] === "run" ? argv[2] : argv[1];
    if (script && SAFE_NPM_SCRIPTS.has(script)) return { allowed: true };
  }
  return { allowed: false, reason: "자동 허용목록에 없는 명령" };
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

