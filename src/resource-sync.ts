import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  loadMergedConnectors,
  PROVIDER_NATIVE_MCP_SERVER_NAMES,
  syncAgyMcpConfig,
  syncClineMcpConfig,
  syncCodexMcpConfig
} from "./connectors.js";
import { projectSourceDir } from "./runtime-paths.js";
import { wikiVaultCandidates } from "./wiki-paths.js";

export interface SharedResourcePaths {
  home: string;
  sharedRoot: string;
  connectorRegistry: string;
  skillCatalog: string;
  resourceGuide: string;
  memoryBridge: string;
  routerSkill: string;
  codexConfig: string;
  codexAccountConfigs: string[];
  agyMcpConfig: string;
  grokConfigPath: string;
  clineMcpConfig: string;
  wrapperScript: string;
  skillRoots: string[];
  providerSkillRoots: string[];
}

export interface SharedResourceSummary {
  skillCount: number;
  connectorCount: number;
  providerSkillRoots: number;
}

const DEFAULT_SHARED_RESOURCE_SYNC_TTL_MS = 5 * 60 * 1000;
let sharedResourceSyncCache: {
  key: string;
  expiresAt: number;
  summary: SharedResourceSummary;
} | null = null;

function sharedResourceCacheKey(overrides: Partial<SharedResourcePaths>): string {
  return JSON.stringify(
    Object.entries(overrides)
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export function syncSharedResourcesCached(
  overrides: Partial<SharedResourcePaths> = {},
  options: { ttlMs?: number; now?: number; } = {}
): SharedResourceSummary {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_SHARED_RESOURCE_SYNC_TTL_MS;
  const key = sharedResourceCacheKey(overrides);
  if (
    ttlMs > 0
    && sharedResourceSyncCache?.key === key
    && sharedResourceSyncCache.expiresAt > now
  ) {
    return sharedResourceSyncCache.summary;
  }
  const summary = syncSharedResources(overrides);
  sharedResourceSyncCache = {
    key,
    expiresAt: now + Math.max(0, ttlMs),
    summary
  };
  return summary;
}

export function clearSharedResourceSyncCache(): void {
  sharedResourceSyncCache = null;
}

function defaultPaths(): SharedResourcePaths {
  const home = homedir();
  const sharedRoot = join(home, ".claude", "shared-resources");
  const codexConfig = join(home, ".codex", "config.toml");
  const primaryCodexSkills = join(home, ".codex", "skills");
  const grokSkills = join(home, ".grok", "skills");
  const clineSkills = join(home, ".cline", "skills");
  const agentsSkills = join(home, ".agents", "skills");
  const projectRoot = projectSourceDir();
  const projectClineSkillRoots = [
    join(projectRoot, ".clinerules", "skills"),
    join(projectRoot, ".cline", "skills"),
    join(projectRoot, ".agents", "skills")
  ];
  const codexAccountHomes = defaultCodexAccountHomes(home);
  const codexAccountSkillRoots = codexAccountHomes
    .map((codexHome) => join(codexHome, "skills"))
    .filter((path) => path !== primaryCodexSkills);
  return {
    home,
    sharedRoot,
    connectorRegistry: join(sharedRoot, "connectors.json"),
    skillCatalog: join(sharedRoot, "SKILLS.md"),
    resourceGuide: join(sharedRoot, "RESOURCE.md"),
    memoryBridge: join(sharedRoot, "MEMORY-BRIDGE.md"),
    routerSkill: join(sharedRoot, "shared-skill-router"),
    codexConfig,
    codexAccountConfigs: defaultCodexAccountConfigs(codexAccountHomes, codexConfig),
    agyMcpConfig: join(home, ".gemini", "config", "mcp_config.json"),
    grokConfigPath: join(home, ".grok", "config.toml"),
    clineMcpConfig: join(home, ".cline", "data", "settings", "cline_mcp_settings.json"),
    wrapperScript: resolve(projectSourceDir(), "scripts", "run-shared-mcp.mjs"),
    skillRoots: [
      join(projectRoot, "skills"),
      ...projectClineSkillRoots,
      join(home, ".claude", "skills"),
      primaryCodexSkills,
      ...codexAccountSkillRoots,
      join(home, ".codex", "plugins", "cache"),
      join(home, ".gemini", "config", "skills"),
      join(home, ".gemini", "antigravity-cli", "builtin", "skills"),
      grokSkills,
      clineSkills,
      agentsSkills
    ],
    // Grok과 Cline도 Claude·Codex·agy와 같은 라우터 스킬을 받아 공유 카탈로그를 검색·소비한다.
    // Cline SDK는 전역 ~/.agents/skills와 프로젝트 .agents/skills를 모두 native 탐색한다.
    providerSkillRoots: [
      join(home, ".claude", "skills"),
      primaryCodexSkills,
      ...codexAccountSkillRoots,
      join(home, ".gemini", "config", "skills"),
      grokSkills,
      agentsSkills,
      join(projectRoot, ".agents", "skills")
    ]
  };
}

export function defaultCodexAccountHomes(home: string): string[] {
  const homes = [
    process.env.CODEX_HOME,
    ...(process.env.CODEX_ACCOUNT_HOMES ?? "").split(",")
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(homes.map((value) => {
    const expanded = value === "~"
      ? home
      : value.startsWith("~/")
        ? join(home, value.slice(2))
        : value;
    return resolve(expanded);
  }))]
    .filter((path) => path !== join(home, ".codex"));
}

function defaultCodexAccountConfigs(
  codexAccountHomes: string[],
  primaryCodexConfig: string
): string[] {
  const configs = codexAccountHomes.map((value) => join(value, "config.toml"));
  return [...new Set(configs)].filter((path) => path !== primaryCodexConfig);
}

function ensureSymlink(target: string, linkPath: string): void {
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const current = lstatSync(linkPath);
    if (current.isSymbolicLink()) {
      const currentTarget = readlinkSync(linkPath);
      const resolvedCurrentTarget = resolve(dirname(linkPath), currentTarget);
      if (resolvedCurrentTarget === resolve(target)) return;
    }
    rmSync(linkPath, { recursive: current.isDirectory(), force: true });
  } catch {
    // Missing or broken link.
  }
  symlinkSync(target, linkPath);
}

/** 서로 다른 사용자 파일은 보존하고, 없거나 동일한 provider 사본만 canonical 링크로 만든다. */
function ensureInstructionSymlink(target: string, linkPath: string): void {
  if (!existsSync(target) || resolve(target) === resolve(linkPath)) return;
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    const current = lstatSync(linkPath);
    if (current.isSymbolicLink()) {
      const resolvedCurrentTarget = resolve(dirname(linkPath), readlinkSync(linkPath));
      if (resolvedCurrentTarget === resolve(target)) return;
      rmSync(linkPath, { force: true });
    } else {
      // 독자적인 provider 지침은 덮어쓰지 않는다. canonical과 같은 사본만 심링크로 축약한다.
      if (current.isDirectory() || readFileSync(linkPath, "utf8") !== readFileSync(target, "utf8")) {
        return;
      }
      rmSync(linkPath, { force: true });
    }
  } catch {
    // Missing or broken link.
    rmSync(linkPath, { force: true });
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
  const front = text.slice(0, 4000);
  const lineMatch = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front);
  if (!lineMatch) return null;
  const inline = (lineMatch[1] ?? "").trim();
  // YAML 블록 스칼라(folded `>` 또는 literal `|`, chomping/indent 지시자 허용). grok 스킬은
  // description을 `>`로 여러 줄에 걸쳐 쓰므로, 뒤따르는 들여쓰기 줄을 접어 한 줄 설명으로 만든다.
  // 이렇게 하지 않으면 공유 카탈로그에 설명이 `>`로만 남아 다른 에이전트가 스킬 용도를 못 읽는다.
  if (/^[|>][+-]?\d*$/.test(inline)) {
    const rest = front.slice(lineMatch.index + lineMatch[0].length).split("\n");
    const collected: string[] = [];
    for (const line of rest) {
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) break; // 들여쓰기 해제 → 블록 종료
      collected.push(line.trim());
    }
    const folded = collected.join(" ").replace(/\s+/g, " ").trim();
    return folded || null;
  }
  const unquoted = inline.replace(/^["']|["']$/g, "").trim();
  return unquoted || null;
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

// life-science-research 플러그인 스킬 중 이미 붙은 MCP 서버와 기능이 직접 겹치는 것들은 공유
// 카탈로그에서 제외한다(정책: "MCP와 중복된 것만 제거"). 플러그인 구성원이라 파일
// 삭제는 캐시 루트 스캔으로 원복되므로, 카탈로그 빌더 단계에서 제외하는 것이 정확·가역적이다.
// 스킬은 설치된 채 남고, 5-provider 공유 카탈로그에서만 빠진다. 되돌리려면 이 집합만 비우면 된다.
// 우측은 대응 MCP 서버.
export const MCP_REDUNDANT_SKILLS = new Set<string>([
  "chembl-skill", // chembl
  "biorxiv-skill", // biorxiv
  "clinicaltrials-skill", // c-trials / biocontext-kb studies
  "opentargets-skill", // open-targets(ot) / biocontext-kb
  "clinvar-variation-skill", // biomcp
  "gnomad-graphql-skill", // biomcp
  "gwas-catalog-skill", // biomcp / biocontext-kb
  "ncbi-entrez-skill", // pubmed / biomcp
  "ncbi-pmc-skill", // pubmed / biocontext-kb europepmc
  "reactome-skill", // biocontext-kb
  "string-skill", // biocontext-kb
  "uniprot-skill", // biocontext-kb
  "human-protein-atlas-skill", // biocontext-kb
  "alphafold-skill", // biocontext-kb
  "chebi-skill", // biocontext-kb
  "ensembl-skill", // biocontext-kb
  "efo-ontology-skill", // biocontext-kb
  "pride-skill" // biocontext-kb
]);

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
    if (MCP_REDUNDANT_SKILLS.has(name)) continue;
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

function selectedAgyMcpConnectors(
  connectors: Record<string, McpServerConfig>,
  rawNames = process.env.AGY_MCP_SERVERS
    ?? "llm-wiki,obsidian,outlook,peekaboo,playwright,price-feed,literature-evidence,scihub"
): Record<string, McpServerConfig> {
  const names = new Set(
    rawNames.split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  if (names.size === 0) return {};
  return Object.fromEntries(
    Object.entries(connectors).filter(([name]) => names.has(name))
  );
}

// Grok는 매 턴 CLI를 새로 띄우므로 MCP 서버가 많으면 기동 비용이 커진다. 메모리 정책을
// 따르는 최소 집합에 Gmail/Outlook, 공용 Peekaboo 데스크톱 제어, Playwright 브라우저를 더한다.
// 메일 커넥터를 빼면 Grok가 도구 호출을 계획한 뒤 실행할 서버가 없어 해당 요청을 끝내지 못한다.
function selectedGrokMcpConnectors(
  connectors: Record<string, McpServerConfig>,
  rawNames = process.env.GROK_MCP_SERVERS
    ?? "llm-wiki,obsidian,gmail,outlook,peekaboo,playwright,price-feed,literature-evidence,scihub"
): Record<string, McpServerConfig> {
  const names = new Set(
    rawNames.split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  if (names.size === 0) return {};
  return Object.fromEntries(
    Object.entries(connectors).filter(([name]) => names.has(name))
  );
}

// Cline은 내부 제공자를 그대로 노출하므로 게이트웨이가 요구하는 JSON Schema 방언이
// 제공자마다 다르다. Moonshot(Kimi)은 `#/$defs/`로 시작하는 $ref만 허용하는데
// 도구가 하나라도 어기면 요청 전체가 400으로 거부된다. 확인된 위반 서버:
//   apple-mail          search-messages → "#/properties/dateFrom" (2.3.0~2.8.11 동일)
//   (2026-07-22부터 interactive-brokers는 TWS socket 기반 ibkr-mcp로 교체되어
//    인라인 JSON Schema만 제공하므로 이 호환성 제외 목록에서 해제했다.)
// HTTP 커넥터 등 미검증 서버가 남아 있어 이 목록이 완전하다는 보장은 없다. 새 위반이
// 보이면 여기 추가하거나 CLINE_MCP_EXCLUDED_SERVERS로 우회한다.
export const CLINE_INCOMPATIBLE_MCP_SERVERS = "apple-mail";

export function selectedClineMcpConnectors(
  connectors: Record<string, McpServerConfig>,
  rawExcluded = process.env.CLINE_MCP_EXCLUDED_SERVERS ?? CLINE_INCOMPATIBLE_MCP_SERVERS
): Record<string, McpServerConfig> {
  const excluded = new Set(
    rawExcluded.split(",")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  if (excluded.size === 0) return connectors;
  return Object.fromEntries(
    Object.entries(connectors).filter(([name]) => !excluded.has(name))
  );
}

/** TTL 만료 뒤에도 생성 내용이 같으면 디스크를 다시 쓰지 않는다. */
function writeTextIfChanged(path: string, content: string, mode: number): void {
  try {
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, mode);
      return;
    }
  } catch {
    // Missing or unreadable files are replaced with the generated canonical text.
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

function writeRouterSkill(paths: SharedResourcePaths): void {
  mkdirSync(paths.routerSkill, { recursive: true });
  writeTextIfChanged(
    join(paths.routerSkill, "SKILL.md"),
    [
      "---",
      "name: shared-skill-router",
      "description: Search the shared cross-provider skill catalog only when the task appears to need a dedicated skill.",
      "---",
      "",
      "# Shared Skill Router",
      "",
      `Search ${paths.skillCatalog} only when the task appears to need a dedicated skill.`,
      "If a matching skill is selected, read its SKILL.md completely and follow it. The catalog is the common source for Claude, Codex, agy, Grok, and Cline.",
      ""
    ].join("\n"),
    0o644
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

export function sharedPolicyGuidePath(home = homedir()): string {
  return join(home, ".claude", "shared-resources", "POLICIES.md");
}

export function sharedCodexLiteAgentPath(home = homedir()): string {
  return join(home, ".claude", "shared-resources", "codex-agents", "lite.toml");
}

interface SharedMemoryTextPaths {
  claudeMemory: string;
  claudeAutoMemory: string;
  codexMemory: string;
  llmWikiRoot: string;
  llmWikiRouter: string;
  llmWikiInbox: string;
  memoryBridge: string;
  policyGuide: string;
  skillCatalog: string;
  connectorRegistry: string;
}

/**
 * 매 턴에 넣기에는 긴 전역·ChatKJB 계약의 정본이다. provider bootstrap에는 핵심 불변조건과
 * 이 파일의 경로만 남기고, 세부 수명주기나 특수 작업이 실제로 필요할 때만 이 문서를 읽는다.
 */
export function buildSharedPolicyText(paths: SharedMemoryTextPaths & { home: string; }): string {
  return [
    "# Global and ChatKJB Detailed Policies",
    "",
    "> Lazy reference: the short global instructions and ChatKJB bootstrap carry the always-on rules. Read only the relevant section below when its trigger applies.",
    "",
    "## Execution And Subagents",
    "",
    "- Execute ordinary tool calls sequentially and use each result before the next call.",
    "- The root session owns judgment, risk checks, work decomposition, coordination, result integration, integrated verification, and final reporting.",
    "- When actual implementation, research, or testing has genuinely independent, bounded subtasks, proactively delegate them to subagents. Simple questions and single actions remain with the root session.",
    "- External MCP and connector calls remain with the root session; subagents return evidence for the root to integrate.",
    "- Never have more than 4 active subagents. If 4 are active, wait for or close one before spawning another.",
    "- This is a concurrency limit, not a cumulative per-command or per-turn spawn limit. Close completed, failed, or interrupted subagents to release their slots, then continue spawning new subagents in the same command or turn when useful work remains.",
    "- The main agent does not count toward the four-subagent concurrency limit. If a skill or provider workflow requests five or more subagents, execute them in waves of at most four.",
    "- On Codex, a completed `wait_agent` does not release a slot by itself; collect the result and call `close_agent` before reusing it when that tool is available.",
    "- Prefer parallel subagents for exploration, review, testing, log analysis, and other read-heavy work. Parallel write work is allowed only when file ownership is clearly separated; otherwise serialize the edits to avoid conflicts.",
    "- Subagents must not recursively fan out. The main agent remains responsible for waiting for results, reconciling conflicts, validating the combined result, and reporting the final outcome.",
    "",
    "## Global And Native Memory",
    "",
    `The canonical recall and write order is ${paths.memoryBridge}. Follow it whenever its mandatory recall trigger applies.`,
    "",
    "For explicit globally active memory writes:",
    "",
    `- Store one durable fact per file under ${join(paths.home, ".claude", "memory")} and keep one index line per fact in MEMORY.md.`,
    "- Before saving, check whether an existing file already covers the same meaning; update it instead of duplicating it, and remove facts later proven wrong.",
    "- Use frontmatter with `name`, one-line `description`, and `metadata.type` set to `user`, `feedback`, `project`, or `reference`.",
    "- Do not store transient state, finished step-by-step detail, guesses, secrets, or credentials.",
    "- Keep provider-native automatic memory in its native format. Do not overwrite, reformat, or merge one provider's native store into another.",
    "- After an explicit memory write, report the changed files and the key content saved.",
    "",
    "## Obsidian Vault Access",
    "",
    "- Use the shared Obsidian MCP connector when it is available and suited to the task.",
    "- Direct filesystem access to Obsidian vault Markdown files is acceptable when the connector is unavailable or plain file operations are simpler.",
    "- Preserve Obsidian Markdown syntax, YAML frontmatter, wikilinks, embeds, and the existing vault structure.",
    "",
    "## ChatKJB Presentation Decks",
    "",
    `For any ChatKJB PowerPoint, PPTX, Google Slides, slide-deck creation, editing, conversion, redesign, or review task, first read ${join(paths.home, ".claude", "skills", "chatkjb-presentation-format", "SKILL.md")} and consult ${paths.skillCatalog}.`,
    "Do not create or judge ChatKJB presentation design without that skill unless the user explicitly requests a different non-ChatKJB style.",
    "When editing an existing deck, modify only the slides explicitly requested. Preserve every other slide's content, layout, images, notes, metadata, order, and formatting, and create a backup or otherwise ensure untouched slides can be restored before saving.",
    "",
    "## Per-conversation Result Log",
    "",
    "Only the primary agent appends the per-conversation result log; subagents must never create, append, rewrite, or delete a `.result.md` file.",
    "After every conversation, the primary agent appends exactly one self-contained block to `.result.md` in each project folder. This applies to read-only, advisory, aborted, and trivial conversations too. Create the file if absent. The only acceptable omission is a genuine inability to write to the project folder, which must be reported explicitly.",
    "Use this machine-readable, Asia/Seoul timestamped form exactly:",
    "",
    "```markdown",
    "## YYYY-MM-DDTHH:mm:ss+09:00",
    "- Request: …",
    "- Decision: …",
    "- Result: …",
    "```",
    "",
    "Keep every conversation within one new `##` block; do not append text outside that block or rewrite existing blocks. The timestamp is the retention key: the scheduled cleanup retains the newest 7 days of valid blocks and deletes older valid blocks only after the result-log dump has completed. Do not delete malformed or legacy content manually unless the user explicitly requests its removal.",
    "",
    "## ChatKJB Orchestration And Delegation",
    "",
    "- ChatKJB is the upper coordinator. A provider must not change provider, model, session, goal, or memory settings, nor switch into an independent native-app session.",
    "- Treat the current turn prompt, explicit session state, and directly inspected repository state as scope. Do not revive invisible prior work as a new request.",
    "- Do not make out-of-scope file changes, external transfers, or permission expansions. Ask through the ChatKJB conversation when authority is required.",
    "- Progress and results are reported through the ChatKJB conversation.",
    "- Delegation inside the current turn is normal orchestration, not a new independent task. Use the provider-native mechanism: Claude Task/Agent, Codex collaboration tools, Antigravity background subagents, or Grok subagents.",
    "- Prefer provider-exposed default agents and user- or project-defined specialist agents for bounded implementation, research, and testing. Keep the same four-active-subagent limit, depth-one/no-recursive-fan-out rule, read-heavy parallel preference, separated write ownership, root-owned external MCP calls, and root integration responsibility defined above.",
    ""
  ].join("\n");
}

/** 루트의 도구 기능은 유지하면서 읽기/검증 subagent의 MCP 프로세스 곱셈만 막는 role layer다. */
export function buildCodexLiteAgentText(
  connectors: Record<string, Record<string, unknown>>
): string {
  const lines = [
    'description = "Lightweight ChatKJB child for repository exploration, review, and verification without external MCP startup."',
    'developer_instructions = "Work only on the delegated bounded subtask. Use native filesystem and shell tools, do not spawn subagents, and return evidence to the parent. External MCP work stays with the parent agent."',
    ""
  ];
  for (const [name, server] of Object.entries(connectors).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`[mcp_servers.${JSON.stringify(name)}]`);
    if (server.type === "http" || server.type === "sse") {
      lines.push(`url = ${JSON.stringify(String(server.url))}`);
      if (server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)) {
        const headers = Object.entries(server.headers as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
          .join(", ");
        if (headers) lines.push(`http_headers = { ${headers} }`);
      }
    } else {
      lines.push(`command = ${JSON.stringify(String(server.command))}`);
      const args = Array.isArray(server.args)
        ? server.args.filter((value): value is string => typeof value === "string")
        : [];
      lines.push(`args = [${args.map((value) => JSON.stringify(value)).join(", ")}]`);
    }
    lines.push("enabled = false", "startup_timeout_sec = 120", "");
    if (
      server.type !== "http"
      && server.type !== "sse"
      && server.env
      && typeof server.env === "object"
      && !Array.isArray(server.env)
    ) {
      lines.push(`[mcp_servers.${JSON.stringify(name)}.env]`);
      for (const [key, value] of Object.entries(server.env as Record<string, unknown>)) {
        if (typeof value === "string") lines.push(`${JSON.stringify(key)} = ${JSON.stringify(value)}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function buildSharedMemoryBridgeText(paths: SharedMemoryTextPaths): string {
  return [
    "# Cross-provider Memory Bridge",
    "",
    "Claude, Codex, agy, Grok, and Cline share this recall route. Provider-native memory systems remain enabled and keep their own formats.",
    "",
    `- Claude canonical facts: ${paths.claudeMemory}`,
    `- Claude index: ${join(paths.claudeMemory, "MEMORY.md")}`,
    `- LLM-Wiki root: ${paths.llmWikiRoot}`,
    `- LLM-Wiki router: ${paths.llmWikiRouter}`,
    `- LLM-Wiki inbox: ${paths.llmWikiInbox}`,
    "- LLM-Wiki connector: llm-wiki, when available through the shared connector registry",
    `- Claude native auto-memory roots: ${paths.claudeAutoMemory}`,
    `- Codex native auto-memory: ${paths.codexMemory}`,
    `- Codex summary: ${join(paths.codexMemory, "memory_summary.md")}`,
    `- Claude can read Codex through ${join(paths.claudeMemory, "CODEX_MEMORY_SUMMARY.md")} and ${join(paths.claudeMemory, "CODEX_MEMORY_INDEX.md")}.`,
    `- Codex can read Claude through ${join(paths.codexMemory, "CLAUDE_MEMORY_INDEX.md")}.`,
    `- Codex can read Claude repository auto memories through ${join(paths.codexMemory, "CLAUDE_AUTO_MEMORIES")}.`,
    "",
    "Recall policy:",
    "",
    "Memory recall is mandatory, not optional, whenever a task mentions past context, prior decisions, user or project preferences, repository history, durable knowledge, /query, /memory, LLM-Wiki, or anything that could reasonably depend on earlier work.",
    "Do not answer such tasks from the current chat alone until the query-first recall path below has been attempted and duplicate facts have been reconciled by meaning.",
    "",
    "Recall order:",
    "",
    `1. Read ${join(dirname(paths.memoryBridge), "RESOURCE.md")} and this bridge when memory is relevant under the mandatory policy above.`,
    `2. Check ${join(paths.claudeMemory, "MEMORY.md")} for active routing facts, high-risk rules, and pointers.`,
    "3. For long project history, prior decisions, user or project patterns, and reusable knowledge, use the LLM-Wiki query flow first.",
    "   - /query requests must use this LLM-Wiki flow; do not satisfy /query only from native auto-memory or the visible chat.",
    "   - Prefer the llm-wiki connector if the active provider exposes it.",
    "   - If the connector is not available, use standard file read/search tools from 30-wiki/index.md, then routed topic/index/alias pages, then targeted grep in 30-wiki.",
    "   - If the fact is absent, say `위키에 없음 — /compile 또는 /ingest 필요`; do not invent it or substitute uncompiled inbox material as canon.",
    "4. If LLM-Wiki does not answer, or session recovery requires provider-specific hints, search Claude native auto-memory and Codex native memory, then deduplicate by meaning.",
    "5. If live recall is skipped despite possible relevance, explicitly state that the answer is not memory-verified and may be stale.",
    "",
    "Write order:",
    "",
    `1. Explicit globally active durable facts go to ${paths.claudeMemory} as one fact per file and one index line.`,
    "2. Long project knowledge, implementation history, transcript-derived facts, and result logs should enter LLM-Wiki as source material in 10-inbox, then be compiled into 30-wiki before becoming queryable.",
    "3. Claude repository learnings stay in Claude auto-memory. Codex automatic capture stays in Codex memories.",
    "4. Never overwrite, reformat, or merge one provider's native auto-memory into another store.",
    `5. Detailed globally active memory file schema and exclusions are in ${paths.policyGuide}#global-and-native-memory.`,
    ""
  ].join("\n");
}

export function buildSharedResourceGuideText(paths: SharedMemoryTextPaths & { home: string; }): string {
  return [
    "# Shared AI Resources",
    "",
    "This is the common lazy-loaded resource layer for Claude, Codex, agy, Grok, and Cline.",
    "",
    `- Global instructions: ${join(paths.home, ".claude", "CLAUDE.md")} and ${join(paths.home, ".codex", "AGENTS.md")}`,
    `- Claude memory: ${join(paths.home, ".claude", "memory")}`,
    `- Claude native auto memory: ${paths.claudeAutoMemory}`,
    `- Codex native memory: ${join(paths.home, ".codex", "memories")}`,
    `- Memory bridge: ${paths.memoryBridge}`,
    `- Detailed global and ChatKJB policies: ${paths.policyGuide}`,
    `- Shared skill catalog: ${paths.skillCatalog}`,
    `- Shared connector registry: ${paths.connectorRegistry}`,
    "- Plugin capabilities: plugin-provided skills are included in the shared skill catalog; MCP-backed plugin tools are included in the shared connector registry.",
    "- Tools: use the same MCP connector names and the provider's native filesystem, shell, web, and editing tools under the active permission mode.",
    "",
    "Load lazily: use the memory bridge whenever its mandatory recall trigger applies; read only the relevant POLICIES.md section for detailed lifecycle or special-workflow rules; search the skill catalog only when the task needs a dedicated skill; invoke only task-relevant connectors. For /query and long-memory work, run active Claude memory index lookup first, then the LLM-Wiki query flow, then native auto-memory fallback only if needed. Prefer the llm-wiki connector when exposed; otherwise use standard file read/search tools. Treat provider-native UI-only plugins as optional surfaces, not as a source of different behavior.",
    ""
  ].join("\n");
}

export function syncSharedResources(
  overrides: Partial<SharedResourcePaths> = {}
): SharedResourceSummary {
  const paths = { ...defaultPaths(), ...overrides };
  if (!overrides.clineMcpConfig) {
    paths.clineMcpConfig = join(
      paths.home,
      ".cline",
      "data",
      "settings",
      "cline_mcp_settings.json"
    );
  }
  mkdirSync(paths.sharedRoot, { recursive: true });

  // 전역 지침은 한 파일만 정본으로 두고 다섯 provider의 native discovery 위치는 심링크로
  // 연결한다. ChatKJB bootstrap에서 전문을 다시 복사하지 않아도 각 harness가 직접 읽는다.
  const globalInstructions = join(paths.home, ".claude", "CLAUDE.md");
  const projectRoot = resolve(dirname(paths.wrapperScript), "..");
  const providerInstructionLinks = [
    join(paths.home, ".codex", "AGENTS.md"),
    ...(paths.codexAccountConfigs ?? []).map((config) => join(dirname(config), "AGENTS.md")),
    join(paths.home, ".gemini", "config", "AGENTS.md"),
    join(paths.home, ".grok", "Agents.md"),
    // Cline SDK 0.0.65의 native rules discovery 출력.
    join(paths.home, ".agents", "AGENTS.md"),
    join(projectRoot, "AGENTS.md")
  ];
  for (const linkPath of [...new Set(providerInstructionLinks)]) {
    ensureInstructionSymlink(globalInstructions, linkPath);
  }

  const skills = buildSharedSkillCatalog(paths.skillRoots);
  writeTextIfChanged(
    paths.skillCatalog,
    [
      "# Shared Skill Catalog",
      "",
      "Claude, Codex, agy, Grok, and Cline use this same catalog. Search by task keyword, then read only the selected SKILL.md.",
      "",
      ...skills.map((skill) =>
        `- \`${skill.id}\` — ${skill.description || skill.name} — \`${skill.path}\``
      ),
      ""
    ].join("\n"),
    0o644
  );
  writeRouterSkill(paths);

  const claudeMemory = join(paths.home, ".claude", "memory");
  const claudeAutoMemory = join(paths.home, ".claude", "projects");
  const codexMemory = join(paths.home, ".codex", "memories");
  const llmWikiRoot = defaultLlmWikiRoot(paths.home);
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

  const memoryTextPaths = {
    claudeMemory,
    claudeAutoMemory,
    codexMemory,
    llmWikiRoot,
    llmWikiRouter,
    llmWikiInbox,
    memoryBridge: paths.memoryBridge,
    policyGuide: join(paths.sharedRoot, "POLICIES.md"),
    skillCatalog: paths.skillCatalog,
    connectorRegistry: paths.connectorRegistry
  };
  writeTextIfChanged(
    memoryTextPaths.policyGuide,
    buildSharedPolicyText({ ...memoryTextPaths, home: paths.home }),
    0o644
  );
  writeTextIfChanged(
    paths.memoryBridge,
    buildSharedMemoryBridgeText(memoryTextPaths),
    0o644
  );

  const connectors = loadMergedConnectors({
    claudeJsonPath: join(paths.home, ".claude.json"),
    codexConfigPath: paths.codexConfig,
    pluginCachePath: join(paths.home, ".codex", "plugins", "cache")
  });
  const registry = Object.fromEntries(
    Object.entries(connectors).map(([name, server]) => [name, registryServer(server)])
  );
  const liteAgentPath = join(paths.sharedRoot, "codex-agents", "lite.toml");
  writeTextIfChanged(liteAgentPath, buildCodexLiteAgentText(registry), 0o600);
  writeTextIfChanged(
    paths.connectorRegistry,
    `${JSON.stringify(registry, null, 2)}\n`,
    0o600
  );

  const codexConfigTargets = [
    paths.codexConfig,
    ...(paths.codexAccountConfigs ?? [])
  ];
  for (const codexConfigPath of [...new Set(codexConfigTargets)]) {
    syncCodexMcpConfig(
      connectors,
      codexConfigPath,
      process.execPath,
      paths.wrapperScript,
      paths.connectorRegistry,
      ["--single-owner-per-parent"]
    );
  }
  syncAgyMcpConfig(
    selectedAgyMcpConnectors(connectors),
    paths.agyMcpConfig,
    process.execPath,
    paths.wrapperScript,
    paths.connectorRegistry,
    new Set([...Object.keys(connectors), ...PROVIDER_NATIVE_MCP_SERVER_NAMES])
  );

  // grok ~/.grok/config.toml의 [mcp_servers.*] 스키마는 codex config.toml과 동일하므로
  // 같은 writer를 재사용한다(관리 블록만 덮어쓰고 [cli]·[marketplace] 등은 보존).
  // 이로써 grok도 메모리 정책이 선호하는 llm-wiki 커넥터를 직접 쓸 수 있다.
  syncCodexMcpConfig(
    selectedGrokMcpConnectors(connectors),
    paths.grokConfigPath,
    process.execPath,
    paths.wrapperScript,
    paths.connectorRegistry
  );
  syncClineMcpConfig(
    selectedClineMcpConnectors(connectors),
    paths.clineMcpConfig,
    process.execPath,
    paths.wrapperScript,
    paths.connectorRegistry
  );

  writeTextIfChanged(
    paths.resourceGuide,
    buildSharedResourceGuideText({ ...memoryTextPaths, home: paths.home }),
    0o644
  );

  return {
    skillCount: skills.length,
    connectorCount: Object.keys(connectors).length,
    providerSkillRoots: paths.providerSkillRoots.length
  };
}

function defaultLlmWikiRoot(home: string): string {
  const configured = process.env.LLM_WIKI_ROOT || process.env.WIKI_VAULT;
  if (configured) return configured;
  const candidates = [
    ...wikiVaultCandidates(home),
    resolve(dirname(projectSourceDir()), "LLM-Wiki"),
    join(home, "LLM-Wiki"),
    join(home, "Documents", "LLM-Wiki")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
