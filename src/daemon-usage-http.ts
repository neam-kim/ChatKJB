// 데몬 호스트 사용량을 Tailscale/LAN 에서 읽을 수 있게 하는 읽기 전용 HTTP 엔드포인트.
// 맥북 Terminal 은 NAS 를 마운트하지 않으므로 파일 캐시 대신 이 URL 을 조회한다.
// macOS 방화벽이 :17846 직접 수신을 막는 경우가 있어, 가능하면 Tailscale Serve(:80)로
// localhost 프록시를 걸어 둔다.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import {
  DEFAULT_USAGE_HTTP_PORT,
  USAGE_HTTP_PATH,
  type DaemonUsageCacheFile
} from "./usage-cache.js";

const execFileAsync = promisify(execFile);

export interface DaemonUsageHttpServerOptions {
  getPayload: () => DaemonUsageCacheFile | null;
  port?: number;
  /** 기본 127.0.0.1 — 외부 접근은 Tailscale Serve 프록시를 사용한다. */
  host?: string;
  /** 설정 시 Authorization: Bearer <token> 필수. */
  token?: string;
  log?: (message: string) => void;
}

export interface DaemonUsageHttpServerHandle {
  port: number;
  host: string;
  stop: () => Promise<void>;
}

function unauthorized(response: import("node:http").ServerResponse): void {
  response.writeHead(401, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify({ error: "unauthorized" }));
}

function notFound(response: import("node:http").ServerResponse): void {
  response.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify({ error: "not_found" }));
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function startDaemonUsageHttpServer(
  options: DaemonUsageHttpServerOptions
): Promise<DaemonUsageHttpServerHandle> {
  const port = options.port ?? DEFAULT_USAGE_HTTP_PORT;
  const host = options.host?.trim() || "127.0.0.1";
  const token = options.token?.trim() || "";
  const log = options.log ?? ((message: string) => console.log(message));

  if (!token && !isLoopbackHost(host)) {
    return Promise.reject(new Error(
      `Usage HTTP non-loopback binding requires CHATKJB_USAGE_HTTP_TOKEN: ${host}`
    ));
  }

  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      try {
        const method = request.method ?? "GET";
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        if (method === "GET" && (url.pathname === USAGE_HTTP_PATH || url.pathname === "/usage")) {
          if (token) {
            const header = request.headers.authorization ?? "";
            const expected = `Bearer ${token}`;
            if (header !== expected) {
              unauthorized(response);
              return;
            }
          }
          const payload = options.getPayload();
          if (!payload) {
            response.writeHead(503, {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store"
            });
            response.end(JSON.stringify({ error: "usage_not_ready" }));
            return;
          }
          const body = JSON.stringify(payload);
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": Buffer.byteLength(body)
          });
          response.end(body);
          return;
        }
        if (method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store"
          });
          response.end(JSON.stringify({ ok: true, ready: options.getPayload() !== null }));
          return;
        }
        notFound(response);
      } catch {
        response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: "internal" }));
      }
    });

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(port, host, () => {
      log(`Usage HTTP listening → http://${host}:${port}${USAGE_HTTP_PATH}`);
      resolve({
        port,
        host,
        stop: () => new Promise<void>((stopResolve, stopReject) => {
          server.close((error) => {
            if (error) stopReject(error);
            else stopResolve();
          });
        })
      });
    });
  });
}

export function resolveUsageHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CHATKJB_USAGE_HTTP_PORT?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const port = Number(raw);
    if (Number.isSafeInteger(port) && port >= 1 && port <= 65_535) return port;
  }
  return DEFAULT_USAGE_HTTP_PORT;
}

function resolveTailscaleCli(): string | null {
  const candidates = [
    process.env.CHATKJB_TAILSCALE_BIN?.trim(),
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale"
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * macOS 방화벽이 앱 포트 직접 수신을 막을 때, Tailscale Serve 로 localhost 를
 * tailnet HTTP(:80)에 노출한다. 실패해도 데몬 본체는 계속 동작한다.
 */
export async function ensureTailscaleUsageServe(
  localPort: number,
  log: (message: string) => void = console.log
): Promise<boolean> {
  const cli = resolveTailscaleCli();
  if (!cli) {
    log("Usage Tailscale serve skipped → tailscale CLI not found");
    return false;
  }
  try {
    await execFileAsync(cli, ["serve", "--bg", `--http=80`, String(localPort)], {
      timeout: 15_000
    });
    log(`Usage Tailscale serve → http://neam-macmini/ → 127.0.0.1:${localPort}`);
    return true;
  } catch (error: unknown) {
    log(
      `Usage Tailscale serve failed → ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
