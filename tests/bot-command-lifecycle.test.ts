import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BOT_COMMAND_LIFECYCLE,
  BOT_COMMANDS,
  type BotCommandLifecycle
} from "../src/bot-commands.js";
import { WORKFLOW_SKILLS } from "../src/workflow-skills.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function registeredHandlerCommands(): string[] {
  const handlersDir = join(projectRoot, "src", "bot", "handlers");
  const commands = new Set<string>();
  for (const filename of readdirSync(handlersDir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(join(handlersDir, filename), "utf8");
    for (const match of source.matchAll(/bot\.command\("([a-z0-9_]+)"/g)) {
      commands.add(match[1]!);
    }
  }
  for (const workflow of WORKFLOW_SKILLS) commands.add(workflow.command);
  return [...commands].sort();
}

describe("bot command lifecycle audit", () => {
  it("classifies every registered literal and dynamic workflow command exactly once", () => {
    expect(Object.keys(BOT_COMMAND_LIFECYCLE).sort()).toEqual(registeredHandlerCommands());
  });

  it("classifies every public Bot API command", () => {
    const classified = new Set(Object.keys(BOT_COMMAND_LIFECYCLE));
    expect(BOT_COMMANDS.map(({ command }) => command).filter((command) => !classified.has(command))).toEqual([]);
  });

  it("uses only the four approved lifecycle classes and start-capable commands", () => {
    const classes = new Set<BotCommandLifecycle>([
      "session-independent",
      "pending-modifier",
      "start-capable",
      "existing-session-required"
    ]);
    expect(Object.values(BOT_COMMAND_LIFECYCLE).every((value) => classes.has(value))).toBe(true);
    expect(Object.entries(BOT_COMMAND_LIFECYCLE)
      .filter(([, lifecycle]) => lifecycle === "start-capable")
      .map(([command]) => command)
      .sort()).toEqual(["deepinterview", "goal", "ralplan", "ultragoal"]);
  });
});
