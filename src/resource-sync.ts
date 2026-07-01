import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  loadMergedConnectors,
  syncAgyMcpConfig,
  syncCodexMcpConfig
} from "./connectors.js";

export interface SharedResourcePaths {
  home: string;
  sharedRoot: string;
  connectorRegistry: string;
  skillCatalog: string;
  resourceGuide: string;
  memoryBridge: string;
  routerSkill: string;
  codexConfig: string;
  agyMcpConfig: string;
  wrapperScript: string;
  skillRoots: string[];
  providerSkillRoots: string[];
}

export interface SharedResourceSummary {
  skillCount: number;
  connectorCount: number;
  providerSkillRoots: number;
}

function defaultPaths(): SharedResourcePaths {
  const home = homedir();
  const sharedRoot = join(home, ".claude", "shared-resources");
  return {
    home,
    sharedRoot,
    connectorRegistry: join(sharedRoot, "connectors.json"),
    skillCatalog: join(sharedRoot, "SKILLS.md"),
    resourceGuide: join(sharedRoot, "RESOURCE.md"),
    memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
    routerSkill: join(sharedRoot, "shared-skill-router"),
    codexConfig: join(home, ".codex", "config.toml"),
    agyMcpConfig: join(home, ".gemini", "config", "mcp_config.json"),
    wrapperScript: resolve(process.cwd(), "scripts", "run-shared-mcp.mjs"),
    skillRoots: [
      join(home, ".claude", "skills"),
      join(home, ".codex", "skills"),
      join(home, ".codex", "plugins", "cache"),
      join(home, ".gemini", "config", "skills"),
      join(home, ".gemini", "antigravity-cli", "builtin", "skills")
    ],
    providerSkillRoots: [
      join(home, ".claude", "skills"),
      join(home, ".codex", "skills"),
      join(home, ".gemini", "config", "skills")
    ]
  };
}

function ensureSymlink(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const current = lstatSync(linkPath);
    if (current.isSymbolicLink() && realpathSync(linkPath) === realpathSync(target)) return;
    rmSync(linkPath, { recursive: current.isDirectory(), force: true });
  } catch {
    // Missing or broken link.
  }
  symlinkSync(target, linkPath);
}

function walkSkillFiles(root: string, output: Set<string>, visited: Set<string>): void {
  if (!existsSync(root)) return;
  let real: string;
  try {
    real = realpathSync(root);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);
  let entries;
  try {
    entries = readdirSync(real, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".system") continue;
    const path = join(real, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      walkSkillFiles(path, output, visited);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      output.add(path);
    }
  }
}

