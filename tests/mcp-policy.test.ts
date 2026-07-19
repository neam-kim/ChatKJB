import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRetryableMcpError,
  loadMcpServersWithTimeouts,
  mcpServerName
} from "../src/mcp-policy.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP policy", () => {
  it("uses a longer timeout for Codex than for ordinary MCP servers", () => {
    const directory = mkdtempSync(join(tmpdir(), "telegram-claude-mcp-"));
    directories.push(directory);
    const path = join(directory, ".claude.json");
    writeFileSync(path, JSON.stringify({
      mcpServers: {
        obsidian: { command: "node", args: ["obsidian.js"] },
        codex: { command: "node", args: ["codex", "mcp-server"] },
        remote_tools: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer test" }
        },
        local_file: {
          type: "http",
          url: "file:///etc/passwd"
        }
      }
    }));

    const servers = loadMcpServersWithTimeouts(60_000, 1_800_000, new Set(["codex"]), path);
    expect(servers.obsidian && "timeout" in servers.obsidian
      ? servers.obsidian.timeout
      : undefined).toBe(60_000);
    expect(servers.codex && "timeout" in servers.codex
      ? servers.codex.timeout
      : undefined).toBe(1_800_000);
    expect(servers.obsidian && "alwaysLoad" in servers.obsidian
      ? servers.obsidian.alwaysLoad
      : undefined).toBeUndefined();
    expect(servers.codex && "alwaysLoad" in servers.codex
      ? servers.codex.alwaysLoad
      : undefined).toBe(true);
    expect(servers.remote_tools).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
      timeout: 60_000
    });
    expect(servers.local_file).toBeUndefined();
  });

  it("recognizes retryable MCP transport failures", () => {
    expect(mcpServerName("mcp__obsidian__read-note")).toBe("obsidian");
    expect(mcpServerName("mcp__my_tools__read-note")).toBe("my_tools");
    expect(isRetryableMcpError(
      "mcp__obsidian__read-note",
      "MCP error -32000: Connection closed"
    )).toBe(true);
    expect(isRetryableMcpError("Read", "Connection closed")).toBe(false);
  });
});
