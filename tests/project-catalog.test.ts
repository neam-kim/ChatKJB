import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectSelectionPrompt,
  parseProjectSelection,
  ProjectCatalog,
  renderProjectCatalog
} from "../src/project-catalog.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "chatkjb-project-catalog-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project catalog", () => {
  it("discovers project markers and records only path-level descriptions", async () => {
    const root = tempDirectory();
    const alpha = join(root, "alpha");
    const nestedDependency = join(alpha, "node_modules", "ignored");
    const plain = join(root, "plain");
    mkdirSync(nestedDependency, { recursive: true });
    mkdirSync(plain);
    writeFileSync(join(alpha, "package.json"), JSON.stringify({ name: "alpha", description: "Alpha service" }));
    writeFileSync(join(nestedDependency, "package.json"), JSON.stringify({ name: "ignored" }));
    writeFileSync(join(plain, ".env"), "SECRET=value");

    const catalogPath = join(root, "data", "catalog.md");
    const catalog = new ProjectCatalog({
      catalogPath,
      roots: async () => [root],
      knownProjects: () => [],
      maxDepth: 4
    });
    const snapshot = await catalog.refreshAll();

    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]).toMatchObject({ name: "alpha", description: "Alpha service" });
    expect(snapshot.entries[0]?.path).toBe(realpathSync(alpha));
    const markdown = readFileSync(catalogPath, "utf8");
    expect(markdown).toContain("Alpha service");
    expect(markdown).not.toContain("node_modules");
    expect(markdown).not.toContain("SECRET=value");
    expect(statSync(catalogPath).mode & 0o777).toBe(0o600);
  });

  it("does not auto-register a broad scan root but keeps an explicitly known root", async () => {
    const root = tempDirectory();
    writeFileSync(join(root, ".result.md"), "root result");
    const child = join(root, "child");
    mkdirSync(child);
    writeFileSync(join(child, "README.md"), "# Child\n\nChild project.");
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => [root],
      knownProjects: () => []
    });

    expect((await catalog.refreshAll()).entries.map((entry) => entry.path))
      .toEqual([realpathSync(child)]);

    const knownCatalog = new ProjectCatalog({
      catalogPath: join(root, "known-catalog.md"),
      roots: async () => [root],
      knownProjects: () => [{ name: "Explicit Root", cwd: root, defaultMode: "default" }]
    });
    expect((await knownCatalog.refreshAll()).entries.map((entry) => entry.path))
      .toEqual([realpathSync(root), realpathSync(child)]);
  });

  it("keeps catalog rows single-line for adversarial folder names", async () => {
    const root = tempDirectory();
    const project = join(root, "bad|name\nrow");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "# Project\n\nDescription.");
    const catalogPath = join(root, "catalog.md");
    const catalog = new ProjectCatalog({
      catalogPath,
      roots: async () => [root],
      knownProjects: () => []
    });
    await catalog.refreshAll();

    const rows = readFileSync(catalogPath, "utf8").split("\n").filter((line) => line.startsWith("| `project-"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("bad¦name row");
  });

  it("prefers explicit folder descriptions and refreshes one completed project", async () => {
    const root = tempDirectory();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, ".result.md"), "2026-07-17: done");
    writeFileSync(join(project, ".chatkjb-project.md"), "# Project\n\nFirst description.");
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => [root],
      knownProjects: () => []
    });
    await catalog.refreshAll();
    expect((await catalog.current()).entries[0]?.description).toBe("First description.");

    writeFileSync(join(project, ".chatkjb-project.md"), "# Project\n\nUpdated description.");
    const refreshed = await catalog.refreshProject(project);
    expect(refreshed.entries[0]?.description).toBe("Updated description.");
  });

  it("updates the full catalog every 30 minutes by default", async () => {
    vi.useFakeTimers();
    const root = tempDirectory();
    const first = join(root, "first");
    mkdirSync(first);
    writeFileSync(join(first, ".result.md"), "done");
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => [root],
      knownProjects: () => []
    });
    await catalog.start();
    expect((await catalog.current()).entries).toHaveLength(1);

    const second = join(root, "second");
    mkdirSync(second);
    writeFileSync(join(second, "README.md"), "# Second\n\nSecond project.");
    await vi.advanceTimersByTimeAsync(30 * 60 * 1_000);
    expect((await catalog.current()).entries.map((entry) => entry.name)).toEqual(["first", "second"]);
    await catalog.dispose();
  });

  it("refreshes immediately when a network storage root appears", async () => {
    const root = tempDirectory();
    const localRoot = join(root, "local");
    const networkRoot = join(root, "mounted-smb");
    const localProject = join(localRoot, "local-project");
    const networkProject = join(networkRoot, "network-project");
    mkdirSync(localProject, { recursive: true });
    mkdirSync(networkProject, { recursive: true });
    writeFileSync(join(localProject, "README.md"), "# Local\n\nLocal project.");
    writeFileSync(join(networkProject, "README.md"), "# Network\n\nNetwork project.");
    let roots = [localRoot];
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => roots,
      knownProjects: () => []
    });

    await catalog.start();
    expect((await catalog.current()).entries.map((entry) => entry.name)).toEqual(["local-project"]);

    roots = [localRoot, networkRoot];
    expect((await catalog.current()).entries.map((entry) => entry.name))
      .toEqual(["local-project", "network-project"]);
    await catalog.dispose();
  });

  it("skips NAS recycle metadata and renamed node_modules directories", async () => {
    const root = tempDirectory();
    const project = join(root, "project");
    const recycled = join(root, "#recycle", "old-project");
    const metadata = join(root, "@eaDir", "cached-project");
    const brokenModules = join(project, "node_modules.cloudstorage-broken", "dependency");
    mkdirSync(project);
    mkdirSync(recycled, { recursive: true });
    mkdirSync(metadata, { recursive: true });
    mkdirSync(brokenModules, { recursive: true });
    writeFileSync(join(project, "README.md"), "# Project\n\nReal project.");
    writeFileSync(join(recycled, "package.json"), "{}");
    writeFileSync(join(metadata, "package.json"), "{}");
    writeFileSync(join(brokenModules, "package.json"), "{}");
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => [root],
      knownProjects: () => []
    });

    expect((await catalog.refreshAll()).entries.map((entry) => entry.path))
      .toEqual([realpathSync(project)]);
  });

  it("installs periodic recovery even when the startup refresh fails", async () => {
    vi.useFakeTimers();
    const root = tempDirectory();
    const project = join(root, "recovered");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "# Recovered\n\nRecovered project.");
    let attempts = 0;
    const catalogPath = join(root, "catalog.md");
    const catalog = new ProjectCatalog({
      catalogPath,
      roots: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary root failure");
        return [root];
      },
      knownProjects: () => [],
      refreshIntervalMs: 1_000
    });

    await expect(catalog.start()).rejects.toThrow("temporary root failure");
    await vi.advanceTimersByTimeAsync(1_000);
    await catalog.current();
    expect(readFileSync(catalogPath, "utf8")).toContain("Recovered project.");
    await catalog.dispose();
  });

  it("rejects refreshes that begin after disposal", async () => {
    const root = tempDirectory();
    const project = join(root, "project");
    mkdirSync(project);
    writeFileSync(join(project, "README.md"), "# Project\n\nProject description.");
    const catalog = new ProjectCatalog({
      catalogPath: join(root, "catalog.md"),
      roots: async () => [root],
      knownProjects: () => []
    });
    await catalog.start();
    await catalog.dispose();

    await expect(catalog.refreshAll()).rejects.toThrow("종료되었습니다");
    await expect(catalog.refreshProject(project)).rejects.toThrow("종료되었습니다");
  });

  it("parses only structured project selections and marks catalog data untrusted", () => {
    expect(parseProjectSelection('text {"projectId":"project-123","reason":"best"}')).toEqual({
      projectId: "project-123",
      reason: "best"
    });
    expect(parseProjectSelection('{"path":"/tmp/forged"}')).toBeNull();
    const prompt = buildProjectSelectionPrompt(
      "fix login",
      renderProjectCatalog({ generatedAt: "2026-07-17T00:00:00.000Z", entries: [] })
    );
    expect(prompt).toContain("비신뢰 데이터");
    expect(prompt).toContain("카탈로그에 없는 경로나 id를 만들지 마십시오");
  });
});
