import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function startMcp(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const child = spawn("/usr/bin/python3", [resolve("scripts/scihub-mcp.py")], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

function rpc(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>
): Promise<Record<string, any>> {
  return new Promise((resolveReply, reject) => {
    const id = message.id;
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("MCP response timeout"));
    }, 5_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const payload = JSON.parse(line) as Record<string, any>;
        if (payload.id !== id) continue;
        cleanup();
        resolveReply(payload);
        return;
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

function toolPayload(response: Record<string, any>): Record<string, any> {
  return JSON.parse(response.result.content[0].text) as Record<string, any>;
}

describe("scihub MCP", () => {
  it("advertises resolve, fetch, and mirror tools", async () => {
    const child = startMcp();
    const initialized = await rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const listed = await rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(initialized.result.serverInfo.name).toBe("scihub");
    expect(listed.result.tools.map((tool: { name: string; }) => tool.name)).toEqual([
      "list_mirrors",
      "resolve_paper",
      "fetch_paper"
    ]);
  });

  it("resolves and downloads a PDF from a mocked Sci-Hub mirror", async () => {
    const pdfBytes = Buffer.from("%PDF-1.4\n%mock scihub fixture\n%%EOF\n", "utf8");
    const base = await listen(createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === "/10.1000/example") {
        response.setHeader("content-type", "text/html; charset=UTF-8");
        response.end(`<!DOCTYPE html><html><head>
<meta name="citation_title" content="Example Paper Title">
<meta name="citation_author" content="Kim J">
<meta name="citation_doi" content="10.1000/example">
<meta name="citation_journal_title" content="Example Journal">
<meta name="citation_publication_date" content="2024">
<meta name="citation_pdf_url" content="/storage/example.pdf">
</head><body><embed src="/storage/example.pdf"></body></html>`);
        return;
      }
      if (url.pathname === "/storage/example.pdf") {
        response.setHeader("content-type", "application/pdf");
        response.end(pdfBytes);
        return;
      }
      response.statusCode = 404;
      response.end("missing");
    }));

    const outDir = mkdtempSync(join(tmpdir(), "scihub-mcp-"));
    tempDirs.push(outDir);
    const child = startMcp({
      SCIHUB_MIRRORS: base,
      SCIHUB_OUTPUT_DIR: outDir
    });

    const resolved = await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "resolve_paper", arguments: { identifier: "10.1000/example" } }
    });
    const resolvePayload = toolPayload(resolved);
    expect(resolvePayload.ok).toBe(true);
    expect(resolvePayload.pdfUrl).toBe(`${base}/storage/example.pdf`);
    expect(resolvePayload.metadata.title).toBe("Example Paper Title");
    expect(resolvePayload.metadata.doi).toBe("10.1000/example");

    const fetched = await rpc(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "fetch_paper",
        arguments: {
          identifier: "doi:10.1000/example",
          output_dir: outDir,
          filename: "example.pdf"
        }
      }
    });
    const fetchPayload = toolPayload(fetched);
    expect(fetchPayload.ok).toBe(true);
    expect(fetchPayload.path).toBe(join(outDir, "example.pdf"));
    expect(fetchPayload.bytes).toBe(pdfBytes.length);
    expect(readFileSync(fetchPayload.path)).toEqual(pdfBytes);

    const mirrors = await rpc(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_mirrors", arguments: {} }
    });
    expect(toolPayload(mirrors).mirrors).toEqual([base]);
  });

  it("returns a structured failure when no mirror has the paper", async () => {
    const base = await listen(createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=UTF-8");
      response.end("<html><body>article not found</body></html>");
    }));
    const child = startMcp({ SCIHUB_MIRRORS: base });
    const response = await rpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "resolve_paper", arguments: { identifier: "10.9999/missing" } }
    });
    const payload = toolPayload(response);
    expect(payload.ok).toBe(false);
    expect(payload.attempts.length).toBeGreaterThan(0);
  });
});
