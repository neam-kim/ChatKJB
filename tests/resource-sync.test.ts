import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSharedMemoryBridgeText,
  buildSharedResourceGuideText,
  buildSharedSkillCatalog,
  syncSharedResources
} from "../src/resource-sync.js";

describe("shared resource skill catalog", () => {
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
    skillCatalog: "/home/tester/.claude/shared-resources/SKILLS.md",
    connectorRegistry: "/home/tester/.claude/shared-resources/connectors.json"
  };

  it("makes query-first memory recall mandatory for relevant work", () => {
    const text = buildSharedMemoryBridgeText(paths);

    expect(text).toContain("Memory recall is mandatory, not optional");
    expect(text).toContain("/query requests must use this LLM-Wiki flow");
    expect(text).toContain("do not satisfy /query only from native auto-memory");
    expect(text).toContain("deduplicate by meaning");
  });

  it("points providers back to the mandatory bridge policy", () => {
    const text = buildSharedResourceGuideText(paths);

    expect(text).toContain("mandatory recall policy");
    expect(text).toContain("LLM-Wiki query flow");
    expect(text).toContain("native auto-memory fallback only if needed");
  });
});

describe("shared resource sync", () => {
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
          agyMcpConfig: join(root, ".gemini", "config", "mcp_config.json"),
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
});
