import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadClaudeConnectors,
  loadMergedConnectors,
  parseCodexMcpServers,
  syncAgyMcpConfig,
  toGeminiMcpConfig
} from "../src/connectors.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "telegram-claude-connectors-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CODEX_TOML = `
model = "gpt-5.5"

[projects."/some/path"]
trust_level = "trusted"

[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@0.0.75", "--browser", "webkit"]
startup_timeout_sec = 120

[mcp_servers.obsidian]
command = "npx"
args = ["-y", "obsidian-mcp", "/vault path/with spaces"]

[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"
args = []

[mcp_servers.node_repl.env]
CODEX_HOME = "/Users/x/.codex"
NODE_REPL_TIMEOUT = "1000"

[mcp_servers.remote_http]
type = "http"
url = "https://example.com/mcp"
`;

describe("parseCodexMcpServers", () => {
  it("parses stdio, env subtables, and remote servers", () => {
    const servers = parseCodexMcpServers(CODEX_TOML);
    expect(Object.keys(servers).sort()).toEqual([
      "node_repl",
      "obsidian",
      "playwright",
      "remote_http"
    ]);

    const playwright = servers.playwright as { command: string; args: string[] };
    expect(playwright.command).toBe("npx");
    expect(playwright.args).toEqual(["-y", "@playwright/mcp@0.0.75", "--browser", "webkit"]);

    // 경로에 공백이 있어도 문자열 그대로 보존한다.
    const obsidian = servers.obsidian as { args: string[] };
    expect(obsidian.args[2]).toBe("/vault path/with spaces");

    // env 서브테이블이 env로 모인다.
    const nodeRepl = servers.node_repl as { env: Record<string, string> };
    expect(nodeRepl.env.CODEX_HOME).toBe("/Users/x/.codex");
    expect(nodeRepl.env.NODE_REPL_TIMEOUT).toBe("1000");

    const remote = servers.remote_http as { type: string; url: string };
    expect(remote.type).toBe("http");
    expect(remote.url).toBe("https://example.com/mcp");
  });

  it("ignores comments and non-mcp tables", () => {
    const servers = parseCodexMcpServers(
      `# comment\n[other]\nfoo = "bar"\n[mcp_servers.a]\ncommand = "x" # trailing\n`
    );
    expect(Object.keys(servers)).toEqual(["a"]);
    expect((servers.a as { command: string }).command).toBe("x");
  });
});

describe("loadMergedConnectors", () => {
  it("merges claude.json over codex config on name collision", () => {
    const dir = tempDir();
    const codexPath = join(dir, "config.toml");
    const claudePath = join(dir, ".claude.json");
    writeFileSync(
      codexPath,
      `[mcp_servers.shared]\ncommand = "codex-cmd"\n[mcp_servers.codexonly]\ncommand = "c"\n`
    );
    writeFileSync(
      claudePath,
      JSON.stringify({
        mcpServers: {
          shared: { command: "claude-cmd" },
          claudeonly: { command: "j" }
        }
      })
    );

    const merged = loadMergedConnectors({ codexConfigPath: codexPath, claudeJsonPath: claudePath });
    expect(Object.keys(merged).sort()).toEqual(["claudeonly", "codexonly", "shared"]);
    // claude.json이 우선한다.
    expect((merged.shared as { command: string }).command).toBe("claude-cmd");
  });

  it("returns empty when neither source exists", () => {
    const dir = tempDir();
    const merged = loadMergedConnectors({
      codexConfigPath: join(dir, "missing.toml"),
      claudeJsonPath: join(dir, "missing.json")
    });
    expect(merged).toEqual({});
  });
});

describe("loadClaudeConnectors", () => {
  it("applies long timeout + alwaysLoad only to long-running servers", () => {
    const dir = tempDir();
    const codexPath = join(dir, "config.toml");
    writeFileSync(
      codexPath,
      `[mcp_servers.playwright]\ncommand = "npx"\n[mcp_servers.obsidian]\ncommand = "npx"\n`
    );
    const servers = loadClaudeConnectors(60_000, 1_800_000, new Set(["obsidian"]), {
      codexConfigPath: codexPath,
      claudeJsonPath: join(dir, "missing.json")
    });
    const playwright = servers.playwright as { timeout: number; alwaysLoad?: boolean };
    const obsidian = servers.obsidian as { timeout: number; alwaysLoad?: boolean };
    expect(playwright.timeout).toBe(60_000);
    expect(playwright.alwaysLoad).toBeUndefined();
    expect(obsidian.timeout).toBe(1_800_000);
    expect(obsidian.alwaysLoad).toBe(true);
  });
});

describe("toGeminiMcpConfig", () => {
  it("converts stdio and remote servers to gemini format", () => {
    const merged = parseCodexMcpServers(CODEX_TOML);
    const config = toGeminiMcpConfig(merged);
    expect(config.mcpServers.playwright).toMatchObject({ command: "npx" });
    // SDK 전용 필드(timeout/type)는 stdio에 없다.
    expect(config.mcpServers.playwright).not.toHaveProperty("timeout");
    // http 서버는 httpUrl로 변환된다.
    expect(config.mcpServers.remote_http).toEqual({ httpUrl: "https://example.com/mcp" });
  });
});

describe("syncAgyMcpConfig", () => {
  it("writes merged connectors, preserves existing user servers, and is idempotent", () => {
    const dir = tempDir();
    const geminiPath = join(dir, "mcp_config.json");
    writeFileSync(
      geminiPath,
      JSON.stringify({ mcpServers: { userserver: { command: "keepme" } }, other: 1 })
    );
    const merged = parseCodexMcpServers(`[mcp_servers.playwright]\ncommand = "npx"\n`);

    const first = syncAgyMcpConfig(merged, geminiPath);
    expect(first.changed).toBe(true);
    expect(first.count).toBe(1);

    const written = JSON.parse(readFileSync(geminiPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
      other: number;
    };
    expect(written.other).toBe(1);
    expect(written.mcpServers.userserver).toEqual({ command: "keepme" });
    expect(written.mcpServers.playwright).toEqual({ command: "npx" });

    // 두 번째 호출은 동일 내용이라 쓰지 않는다.
    const second = syncAgyMcpConfig(merged, geminiPath);
    expect(second.changed).toBe(false);
  });

  it("does nothing when there are no connectors", () => {
    const dir = tempDir();
    const geminiPath = join(dir, "mcp_config.json");
    const result = syncAgyMcpConfig({}, geminiPath);
    expect(result).toEqual({ changed: false, count: 0 });
  });
});
