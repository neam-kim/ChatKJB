import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexSharedResourceConfig,
  ensureCodexMcpConfigForHome
} from "../src/session-environment.js";

describe("codexSharedResourceConfig", () => {
  it("enables native delegation with three direct child threads", () => {
    const config = codexSharedResourceConfig();
    expect(config).toMatchObject({
      features: { memories: true, multi_agent: true },
      agents: { max_threads: 3, max_depth: 1 }
    });
    expect(config.agents.default.config_file).toContain("codex-agents/lite.toml");
    expect(config.agents.explorer.config_file).toBe(config.agents.default.config_file);
    expect(config.agents.worker.config_file).toBe(config.agents.default.config_file);
  });
});

describe("ensureCodexMcpConfigForHome", () => {
  it("merges shared MCP config into the selected Codex account home", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-mcp-home-"));
    try {
      const primaryConfig = join(root, ".codex", "config.toml");
      const accountHome = join(root, ".codex-acct-c");
      const accountConfig = join(accountHome, "config.toml");
      const connectorRegistry = join(root, ".claude", "shared-resources", "connectors.json");
      const wrapperScript = join(root, "scripts", "run-shared-mcp.mjs");
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(accountHome, { recursive: true });
      mkdirSync(join(root, ".claude", "shared-resources"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        primaryConfig,
        [
          "[mcp_servers.\"shared-tool\"]",
          "command = \"/bin/echo\"",
          "args = [\"shared\"]",
          "",
          "[mcp_servers.\"extra-tool\"]",
          "command = \"/bin/echo\"",
          "args = [\"extra\"]",
          ""
        ].join("\n")
      );
      writeFileSync(
        accountConfig,
        [
          "[mcp_servers.\"shared-tool\"]",
          "url = \"https://example.test/mcp\"",
          ""
        ].join("\n")
      );

      ensureCodexMcpConfigForHome(accountHome, {
        primaryConfig,
        connectorRegistry,
        wrapperScript,
        nodeExecutable: "/usr/bin/node"
      });

      const synced = readFileSync(accountConfig, "utf8");
      expect(synced.match(/\[mcp_servers\."shared-tool"\]/g)).toHaveLength(1);
      expect(synced).toContain("url = \"https://example.test/mcp\"");
      expect(synced).toContain("[mcp_servers.\"extra-tool\"]");
      expect(synced).toContain("run-shared-mcp.mjs");
      expect(synced).toContain("--single-owner-per-parent");
      expect(synced).toContain("# BEGIN ChatKJB shared MCP");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
