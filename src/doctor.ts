import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  statfsSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_OAUTH_TOKEN_PATTERN, type AppConfig } from "./config.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";

const execFileAsync = promisify(execFile);
export const LAUNCH_AGENT_LABEL =
  process.env.LAUNCH_AGENT_LABEL ?? "com.local.telegram-claude-orchestrator";

interface DoctorDeps {
  config: AppConfig;
  store: StateStore;
  getTelegramMe: () => Promise<{ username?: string }>;
  projectDir?: string;
  claudeConfigPath?: string;
}

interface McpServer {
  type?: string;
  command?: string;
  url?: string;
}

async function bounded<T>(timeoutMs: number, task: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 시간 제한 초과`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function check(
  label: string,
  timeoutMs: number,
  task: () => Promise<string[]>
): Promise<string[]> {
  try {
    return await bounded(timeoutMs, task);
  } catch (error) {
    return [`❌ ${label}: ${safeErrorMessage(error)}`];
  }
}

function executablePath(command: string): string | null {
  const expanded = command.replace(/^~(?=\/|$)/, homedir());
  const candidates = isAbsolute(expanded) || expanded.includes("/")
    ? [expanded]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((path) => join(path, expanded));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

async function mcpReport(configPath: string): Promise<string[]> {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    mcpServers?: Record<string, McpServer>;
  };
  const entries = Object.entries(raw.mcpServers ?? {});
  if (entries.length === 0) return ["⚠️ MCP 서버: 등록된 서버 없음"];

  return Promise.all(entries.map(async ([name, server]) => {
    if (typeof server.command === "string") {
      const path = executablePath(server.command);
      return path
        ? `✅ MCP ${name}: 실행 가능 (${path})`
        : `❌ MCP ${name}: 실행 파일을 찾거나 실행할 수 없음 (${server.command})`;
    }
    if ((server.type === "http" || server.type === "sse") && typeof server.url === "string") {
      try {
        await bounded(2000, async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1800);
          try {
            await fetch(server.url!, { method: "HEAD", signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
        });
        return `✅ MCP ${name}: 원격 서버 응답 확인`;
      } catch (error) {
        return `❌ MCP ${name}: 원격 서버 응답 없음 (${safeErrorMessage(error)})`;
      }
    }
    return `❌ MCP ${name}: 지원하지 않는 설정`;
  }));
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

function recentStderr(path: string, secrets: string[]): string[] {
  if (!existsSync(path)) return ["⚠️ 최근 stderr: 로그 파일 없음"];
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-30);
  const errors = lines.filter((line) =>
    /error|failed|failure|exception|fatal|reject|timeout|timed out/i.test(line)
  ).slice(-5);
  if (errors.length === 0) return ["✅ 최근 stderr: 최근 30줄에 오류 패턴 없음"];
  return [
    `⚠️ 최근 stderr: 오류 패턴 ${errors.length}줄`,
    ...errors.map((line) => `  ${safeErrorMessage(line, secrets).slice(0, 300)}`)
  ];
}

export async function runDoctor(deps: DoctorDeps): Promise<string> {
  const projectDir = deps.projectDir ?? process.cwd();
  const dataDir = dirname(deps.config.databasePath);
  const claudeConfigPath = deps.claudeConfigPath ?? join(homedir(), ".claude.json");
  const checks = await Promise.all([
    check("OAuth 토큰", 1000, async () => [
      CLAUDE_OAUTH_TOKEN_PATTERN.test(deps.config.claudeCodeOauthToken)
        ? "✅ OAuth 토큰: 형식 유효"
        : "❌ OAuth 토큰: 형식 오류"
    ]),
    check("launchd", 3000, async () => {
      const uid = process.getuid?.();
      if (uid === undefined) return ["⚠️ launchd: 현재 사용자 ID 확인 불가"];
      try {
        const { stdout } = await execFileAsync(
          "launchctl",
          ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`],
          { timeout: 2500, maxBuffer: 512 * 1024 }
        );
        const state = /^\s*state\s*=\s*(.+)$/m.exec(stdout)?.[1]?.trim() ?? "확인 불가";
        const lastExit = /^\s*last exit code\s*=\s*(.+)$/m.exec(stdout)?.[1]?.trim();
        return [
          `${state === "running" ? "✅" : "⚠️"} launchd: ${state}`
          + `${lastExit ? ` · 마지막 종료 상태 ${lastExit}` : ""}`
        ];
      } catch {
        return ["⚠️ launchd 미등록"];
      }
    }),
    check("MCP 서버", 6000, () => mcpReport(claudeConfigPath)),
    check("SQLite", 3000, async () => {
      accessSync(deps.config.databasePath, constants.R_OK | constants.W_OK);
      deps.store.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      return ["✅ SQLite: 파일 읽기·쓰기 가능"];
    }),
    check("projects.json", 3000, async () => {
      const raw = JSON.parse(readFileSync(deps.config.projectsPath, "utf8")) as Array<{
        name?: string;
        cwd?: string;
      }>;
      const lines = raw.map((project) => {
        if (typeof project.name !== "string" || typeof project.cwd !== "string") {
          return "❌ projects.json: 잘못된 프로젝트 항목";
        }
        try {
          accessSync(project.cwd, constants.R_OK);
          return statSync(project.cwd).isDirectory()
            ? `✅ 프로젝트 ${project.name}: 읽기 가능`
            : `❌ 프로젝트 ${project.name}: 디렉터리가 아님`;
        } catch {
          return `❌ 프로젝트 ${project.name}: 경로를 읽을 수 없음`;
        }
      });
      return lines.length > 0 ? lines : ["❌ projects.json: 프로젝트 없음"];
    }),
    check("Telegram", 5000, async () => {
      const me = await deps.getTelegramMe();
      return [`✅ Telegram: 연결됨${me.username ? ` (@${me.username})` : ""}`];
    }),
    check("디스크", 2000, async () => {
      const stats = statfsSync(dataDir);
      return [`✅ 디스크: 데이터 디렉터리 여유 ${formatBytes(stats.bavail * stats.bsize)}`];
    }),
    check("최근 stderr", 2000, async () => recentStderr(
      join(projectDir, "data", "stderr.log"),
      [deps.config.telegramBotToken, deps.config.claudeCodeOauthToken]
    ))
  ]);

  return ["[DOCTOR]", ...checks.flat()].join("\n");
}
