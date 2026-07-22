import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexLiteAgentText,
  buildSharedMemoryBridgeText,
  buildSharedPolicyText,
  buildSharedResourceGuideText,
  buildSharedSkillCatalog,
  clearSharedResourceSyncCache,
  defaultCodexAccountHomes,
  selectedClineMcpConnectors,
  syncSharedResources,
  syncSharedResourcesCached
} from "../src/resource-sync.js";
import { projectSourceDir } from "../src/runtime-paths.js";

describe("shared resource path discovery", () => {
  it("expands tilde-based Codex account homes instead of resolving them under cwd", () => {
    const savedHomes = process.env.CODEX_ACCOUNT_HOMES;
    const savedHome = process.env.CODEX_HOME;
    try {
      delete process.env.CODEX_HOME;
      process.env.CODEX_ACCOUNT_HOMES = "~/.codex-acct-b,~/.codex-acct-c";
      expect(defaultCodexAccountHomes(homedir())).toEqual([
        join(homedir(), ".codex-acct-b"),
        join(homedir(), ".codex-acct-c")
      ]);
    } finally {
      if (savedHomes === undefined) delete process.env.CODEX_ACCOUNT_HOMES;
      else process.env.CODEX_ACCOUNT_HOMES = savedHomes;
      if (savedHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedHome;
    }
  });
});

describe("shared resource skill catalog", () => {
  it("includes the three bundled ChatKJB workflow skills", () => {
    const catalog = buildSharedSkillCatalog([join(projectSourceDir(), "skills")]);
    const ids = catalog.map((entry) => entry.id);

    expect(ids).toEqual(expect.arrayContaining(["deep-interview", "ralplan", "ultragoal"]));
    expect(catalog.find((entry) => entry.id === "deep-interview")?.description)
      .toContain("Socratic interview");
  });

  it("deduplicates skills by provider-qualified name and keeps the higher priority source", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-skills-"));
    try {
      const custom = join(root, ".claude", "skills", "sample");
      const plugin = join(
        root,
        ".codex",
        "plugins",
        "cache",
        "openai-curated-remote",
        "analytics",
        "1.0.0",
        "skills",
        "sample"
      );
      mkdirSync(custom, { recursive: true });
      mkdirSync(plugin, { recursive: true });
      writeFileSync(
        join(custom, "SKILL.md"),
        "---\nname: sample\ndescription: custom skill\n---\n"
      );
      writeFileSync(
        join(plugin, "SKILL.md"),
        "---\nname: sample\ndescription: plugin skill\n---\n"
      );

      const catalog = buildSharedSkillCatalog([
        join(root, ".claude", "skills"),
        join(root, ".codex", "plugins", "cache")
      ]);
      expect(catalog.map((entry) => entry.id)).toEqual(["analytics:sample", "sample"]);
      expect(catalog.find((entry) => entry.id === "sample")?.description).toBe("custom skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes grok-native skills in the five-provider shared catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-skills-grok-"));
    try {
      const grokSkill = join(root, ".grok", "skills", "code-review");
      mkdirSync(grokSkill, { recursive: true });
      writeFileSync(
        join(grokSkill, "SKILL.md"),
        "---\nname: code-review\ndescription: grok native review skill\n---\n"
      );

      const catalog = buildSharedSkillCatalog([join(root, ".grok", "skills")]);
      expect(catalog.map((entry) => entry.id)).toContain("code-review");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("folds YAML block-scalar descriptions so catalog entries stay readable", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-skills-block-"));
    try {
      const skill = join(root, ".grok", "skills", "check-work");
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, "SKILL.md"),
        [
          "---",
          "name: check-work",
          "description: >",
          "  Check your work with a verification subagent that reviews diffs,",
          "  runs builds and tests.",
          "metadata:",
          "  short-description: verify",
          "---",
          ""
        ].join("\n")
      );

      const catalog = buildSharedSkillCatalog([join(root, ".grok", "skills")]);
      const entry = catalog.find((item) => item.id === "check-work");
      expect(entry?.description).toBe(
        "Check your work with a verification subagent that reviews diffs, runs builds and tests."
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes MCP-redundant plugin skills from the shared catalog", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-skills-denylist-"));
    try {
      const cache = join(
        root,
        ".codex",
        "plugins",
        "cache",
        "openai-curated",
        "life-science-research",
        "1.0.0",
        "skills"
      );
      const fixtures: Array<[string, string]> = [
        ["chembl-skill", "duplicate of chembl MCP"],
        ["hmdb-skill", "kept metabolite skill"]
      ];
      for (const [name, description] of fixtures) {
        mkdirSync(join(cache, name), { recursive: true });
        writeFileSync(
          join(cache, name, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n`
        );
      }

      const catalog = buildSharedSkillCatalog([join(root, ".codex", "plugins", "cache")]);
      const ids = catalog.map((entry) => entry.id);
      expect(ids).not.toContain("life-science-research:chembl-skill");
      expect(ids).toContain("life-science-research:hmdb-skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("shared memory resource text", () => {
  const paths = {
    home: "/home/tester",
    claudeMemory: "/home/tester/.claude/memory",
    claudeAutoMemory: "/home/tester/.claude/projects",
    codexMemory: "/home/tester/.codex/memories",
    llmWikiRoot: "/home/tester/LLM-Wiki",
    llmWikiRouter: "/home/tester/LLM-Wiki/30-wiki/index.md",
    llmWikiInbox: "/home/tester/LLM-Wiki/10-inbox",
    memoryBridge: "/home/tester/.claude/shared-resources/MEMORY-BRIDGE.md",
    policyGuide: "/home/tester/.claude/shared-resources/POLICIES.md",
    skillCatalog: "/home/tester/.claude/shared-resources/SKILLS.md",
    connectorRegistry: "/home/tester/.claude/shared-resources/connectors.json"
  };

  it("makes query-first memory recall mandatory for relevant work", () => {
    const text = buildSharedMemoryBridgeText(paths);

    expect(text).toContain("Memory recall is mandatory, not optional");
    expect(text).toContain("/query requests must use this LLM-Wiki flow");
    expect(text).toContain("do not satisfy /query only from native auto-memory");
    expect(text).toContain("deduplicate by meaning");
    expect(text).toContain("위키에 없음 — /compile 또는 /ingest 필요");
  });

  it("keeps the common layer lazy while preserving detailed policies", () => {
    const text = buildSharedResourceGuideText(paths);
    const policy = buildSharedPolicyText(paths);

    expect(text).toContain("Claude, Codex, agy, Grok, and Cline");
    expect(text).toContain("POLICIES.md section");
    expect(text).toContain("LLM-Wiki query flow");
    expect(text).toContain("native auto-memory fallback only if needed");
    expect(policy).toContain("Never have more than 3 active subagents");
    expect(policy).toContain("Use frontmatter with `name`");
    expect(policy).toContain("Per-conversation Result Log");
    expect(policy).toContain("subagents must never create, append, rewrite, or delete a `.result.md` file");
    expect(policy).toContain("YYYY-MM-DDTHH:mm:ss+09:00");
  });

  it("builds a standalone-valid MCP-free Codex child role without overriding its role name", () => {
    const text = buildCodexLiteAgentText({
      local: {
        type: "stdio",
        command: "/usr/bin/node",
        args: ["server.mjs", "--stdio"],
        env: { SAMPLE_TOKEN: "test" }
      },
      remote: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer test" }
      }
    });

    expect(text).not.toMatch(/^name\s*=/m);
    expect(text).toContain('[mcp_servers."local"]');
    expect(text).toContain('command = "/usr/bin/node"');
    expect(text).toContain('args = ["server.mjs", "--stdio"]');
    expect(text).toContain('[mcp_servers."local".env]');
    expect(text).toContain('[mcp_servers."remote"]');
    expect(text).toContain('url = "https://example.test/mcp"');
    expect(text.match(/enabled = false/g)).toHaveLength(2);
  });
});

describe("shared resource sync", () => {
  it("reuses a recent resource snapshot and refreshes it after the TTL", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-cache-"));
    try {
      const sharedRoot = join(root, ".claude", "shared-resources");
      const skillRoot = join(root, "skills");
      const overrides = {
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig: join(root, ".codex", "config.toml"),
        codexAccountConfigs: [],
        agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
        grokConfigPath: join(root, ".grok", "config.toml"),
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [skillRoot],
        providerSkillRoots: []
      };
      clearSharedResourceSyncCache();
      const first = syncSharedResourcesCached(overrides, { ttlMs: 100, now: 1_000 });
      mkdirSync(join(skillRoot, "new-skill"), { recursive: true });
      writeFileSync(
        join(skillRoot, "new-skill", "SKILL.md"),
        "---\nname: new-skill\ndescription: test\n---\n"
      );

      const cached = syncSharedResourcesCached(overrides, { ttlMs: 100, now: 1_050 });
      const refreshed = syncSharedResourcesCached(overrides, { ttlMs: 100, now: 1_101 });

      expect(first.skillCount).toBe(0);
      expect(cached.skillCount).toBe(0);
      expect(refreshed.skillCount).toBe(1);
    } finally {
      clearSharedResourceSyncCache();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not recreate an existing broken memory summary symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-sync-"));
    try {
      const sharedRoot = join(root, ".claude", "shared-resources");
      const linkPath = join(root, ".claude", "memory", "CODEX_MEMORY_SUMMARY.md");
      const target = join(root, ".codex", "memories", "memory_summary.md");
      mkdirSync(join(root, ".claude", "memory"), { recursive: true });
      symlinkSync(target, linkPath);

      expect(() =>
        syncSharedResources({
          home: root,
          sharedRoot,
          connectorRegistry: join(sharedRoot, "connectors.json"),
          skillCatalog: join(sharedRoot, "SKILLS.md"),
          resourceGuide: join(sharedRoot, "RESOURCE.md"),
          memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
          routerSkill: join(sharedRoot, "shared-skill-router"),
          codexConfig: join(root, ".codex", "config.toml"),
          codexAccountConfigs: [],
          agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
          grokConfigPath: join(root, ".grok", "config.toml"),
          wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
          skillRoots: [],
          providerSkillRoots: [
            join(root, ".claude", "skills"),
            join(root, ".codex", "skills")
          ]
        })
      ).not.toThrow();

      expect(readlinkSync(linkPath)).toBe(target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("symlinks the shared skill router into the grok provider root", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-sync-grok-"));
    try {
      const sharedRoot = join(root, ".claude", "shared-resources");
      const grokSkills = join(root, ".grok", "skills");

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig: join(root, ".codex", "config.toml"),
        codexAccountConfigs: [],
        agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
        grokConfigPath: join(root, ".grok", "config.toml"),
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: [grokSkills]
      });

      const link = join(grokSkills, "shared-skill-router");
      expect(readlinkSync(link)).toBe(join(sharedRoot, "shared-skill-router"));
      expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain(
        "name: shared-skill-router"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes canonical instructions and the skill router at Cline global and project discovery paths", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-sync-cline-"));
    try {
      const projectRoot = join(root, "project");
      const sharedRoot = join(root, ".claude", "shared-resources");
      const canonical = join(root, ".claude", "CLAUDE.md");
      const globalSkills = join(root, ".agents", "skills");
      const projectSkills = join(projectRoot, ".agents", "skills");
      mkdirSync(join(root, ".claude"), { recursive: true });
      writeFileSync(canonical, "# Canonical instructions\n");

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig: join(root, ".codex", "config.toml"),
        codexAccountConfigs: [],
        agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
        grokConfigPath: join(root, ".grok", "config.toml"),
        wrapperScript: join(projectRoot, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: [globalSkills, projectSkills]
      });

      expect(readlinkSync(join(root, ".agents", "AGENTS.md"))).toBe(canonical);
      expect(readlinkSync(join(projectRoot, "AGENTS.md"))).toBe(canonical);
      expect(readlinkSync(join(globalSkills, "shared-skill-router"))).toBe(
        join(sharedRoot, "shared-skill-router")
      );
      expect(readlinkSync(join(projectSkills, "shared-skill-router"))).toBe(
        join(sharedRoot, "shared-skill-router")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes shared Peekaboo, Playwright, and price-feed tools available to all five providers", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-browser-mcp-"));
    const savedAgyMcpServers = process.env.AGY_MCP_SERVERS;
    const savedGrokMcpServers = process.env.GROK_MCP_SERVERS;
    try {
      delete process.env.AGY_MCP_SERVERS;
      delete process.env.GROK_MCP_SERVERS;
      const sharedRoot = join(root, ".claude", "shared-resources");
      const codexConfig = join(root, ".codex", "config.toml");
      const agyConfig = join(root, ".gemini", "config", "mcp_config.json");
      const grokConfig = join(root, ".grok", "config.toml");
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(join(root, ".grok"), { recursive: true });
      mkdirSync(join(root, ".gemini", "config"), { recursive: true });
      writeFileSync(agyConfig, "{\n  \"mcpServers\": {}\n}\n");
      writeFileSync(
        codexConfig,
        [
          "[mcp_servers.playwright]",
          'command = "npx"',
          'args = ["-y", "@playwright/mcp"]',
          "",
          "[mcp_servers.peekaboo]",
          'command = "/opt/homebrew/bin/peekaboo"',
          'args = ["mcp"]',
          "",
          '[mcp_servers."price-feed"]',
          'command = "/usr/bin/price-feed"',
          ""
        ].join("\n")
      );

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig,
        codexAccountConfigs: [],
        agyMcpConfig: agyConfig,
        grokConfigPath: grokConfig,
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: []
      });

      const registry = JSON.parse(readFileSync(join(sharedRoot, "connectors.json"), "utf8"));
      const agy = JSON.parse(readFileSync(agyConfig, "utf8"));
      expect(registry.playwright.args).toContain("@playwright/mcp");
      expect(registry.peekaboo).toMatchObject({
        command: "/opt/homebrew/bin/peekaboo",
        args: ["mcp"]
      });
      expect(registry["price-feed"].command).toBe("/usr/bin/price-feed");
      expect(agy.mcpServers.peekaboo.args.at(-1)).toBe("peekaboo");
      expect(agy.mcpServers.playwright.args.at(-1)).toBe("playwright");
      expect(agy.mcpServers["price-feed"].args.at(-1)).toBe("price-feed");
      expect(readFileSync(grokConfig, "utf8")).toContain('[mcp_servers."playwright"]');
      expect(readFileSync(grokConfig, "utf8")).toContain('[mcp_servers."peekaboo"]');
      expect(readFileSync(grokConfig, "utf8")).toContain('[mcp_servers."price-feed"]');
      const cline = JSON.parse(readFileSync(
        join(root, ".cline", "data", "settings", "cline_mcp_settings.json"),
        "utf8"
      ));
      expect(cline.mcpServers.playwright.transport.args.at(-1)).toBe("playwright");
      expect(cline.mcpServers.peekaboo.transport.args.at(-1)).toBe("peekaboo");
      expect(cline.mcpServers["price-feed"].transport.args.at(-1)).toBe("price-feed");
    } finally {
      if (savedAgyMcpServers === undefined) delete process.env.AGY_MCP_SERVERS;
      else process.env.AGY_MCP_SERVERS = savedAgyMcpServers;
      if (savedGrokMcpServers === undefined) delete process.env.GROK_MCP_SERVERS;
      else process.env.GROK_MCP_SERVERS = savedGrokMcpServers;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes stale provider-native MCP wrappers from the agy configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-native-mcp-cleanup-"));
    const savedAgyMcpServers = process.env.AGY_MCP_SERVERS;
    try {
      delete process.env.AGY_MCP_SERVERS;
      const sharedRoot = join(root, ".claude", "shared-resources");
      const codexConfig = join(root, ".codex", "config.toml");
      const agyConfig = join(root, ".gemini", "config", "mcp_config.json");
      const grokConfig = join(root, ".grok", "config.toml");
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(join(root, ".gemini", "config"), { recursive: true });
      mkdirSync(join(root, ".grok"), { recursive: true });
      writeFileSync(codexConfig, '[mcp_servers.playwright]\ncommand = "npx"\n');
      writeFileSync(
        agyConfig,
        JSON.stringify({
          mcpServers: {
            "computer-use": {
              command: "/node",
              args: [join(root, "scripts", "run-shared-mcp.mjs"), join(sharedRoot, "connectors.json"), "computer-use"]
            }
          }
        })
      );

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig,
        codexAccountConfigs: [],
        agyMcpConfig: agyConfig,
        grokConfigPath: grokConfig,
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: []
      });

      const agy = JSON.parse(readFileSync(agyConfig, "utf8"));
      expect(agy.mcpServers["computer-use"]).toBeUndefined();
      expect(agy.mcpServers.playwright.args.at(-1)).toBe("playwright");
    } finally {
      if (savedAgyMcpServers === undefined) delete process.env.AGY_MCP_SERVERS;
      else process.env.AGY_MCP_SERVERS = savedAgyMcpServers;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("syncs shared MCP blocks into Codex account configs", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-sync-"));
    try {
      const sharedRoot = join(root, ".claude", "shared-resources");
      const codexConfig = join(root, ".codex", "config.toml");
      const accountConfig = join(root, ".codex-acct-b", "config.toml");
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(join(root, ".codex-acct-b"), { recursive: true });
      writeFileSync(
        codexConfig,
        [
          "[mcp_servers.\"sample-tool\"]",
          "command = \"/bin/echo\"",
          "args = [\"sample\"]",
          ""
        ].join("\n")
      );
      writeFileSync(accountConfig, "model = \"gpt-5\"\n");
      const grokConfig = join(root, ".grok", "config.toml");
      mkdirSync(join(root, ".grok"), { recursive: true });
      writeFileSync(grokConfig, "[cli]\ninstaller = \"internal\"\n");

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig,
        codexAccountConfigs: [accountConfig],
        agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
        grokConfigPath: join(root, ".grok", "config.toml"),
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: []
      });

      const synced = readFileSync(accountConfig, "utf8");
      expect(synced).toContain("# BEGIN ChatKJB shared MCP");
      expect(synced).toContain("[mcp_servers.\"sample-tool\"]");
      expect(synced).toContain("run-shared-mcp.mjs");
      expect(synced).toContain("--single-owner-per-parent");

      // grok config.toml도 같은 관리 블록을 받고 기존 [cli] 섹션은 보존한다.
      const grokSynced = readFileSync(grokConfig, "utf8");
      expect(grokSynced).toContain("[cli]");
      expect(grokSynced).toContain("# BEGIN ChatKJB shared MCP");
      expect(grokSynced).not.toContain("--single-owner-per-parent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one canonical global instruction file and generates lazy policy and lite-role resources", () => {
    const root = mkdtempSync(join(tmpdir(), "shared-resource-global-links-"));
    try {
      const sharedRoot = join(root, ".claude", "shared-resources");
      const canonical = join(root, ".claude", "CLAUDE.md");
      const codexConfig = join(root, ".codex", "config.toml");
      const accountConfig = join(root, ".codex-acct-b", "config.toml");
      mkdirSync(join(root, ".claude"), { recursive: true });
      mkdirSync(join(root, ".codex"), { recursive: true });
      mkdirSync(join(root, ".codex-acct-b"), { recursive: true });
      writeFileSync(canonical, "# Thin global instructions\n");
      writeFileSync(
        codexConfig,
        '[mcp_servers."sample-tool"]\ncommand = "/bin/echo"\nargs = ["sample"]\n'
      );
      writeFileSync(accountConfig, "model = \"gpt-5\"\n");

      syncSharedResources({
        home: root,
        sharedRoot,
        connectorRegistry: join(sharedRoot, "connectors.json"),
        skillCatalog: join(sharedRoot, "SKILLS.md"),
        resourceGuide: join(sharedRoot, "RESOURCE.md"),
        memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
        routerSkill: join(sharedRoot, "shared-skill-router"),
        codexConfig,
        codexAccountConfigs: [accountConfig],
        agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
        grokConfigPath: join(root, ".grok", "config.toml"),
        wrapperScript: join(root, "scripts", "run-shared-mcp.mjs"),
        skillRoots: [],
        providerSkillRoots: []
      });

      for (const link of [
        join(root, ".codex", "AGENTS.md"),
        join(root, ".codex-acct-b", "AGENTS.md"),
        join(root, ".gemini", "config", "AGENTS.md"),
        join(root, ".grok", "Agents.md"),
        join(root, ".agents", "AGENTS.md"),
        join(root, "AGENTS.md")
      ]) {
        expect(readlinkSync(link)).toBe(canonical);
      }
      expect(readFileSync(join(sharedRoot, "POLICIES.md"), "utf8")).toContain(
        "Global and ChatKJB Detailed Policies"
      );
      const lite = readFileSync(join(sharedRoot, "codex-agents", "lite.toml"), "utf8");
      expect(lite).toContain('[mcp_servers."sample-tool"]');
      expect(lite).toContain('command = "/bin/echo"');
      expect(lite).toContain("enabled = false");
      const cline = JSON.parse(readFileSync(
        join(root, ".cline", "data", "settings", "cline_mcp_settings.json"),
        "utf8"
      ));
      expect(cline.mcpServers["sample-tool"].transport).toMatchObject({
        type: "stdio",
        command: process.execPath,
        args: [
          join(root, "scripts", "run-shared-mcp.mjs"),
          join(sharedRoot, "connectors.json"),
          "sample-tool"
        ]
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("selectedClineMcpConnectors", () => {
  const connectors = {
    "apple-mail": { type: "stdio", command: "a" },
    "interactive-brokers": { type: "stdio", command: "d" },
    "llm-wiki": { type: "stdio", command: "b" },
    obsidian: { type: "stdio", command: "c" }
  } as never;

  it("drops every known Moonshot-incompatible server by default", () => {
    const selected = selectedClineMcpConnectors(connectors);
    expect(Object.keys(selected).sort()).toEqual(["llm-wiki", "obsidian"]);
  });

  it("honours an explicit exclusion list and keeps everything when it is empty", () => {
    expect(Object.keys(selectedClineMcpConnectors(connectors, "obsidian")).sort())
      .toEqual(["apple-mail", "interactive-brokers", "llm-wiki"]);
    expect(Object.keys(selectedClineMcpConnectors(connectors, "")).sort())
      .toEqual(["apple-mail", "interactive-brokers", "llm-wiki", "obsidian"]);
  });
});
