import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const GUI_EXECUTION_ENTRYPOINTS = new Set(["gui-entry.ts"]);
const GUI_IMPORT_PATTERN = /\b(?:from|import)\s*(?:\(\s*)?["'](?:\.\.?\/)+gui\//;

function coreSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const sourceRelativePath = relative(SOURCE_ROOT, path);
    if (entry.isDirectory()) {
      if (sourceRelativePath !== "gui") files.push(...coreSourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && !GUI_EXECUTION_ENTRYPOINTS.has(sourceRelativePath)) {
      files.push(path);
    }
  }
  return files;
}

describe("core-to-GUI import boundary", () => {
  it("keeps core domain modules independent from the GUI directory", () => {
    const violations = coreSourceFiles(SOURCE_ROOT)
      .filter((path) => GUI_IMPORT_PATTERN.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path));

    expect(violations).toEqual([]);
  });
});
