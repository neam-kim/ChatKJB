import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export interface CliResolutionOptions {
  explicit?: string | undefined;
  binaryName: string;
  candidates?: string[] | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function normalizeExecutablePath(path: string): string {
  const expanded = expandHome(path.trim());
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableFromPath(binaryName: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binaryName);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function resolveCliExecutable(options: CliResolutionOptions): string {
  const env = options.env ?? process.env;
  if (options.explicit?.trim()) return normalizeExecutablePath(options.explicit);
  for (const candidate of options.candidates ?? []) {
    const normalized = normalizeExecutablePath(candidate);
    if (existsSync(normalized) && isExecutable(normalized)) return normalized;
  }
  return executableFromPath(options.binaryName, env) ?? options.binaryName;
}

export function resolveClaudeCodeExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "claude",
    candidates: [
      "~/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude"
    ]
  });
}

export function resolveCodexExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "codex",
    candidates: [
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      "~/.local/bin/codex"
    ]
  });
}

export function resolveAgyExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "agy",
    candidates: [
      "~/.local/bin/agy",
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy"
    ]
  });
}

// `grok update`는 새 버전을 `~/.grok/downloads/grok-<ver>-macos-aarch64`처럼 버전이 박힌
// 파일명으로 내려받고 `~/.grok/bin/grok` 심링크만 새 파일로 옮긴다. 최초 설치본인
// `downloads/grok-macos-aarch64`는 그 자리에 stale하게 남으므로 후보 1순위로 두면 봇이
// 영원히 구버전을 스폰한다(0.2.93 고착 사례). 항상 자기 갱신 심링크를 먼저 본다.
export function resolveGrokExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "grok",
    candidates: [
      "~/.grok/bin/grok",
      "~/.local/bin/grok",
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
      "~/.grok/downloads/grok-macos-aarch64"
    ]
  });
}

export function resolveWhisperCliExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "whisper-cli",
    candidates: [
      "/opt/homebrew/bin/whisper-cli",
      "/usr/local/bin/whisper-cli",
      "~/.local/bin/whisper-cli"
    ]
  });
}

export function resolveFfmpegExecutable(explicit?: string | undefined): string {
  return resolveCliExecutable({
    explicit,
    binaryName: "ffmpeg",
    candidates: [
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "~/.local/bin/ffmpeg"
    ]
  });
}
