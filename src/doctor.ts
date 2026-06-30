import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_OAUTH_TOKEN_PATTERN, type AppConfig } from "./config.js";
import { requireCodexSubscriptionAuth } from "./session-manager.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";

const execFileAsync = promisify(execFile);
const localLaunchAgentLabel = "com.neam.telegram-claude-orchestrator";

function detectLaunchAgentLabel(): string {
  if (process.env.LAUNCH_AGENT_LABEL) return process.env.LAUNCH_AGENT_LABEL;
  const directory = join(homedir(), "Library", "LaunchAgents");
  if (existsSync(join(directory, `${localLaunchAgentLabel}.plist`))) {
    return localLaunchAgentLabel;
  }
  try {
    const suffix = "telegram-claude-orchestrator.plist";
    const filename = readdirSync(directory).find((entry) => entry.endsWith(suffix));
    return filename?.replace(/\.plist$/, "") ?? localLaunchAgentLabel;
  } catch {
    return localLaunchAgentLabel;
  }
}

export const LAUNCH_AGENT_LABEL = detectLaunchAgentLabel();

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
    check("OAuth 토큰", 1000, async () => {
      const tokens = deps.config.claudeCodeOauthTokens;
      const invalid = tokens.filter((token) => !CLAUDE_OAUTH_TOKEN_PATTERN.test(token));
      if (invalid.length > 0) {
        return [`❌ OAuth 토큰: ${invalid.length}개 형식 오류 (총 ${tokens.length}개)`];
      }
      return [
        tokens.length > 1
          ? `✅ OAuth 토큰: 형식 유효 · ${tokens.length}개 (한도 도달 시 자동 페일오버)`
          : "✅ OAuth 토큰: 형식 유효"
      ];
    }),
    check("Codex 구독 인증", 1000, async () => {
      const homes = deps.config.codexAccountHomes;
      const failures: string[] = [];
      homes.forEach((home, index) => {
        try {
          requireCodexSubscriptionAuth(home);
        } catch (error) {
          failures.push(`계정 #${index + 1} (${home}): ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      if (failures.length > 0) {
        return [`❌ Codex 구독 인증: ${failures.length}/${homes.length}개 계정 오류`, ...failures.map((f) => `   ${f}`)];
      }
      return [
        homes.length > 1
          ? `✅ Codex 구독 인증: ${homes.length}개 계정 ChatGPT 로그인 확인 (한도 도달 시 자동 페일오버)`
          : "✅ Codex 구독 인증: ChatGPT 로그인 확인"
      ];
    }),
    check("Antigravity", 5000, async () => {
      if (deps.config.agyBackend === "cli") {
        const { stdout } = await execFileAsync(
          deps.config.agyExecutable,
          ["--help"],
          { timeout: 4000, maxBuffer: 64 * 1024 }
        );
        return stdout.includes("--print")
          ? ["✅ Antigravity CLI: 구독 백엔드 실행 파일 확인"]
          : ["❌ Antigravity CLI: --print 지원 여부 확인 실패"];
      }
      if (!deps.config.geminiApiKey || deps.config.geminiApiKey.length < 30) {
        return ["❌ Antigravity API: GEMINI_API_KEY 형식 오류"];
      }
      const { stdout } = await execFileAsync(
        deps.config.agySdkPython,
        ["-c", "import google.antigravity; print('ok')"],
        { timeout: 4000, maxBuffer: 64 * 1024 }
      );
      return stdout.trim() === "ok"
        ? ["✅ Antigravity API: Gemini API 키 설정 · 런타임 로드 가능"]
        : ["❌ Antigravity API: 런타임 로드 결과 이상"];
    }),
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
      // launchd 로그는 CloudStorage 밖(~/Library/Logs/<label>/)에 둔다 — install-launch-agent.mjs 참고.
      join(homedir(), "Library", "Logs", localLaunchAgentLabel, "stderr.log"),
      [
        deps.config.telegramBotToken,
        deps.config.geminiApiKey,
        ...deps.config.claudeCodeOauthTokens
      ].filter((value): value is string => typeof value === "string")
    ))
  ]);

  return ["[DOCTOR]", ...checks.flat()].join("\n");
}
