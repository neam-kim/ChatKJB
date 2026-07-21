// 데몬 호스트 사용량을 Tailscale/LAN 에서 읽을 수 있게 하는 읽기 전용 HTTP 엔드포인트.
// 맥북 Terminal 은 NAS 를 마운트하지 않으므로 파일 캐시 대신 이 URL 을 조회한다.
import { createServer, type Server } from "node:http";
import {
  DEFAULT_USAGE_HTTP_PORT,
  USAGE_HTTP_PATH,
  type DaemonUsageCacheFile
} from "./usage-cache.js";

export interface DaemonUsageHttpServerOptions {
  getPayload: () => DaemonUsageCacheFile | null;
  port?: number;
  /** 기본 0.0.0.0 — Tailscale IP 로 도달 가능. */
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

export function startDaemonUsageHttpServer(
  options: DaemonUsageHttpServerOptions
): Promise<DaemonUsageHttpServerHandle> {
  const port = options.port ?? DEFAULT_USAGE_HTTP_PORT;
  const host = options.host ?? "0.0.0.0";
  const token = options.token?.trim() || "";
  const log = options.log ?? ((message: string) => console.log(message));

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
