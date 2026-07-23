// Claude 개인 구독의 사용량 페이지를 전용 Chrome 프로필로 읽는다. 공식 개인 구독
// Usage API가 없는 경우에만 데몬이 이 모듈을 사용한다. 쿠키를 복사하거나 기본
// 브라우저 프로필에 붙지 않으며, Chrome의 보안 확인을 우회하지 않는다.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { GuiClaudeUsageDto } from "./usage-contract.js";

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const DEFAULT_TIMEOUT_MS = 30_000;
// Cloudflare 보안 확인은 초기 렌더링보다 오래 걸릴 수 있으므로, 사용량 화면을 최대 60초 기다린다.
const DEFAULT_PAGE_READY_TIMEOUT_MS = 60_000;
const PAGE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface ClaudeWebUsageOptions {
  profilePath?: string;
  chromePath?: string;
  timeoutMs?: number;
  /** Cloudflare 확인을 포함해 사용량 화면이 준비될 때까지 기다릴 최대 시간. */
  pageReadyTimeoutMs?: number;
  now?: () => number;
}

function usagePercentAfter(text: string, start: number, end: number): number | null {
  const part = text.slice(start, end);
  const match = /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:사용됨|used)/i.exec(part);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function sectionEnd(text: string, start: number, labels: readonly RegExp[]): number {
  const tail = text.slice(start);
  const ends = labels
    .map((label) => tail.search(label))
    .filter((index) => index >= 0)
    .map((index) => start + index);
  return ends.length > 0 ? Math.min(...ends) : text.length;
}

/**
 * 한국어·영어 Claude 사용량 화면에서 현재 세션과 주간 한도의 퍼센트만 읽는다.
 * 요금제명, 대화 제목, 크레딧 금액 등은 취급하지 않는다.
 */
export function parseClaudeUsagePageText(text: string, capturedAt: number): GuiClaudeUsageDto | null {
  const sessionLabel = /(?:현재\s*세션|current\s*session)/i.exec(text);
  const weeklyLabel = /(?:주간\s*한도|weekly\s*limit)/i.exec(text);
  if (!sessionLabel || !weeklyLabel || sessionLabel.index === undefined || weeklyLabel.index === undefined) {
    return null;
  }
  const sessionStart = sessionLabel.index + sessionLabel[0].length;
  const weeklyStart = weeklyLabel.index + weeklyLabel[0].length;
  const fiveHour = usagePercentAfter(text, sessionStart, weeklyLabel.index);
  const sevenDay = usagePercentAfter(
    text,
    weeklyStart,
    sectionEnd(text, weeklyStart, [/(?:사용\s*크레딧|usage\s*credits)/i])
  );
  if (fiveHour === null && sevenDay === null) return null;
  return {
    fiveHour: fiveHour === null ? null : { utilization: fiveHour, resetsAt: null },
    sevenDay: sevenDay === null ? null : { utilization: sevenDay, resetsAt: null },
    stale: false,
    capturedAt
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface PendingCdpCall {
  resolve: (response: CdpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 전용 프로필의 일반 Chrome 창을 화면 밖 위치에서 1회 실행한다. headless Chrome은
 * Claude의 Cloudflare 확인에 막히므로 쓰지 않는다. DevTools pipe는 localhost 포트를
 * 열지 않고 프로세스 부모-자식 파이프로만 통신한다.
 */
export async function fetchClaudeWebUsage(
  options: ClaudeWebUsageOptions = {}
): Promise<GuiClaudeUsageDto | null> {
  const profilePath = options.profilePath
    ?? join(homedir(), "Library", "Application Support", "ChatKJB", "claude-usage-browser");
  const chromePath = options.chromePath ?? DEFAULT_CHROME_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageReadyTimeoutMs = options.pageReadyTimeoutMs ?? DEFAULT_PAGE_READY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  if (!existsSync(profilePath) || !existsSync(chromePath)) return null;

  const chrome = spawn(chromePath, [
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-pipe",
    // 화면에 보이지 않는 전용 창이지만 일반 렌더러를 사용한다(보안 확인 우회 금지).
    "--window-position=-32000,-32000",
    "--window-size=900,700",
    `--user-data-dir=${profilePath}`,
    CLAUDE_USAGE_URL
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const cdpInput = chrome.stdio[3] as Writable | null;
  const cdpOutput = chrome.stdio[4];
  if (!cdpInput || !cdpOutput) {
    chrome.kill("SIGTERM");
    return null;
  }

  let closed = false;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, PendingCdpCall>();
  const close = () => {
    if (closed) return;
    closed = true;
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Chrome DevTools pipe closed"));
    }
    pending.clear();
    if (!chrome.killed) chrome.kill("SIGTERM");
  };
  const fail = () => close();
  chrome.once("error", fail);
  chrome.once("exit", close);
  cdpOutput.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const delimiter = buffer.indexOf(0);
      if (delimiter < 0) return;
      const raw = buffer.subarray(0, delimiter).toString("utf8");
      buffer = buffer.subarray(delimiter + 1);
      try {
        const response = JSON.parse(raw) as CdpResponse;
        if (typeof response.id !== "number") continue;
        const call = pending.get(response.id);
        if (!call) continue;
        pending.delete(response.id);
        clearTimeout(call.timer);
        call.resolve(response);
      } catch {
        // 깨진 DevTools 메시지는 해당 폴링만 실패시킨다.
        close();
      }
    }
  });

  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<CdpResponse>((resolve, reject) => {
      if (closed) {
        reject(new Error("Chrome DevTools pipe unavailable"));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chrome DevTools timeout: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      cdpInput.write(`${JSON.stringify(message)}\0`, (error?: Error | null) => {
        if (!error) return;
        const queued = pending.get(id);
        if (!queued) return;
        pending.delete(id);
        clearTimeout(queued.timer);
        queued.reject(error);
      });
    });

  try {
    await delay(1_000);
    const targets = await call("Target.getTargets");
    const targetInfos = targets.result?.targetInfos;
    if (!Array.isArray(targetInfos)) return null;
    const page = targetInfos.find((target): target is { targetId: string; type: string } => (
      Boolean(target)
      && typeof target === "object"
      && (target as Record<string, unknown>).type === "page"
      && typeof (target as Record<string, unknown>).targetId === "string"
    ));
    if (!page) return null;
    const attached = await call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    if (typeof sessionId !== "string") return null;
    // Cloudflare 확인이 초기 렌더링보다 길어질 수 있어, 최대 60초 동안 재시도한다.
    // 내용은 메모리에만 두며 사용량 수치가 확인되는 즉시 창을 닫는다.
    const deadline = Date.now() + Math.max(0, pageReadyTimeoutMs);
    while (Date.now() < deadline) {
      await delay(Math.min(PAGE_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      const evaluated = await call("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
        awaitPromise: true
      }, sessionId);
      const value = evaluated.result?.result;
      const body = value && typeof value === "object"
        ? (value as Record<string, unknown>).value
        : null;
      if (typeof body !== "string") continue;
      const parsed = parseClaudeUsagePageText(body, now());
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    close();
  }
}
