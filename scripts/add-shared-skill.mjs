#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

function usage(exitCode = 1) {
  const command = basename(process.argv[1] ?? "add-shared-skill.mjs");
  console.error(`Usage: ${command} <name-or-title> --description "<when to use this skill>"`);
  console.error("");
  console.error("Creates ~/.claude/skills/<skill-name>/SKILL.md and refreshes the shared catalog.");
  process.exit(exitCode);
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function parseArgs(argv) {
  const positional = [];
  let description = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--description" || arg === "-d") {
      description = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    positional.push(arg);
  }
  return { title: positional.join(" "), description: description.trim() };
}

const { title, description } = parseArgs(process.argv.slice(2));
const name = slugify(title);

if (!name || !description) usage();

const skillDir = join(homedir(), ".claude", "skills", name);
const skillFile = join(skillDir, "SKILL.md");

if (existsSync(skillFile)) {
  console.error(`Refusing to overwrite existing skill: ${skillFile}`);
  process.exit(1);
}

mkdirSync(skillDir, { recursive: true });
writeFileSync(
  skillFile,
  [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    "",
    `# ${title.trim()}`,
    "",
    "## Workflow",
    "",
    "- Read the user's request and confirm this skill applies before following these instructions.",
    "- Keep changes scoped to the requested task.",
    "- Validate the result with the smallest reliable check available.",
    "",
    "## Notes",
    "",
    "- Replace this scaffold with the concrete workflow, references, scripts, or assets this skill needs.",
    ""
  ].join("\n"),
  { mode: 0o644 }
);

const sync = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "-e",
    "import { syncSharedResources } from './src/resource-sync.ts'; const r = syncSharedResources(); console.log(`Shared resources synced: ${r.skillCount} skills, ${r.connectorCount} connectors.`);"
  ],
  { cwd: process.cwd(), stdio: "inherit" }
);

if (sync.status !== 0) {
  console.error(`Created ${skillFile}, but shared resource sync failed. Run npm run shared:sync after fixing the error.`);
  process.exit(sync.status ?? 1);
}

console.log(`Created shared skill: ${skillFile}`);
