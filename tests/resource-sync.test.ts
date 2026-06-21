import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSharedSkillCatalog } from "../src/resource-sync.js";

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
