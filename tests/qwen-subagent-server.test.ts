import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "qwen-subagent-server.js");

interface RpcResponse {
  id: number;
  result?: { tools?: Array<{ description?: string }> };
}

/** 서버를 stdio로 띄워 initialize→tools/list를 주고받고 첫 응답들을 수집한다. */
function queryToolsList(env: Record<string, string>): Promise<RpcResponse[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"]
    });
    const responses: RpcResponse[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            responses.push(JSON.parse(line) as RpcResponse);
          } catch {
            // ignore non-JSON lines
          }
        }
        if (responses.some((r) => r.id === 2)) {
          clearTimeout(timer);
          child.kill();
          resolve(responses);
          return;
        }
        index = buffer.indexOf("\n");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
    write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
}

describe("qwen-subagent-server tools/list", () => {
  it("advertises read-only local file tools when a valid working directory is supplied", async () => {
    const cwd = join(dirname(fileURLToPath(import.meta.url)), "..");
    const responses = await queryToolsList({
      CHATKJB_QWEN_SUBAGENT_CWD: cwd,
      DASHSCOPE_API_KEY: "test-key"
    });
    const list = responses.find((r) => r.id === 2);
    const description = list?.result?.tools?.[0]?.description ?? "";
    expect(description).toContain("read-only file tools");
  });

  it("falls back to context-only delegation when the working directory is absent", async () => {
    const responses = await queryToolsList({
      CHATKJB_QWEN_SUBAGENT_CWD: "",
      DASHSCOPE_API_KEY: "test-key"
    });
    const list = responses.find((r) => r.id === 2);
    const description = list?.result?.tools?.[0]?.description ?? "";
    expect(description).toContain("no direct local tool access");
  });

  it("treats a non-existent working directory as no local tool access (fail-closed)", async () => {
    const responses = await queryToolsList({
      CHATKJB_QWEN_SUBAGENT_CWD: "/no/such/chatkjb/dir/xyz",
      DASHSCOPE_API_KEY: "test-key"
    });
    const list = responses.find((r) => r.id === 2);
    const description = list?.result?.tools?.[0]?.description ?? "";
    expect(description).toContain("no direct local tool access");
  });
});
