import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexEnvironment,
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

describe("번들 실행 시 provider CLI 탐색 경로", () => {
  // 데몬이 ChatKJB.app 번들로 실행되면 process.execPath는 번들 안을 가리킨다.
  // 그 디렉터리에는 codex 같은 CLI가 없으므로 실제 Node bin을 함께 넣어야 한다.
  it("CHATKJB_NODE_BIN을 PATH 앞에 넣는다", () => {
    const env = buildCodexEnvironment(undefined, {
      PATH: "/usr/bin:/bin",
      CHATKJB_NODE_BIN: "/real/node/bin"
    } as NodeJS.ProcessEnv);
    expect(env["PATH"]?.split(":")[0]).toBe("/real/node/bin");
    expect(env["PATH"]).toContain("/usr/bin");
  });

  it("PATH에 이미 있으면 중복해서 넣지 않는다", () => {
    const env = buildCodexEnvironment(undefined, {
      PATH: "/real/node/bin:/usr/bin",
      CHATKJB_NODE_BIN: "/real/node/bin"
    } as NodeJS.ProcessEnv);
    expect(env["PATH"]?.split(":").filter((entry: string) => entry === "/real/node/bin")).toHaveLength(1);
  });

  it("미설정이어도 기존 동작을 유지한다", () => {
    const env = buildCodexEnvironment(undefined, { PATH: "/usr/bin:/bin" } as NodeJS.ProcessEnv);
    expect(env["PATH"]).toContain("/usr/bin");
  });
});
