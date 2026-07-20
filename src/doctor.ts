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
import { describeKjbWikiPostCompileConfig } from "./bot/wiki-compile.js";
import { discoverClineCatalog } from "./cline-sdk.js";
import { CLAUDE_OAUTH_TOKEN_PATTERN, type AppConfig } from "./config.js";
import { buildCodexEnvironment, requireCodexSubscriptionAuth } from "./session-manager.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";

const execFileAsync = promisify(execFile);
const localLaunchAgentLabel = "com.chatkjb.bot";
const CLI_VERSION_TIMEOUT_MS = 4000;
const CLI_VERSION_MAX_BUFFER = 64 * 1024;

function detectLaunchAgentLabel(): string {
  if (process.env.LAUNCH_AGENT_LABEL) return process.env.LAUNCH_AGENT_LABEL;
  const directory = join(homedir(), "Library", "LaunchAgents");
  if (existsSync(join(directory, `${localLaunchAgentLabel}.plist`))) {
    return localLaunchAgentLabel;
  }
  return localLaunchAgentLabel;
}

export const LAUNCH_AGENT_LABEL = detectLaunchAgentLabel();

interface DoctorDeps {
  config: AppConfig;
  store: StateStore;
  getTelegramMe: () => Promise<{ username?: string; }>;
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

export function firstVersionLine(output: string): string | null {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

export function formatAgentCliVersionLine(label: string, executable: string, version: string | null): string {
  return `✅ ${label}: ${executable}${version ? ` · 버전 ${version}` : " · 버전 확인됨"}`;
}

async function cliVersion(
  executable: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv | undefined; } = {}
): Promise<string | null> {
  const { stdout, stderr } = await execFileAsync(
    executable,
    [...args],
    {
      timeout: CLI_VERSION_TIMEOUT_MS,
      maxBuffer: CLI_VERSION_MAX_BUFFER,
      ...(options.env ? { env: options.env } : {})
    }
  );
  return firstVersionLine(stdout + stderr);
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
  const dataDir = dirname(deps.config.databasePath);
  const claudeConfigPath = deps.claudeConfigPath ?? join(homedir(), ".claude.json");
  const checks = await Promise.all([
    check("OAuth 토큰", 1000, async () => {
      const tokens = deps.config.claudeCodeOauthTokens;
      if (tokens.length === 0) return ["➖ Claude OAuth: 미설정 · Claude 기능 비활성"];
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
      if (homes.length === 0) return ["➖ Codex 구독 인증: 미설정 · Codex 기능 비활성"];
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
    check("Claude CLI", 5000, async () => {
      const version = await cliVersion(
        deps.config.claudeCodeExecutable,
        ["--version"]
      );
      return [formatAgentCliVersionLine("Claude CLI", deps.config.claudeCodeExecutable, version)];
    }),
    check("Codex CLI", 5000, async () => {
      const version = await cliVersion(
        deps.config.codexExecutable,
        ["--version"],
        {
          env: buildCodexEnvironment(deps.config.codexAccountHomes[0])
        }
      );
      return [formatAgentCliVersionLine("Codex CLI", deps.config.codexExecutable, version)];
    }),
    check("Antigravity", 5000, async () => {
      const version = await cliVersion(
        deps.config.agyExecutable,
        ["--version"]
      );
      const { stdout, stderr } = await execFileAsync(
        deps.config.agyExecutable,
        ["--help"],
        { timeout: CLI_VERSION_TIMEOUT_MS, maxBuffer: CLI_VERSION_MAX_BUFFER }
      );
      // agy --help는 stderr로 출력한다.
      return (stdout + stderr).includes("--print")
        ? [formatAgentCliVersionLine("Antigravity CLI", deps.config.agyExecutable, version)]
        : ["❌ Antigravity CLI: --print 지원 여부 확인 실패"];
    }),
    check("Grok CLI", 5000, async () => {
      const version = await cliVersion(
        deps.config.grokExecutable,
        ["--version"]
      );
      return [formatAgentCliVersionLine("Grok CLI", deps.config.grokExecutable, version)];
    }),
    // Cline은 외부 CLI를 매 턴 스폰하지 않고 @cline/sdk를 봇 안에서 쓰므로, CLI 버전 대신
    // 실제로 실행 가능한지를 좌우하는 provider 카탈로그 탐색 결과를 점검한다.
    check("Cline", 8000, async () => {
      const catalog = await discoverClineCatalog();
      if (catalog.providers.length === 0) {
        return ["❌ Cline: 사용 가능한 내부 제공자가 없습니다 (cline 로그인·provider 설정 확인)"];
      }
      const models = catalog.providers.reduce(
        (sum, provider) => sum + (catalog.modelsByProvider[provider.id]?.length ?? 0),
        0
      );
      return [`✅ Cline: 내부 제공자 ${catalog.providers.length}개 · 모델 ${models}개`];
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
        ...deps.config.claudeCodeOauthTokens
      ].filter((value): value is string => typeof value === "string")
    )),
    check("KJB Wiki 후처리", 1000, async () => {
      const status = describeKjbWikiPostCompileConfig();
      if (status.configured) {
        return [`✅ KJB Wiki 후처리: ${status.path}`];
      }
      // 선택 기능이지만 /compile 자동 배포를 기대하면 설정이 필요하다.
      return [`⚠️ KJB Wiki 후처리: ${status.detail}`];
    })
  ]);

  return [
    "[DOCTOR]",
    `인증된 제공자: ${deps.config.availableProviders.join(", ")}`,
    ...checks.flat()
  ].join("\n");
}