function frontmatterValue(text: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*[\"']?(.+?)[\"']?\\s*$`, "m").exec(text.slice(0, 4000));
  return match?.[1]?.trim() ?? null;
}

function pluginName(path: string): string | null {
  const normalized = path.split("/");
  const cacheIndex = normalized.lastIndexOf("cache");
  if (cacheIndex < 0 || normalized.length <= cacheIndex + 2) return null;
  const family = normalized[cacheIndex + 1] ?? "";
  const plugin = normalized[cacheIndex + 2] ?? "";
  if (!family.startsWith("openai-") || !plugin) return null;
  return plugin;
}

function skillPriority(path: string): number {
  if (path.includes("/.claude/skills/") && !path.includes("/.codex/plugins/cache/")) return 100;
  if (path.includes("/.codex/skills/.system/")) return 95;
  if (path.includes("/openai-curated-remote/")) return 90;
  if (path.includes("/openai-bundled/")) return 85;
  if (path.includes("/openai-primary-runtime/")) return 85;
  if (path.includes("/openai-curated/")) return 80;
  return 50;
}

interface SkillEntry {
  id: string;
  name: string;
  description: string;
  path: string;
  priority: number;
}

export function buildSharedSkillCatalog(skillRoots: string[]): SkillEntry[] {
  const files = new Set<string>();
  const visited = new Set<string>();
  for (const root of skillRoots) walkSkillFiles(root, files, visited);
  const selected = new Map<string, SkillEntry>();
  for (const path of files) {
    if (path.includes("/shared-skill-router/")) continue;
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const name = frontmatterValue(text, "name") ?? basename(dirname(path));
    const plugin = pluginName(path);
    const id = plugin ? `${plugin}:${name}` : name;
    const entry: SkillEntry = {
      id,
      name,
      description: frontmatterValue(text, "description") ?? "",
      path,
      priority: skillPriority(path)
    };
    const existing = selected.get(id);
    if (!existing || entry.priority > existing.priority || entry.path > existing.path) {
      selected.set(id, entry);
    }
  }
  return [...selected.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function registryCommand(command: unknown): unknown {
  if (command === "node") return process.execPath;
  if (command === "npx") {
    const npx = join(dirname(process.execPath), "npx");
    return existsSync(npx) ? npx : command;
  }
  return command;
}

function registryEnv(command: unknown, env: unknown): Record<string, string> {
  const result =
    env && typeof env === "object" && !Array.isArray(env)
      ? { ...(env as Record<string, string>) }
      : {};
  if (command === "npx") {
    const nodeBin = dirname(process.execPath);
    result.PATH = result.PATH ? `${nodeBin}:${result.PATH}` : `${nodeBin}:/usr/bin:/bin`;
  }
  return result;
}

function registryServer(server: McpServerConfig): Record<string, unknown> {
  const value = server as Record<string, unknown>;
  if (value.type === "http" || value.type === "sse") {
    return {
      type: value.type,
      url: value.url,
      ...(value.headers ? { headers: value.headers } : {})
    };
  }
  return {
    type: "stdio",
    command: registryCommand(value.command),
    args: value.args ?? [],
    env: registryEnv(value.command, value.env)
  };
}

function writeRouterSkill(paths: SharedResourcePaths): void {
  mkdirSync(paths.routerSkill, { recursive: true });
  writeFileSync(
    join(paths.routerSkill, "SKILL.md"),
    [
      "---",
      "name: shared-skill-router",
      "description: Use the shared cross-provider skill catalog before work that may match an installed skill.",
      "---",
      "",
      "# Shared Skill Router",
      "",
      `Search ${paths.skillCatalog} for a matching skill. Read the selected SKILL.md completely and follow it.`,
      "The catalog is the common source for Claude, Codex, and agy. Prefer it over provider-specific discovery.",
      ""
    ].join("\n"),
    { mode: 0o644 }
  );
  for (const root of paths.providerSkillRoots) {
    mkdirSync(root, { recursive: true });
    const target = join(root, "shared-skill-router");
    ensureSymlink(paths.routerSkill, target);
  }
}

export function sharedResourceGuidePath(home = homedir()): string {
  return join(home, ".claude", "shared-resources", "RESOURCE.md");
}

export function sharedMemoryBridgePath(home = homedir()): string {
  return join(home, ".claude", "shared-resources", "MEMORY-BRIDGE.md");
}

export function syncSharedResources(
  overrides: Partial<SharedResourcePaths> = {}
): SharedResourceSummary {
  const paths = { ...defaultPaths(), ...overrides };
  mkdirSync(paths.sharedRoot, { recursive: true });

  const skills = buildSharedSkillCatalog(paths.skillRoots);
  writeFileSync(
    paths.skillCatalog,
    [
      "# Shared Skill Catalog",
      "",
      "Claude, Codex, and agy use this same catalog. Search by task keyword, then read the selected SKILL.md.",
      "",
      ...skills.map((skill) =>
        `- \`${skill.id}\` — ${skill.description || skill.name} — \`${skill.path}\``
      ),
      ""
    ].join("\n"),
    { mode: 0o644 }
  );
  writeRouterSkill(paths);

  const claudeMemory = join(paths.home, ".claude", "memory");
  const claudeAutoMemory = join(paths.home, ".claude", "projects");
  const codexMemory = join(paths.home, ".codex", "memories");
  const llmWikiRoot = join(
    paths.home,
    "Library",
    "CloudStorage",
    "SynologyDrive-neam",
    "AI",
    "LLM-Wiki"
  );
  const llmWikiRouter = join(llmWikiRoot, "30-wiki", "index.md");
  const llmWikiInbox = join(llmWikiRoot, "10-inbox");
  ensureSymlink(
    join(codexMemory, "memory_summary.md"),
    join(claudeMemory, "CODEX_MEMORY_SUMMARY.md")
  );
  ensureSymlink(
    join(codexMemory, "MEMORY.md"),
    join(claudeMemory, "CODEX_MEMORY_INDEX.md")
  );
  ensureSymlink(
    join(claudeMemory, "MEMORY.md"),
    join(codexMemory, "CLAUDE_MEMORY_INDEX.md")
  );
  ensureSymlink(
    claudeAutoMemory,
    join(codexMemory, "CLAUDE_AUTO_MEMORIES")
  );

  writeFileSync(
    paths.memoryBridge,
    [
      "# Claude and Codex Memory Bridge",
      "",
      "Both native memory systems remain enabled and keep their own formats.",
      "",
      `- Claude canonical facts: ${claudeMemory}`,
      `- Claude index: ${join(claudeMemory, "MEMORY.md")}`,
      `- LLM-Wiki root: ${llmWikiRoot}`,
      `- LLM-Wiki router: ${llmWikiRouter}`,
      `- LLM-Wiki inbox: ${llmWikiInbox}`,
      "- LLM-Wiki connector: llm-wiki, when available through the shared connector registry",
      `- Claude native auto-memory roots: ${claudeAutoMemory}`,
      `- Codex native auto-memory: ${codexMemory}`,
      `- Codex summary: ${join(codexMemory, "memory_summary.md")}`,
      `- Claude can read Codex through ${join(claudeMemory, "CODEX_MEMORY_SUMMARY.md")} and ${join(claudeMemory, "CODEX_MEMORY_INDEX.md")}.`,
      `- Codex can read Claude through ${join(codexMemory, "CLAUDE_MEMORY_INDEX.md")}.`,
      `- Codex can read Claude repository auto memories through ${join(codexMemory, "CLAUDE_AUTO_MEMORIES")}.`,
      "",
      "Recall order:",
      "",
      "1. Read /Users/neam/.claude/shared-resources/RESOURCE.md and this bridge when memory is relevant.",
      `2. Check ${join(claudeMemory, "MEMORY.md")} for active routing facts, high-risk rules, and pointers.`,
      "3. For long project history, prior decisions, user or project patterns, and reusable knowledge, use the LLM-Wiki query flow first.",
      "   - Prefer the llm-wiki connector if the active provider exposes it.",
      "   - If the connector is not available, use standard file read/search tools from 30-wiki/index.md, then routed topic/index/alias pages, then targeted grep in 30-wiki.",
      "4. If LLM-Wiki does not answer, or session recovery requires provider-specific hints, search Claude native auto-memory and Codex native memory, then deduplicate by meaning.",
      "",
      "Write order:",
      "",
      `1. Explicit globally active durable facts go to ${claudeMemory} as one fact per file and one index line.`,
      "2. Long project knowledge, implementation history, transcript-derived facts, and result logs should enter LLM-Wiki as source material in 10-inbox, then be compiled into 30-wiki before becoming queryable.",
      "3. Claude repository learnings stay in Claude auto-memory. Codex automatic capture stays in Codex memories.",
      "4. Never overwrite, reformat, or merge one provider's native auto-memory into another store.",
      ""
    ].join("\n"),
    { mode: 0o644 }
  );

  const connectors = loadMergedConnectors();
  const registry = Object.fromEntries(
    Object.entries(connectors).map(([name, server]) => [name, registryServer(server)])
  );
  writeFileSync(paths.connectorRegistry, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600
  });
  chmodSync(paths.connectorRegistry, 0o600);

  syncCodexMcpConfig(
    connectors,
    paths.codexConfig,
    process.execPath,
    paths.wrapperScript,
    paths.connectorRegistry
  );
  syncAgyMcpConfig(
    connectors,
    paths.agyMcpConfig,
    process.execPath,
    paths.wrapperScript,
    paths.connectorRegistry
  );

  writeFileSync(
    paths.resourceGuide,
    [
      "# Shared AI Resources",
      "",
      "This is the common resource layer for Claude, Codex, and agy.",
      "",
      `- Global instructions: ${join(paths.home, ".claude", "CLAUDE.md")} and ${join(paths.home, ".codex", "AGENTS.md")}`,
      `- Claude memory: ${join(paths.home, ".claude", "memory")}`,
      `- Claude native auto memory: ${claudeAutoMemory}`,
      `- Codex native memory: ${join(paths.home, ".codex", "memories")}`,
      `- Memory bridge: ${paths.memoryBridge}`,
      `- Shared skill catalog: ${paths.skillCatalog}`,
      `- Shared connector registry: ${paths.connectorRegistry}`,
      "- Plugin capabilities: plugin-provided skills are included in the shared skill catalog; MCP-backed plugin tools are included in the shared connector registry.",
      "- Tools: use the same MCP connector names and the provider's native filesystem, shell, web, and editing tools under the active permission mode.",
      "",
      "Before acting, use the memory bridge when recall is relevant: active Claude memory index first, LLM-Wiki query flow next, and native auto-memory stores only as fallback or session-recovery hints. Prefer the llm-wiki connector when exposed; otherwise use standard file read/search tools. Search the shared skill catalog for task-specific workflows. Treat provider-native UI-only plugins as optional surfaces, not as a source of different behavior.",
      ""
    ].join("\n"),
    { mode: 0o644 }
  );

  return {
    skillCount: skills.length,
    connectorCount: Object.keys(connectors).length,
    providerSkillRoots: paths.providerSkillRoots.length
  };
}
