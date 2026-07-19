import type { Bot } from "grammy";
import type { BotDeps } from "../deps.js";
import { registerAdvisoryHandlers } from "./advisory.js";
import { registerConfigCommandHandlers } from "./config-commands.js";
import { registerLifecycleHandlers } from "./lifecycle.js";
import { registerMessageHandlers } from "./messages.js";
import { registerProjectSelectHandlers } from "./project-select.js";
import { registerRunControlHandlers } from "./run-control.js";
import { registerShotgunHandlers } from "./shotgun.js";
import { registerWorkflowHandlers } from "./workflows.js";

export function registerBotHandlers(bot: Bot, deps: BotDeps): void {
  registerLifecycleHandlers(bot, deps);
  registerRunControlHandlers(bot, deps);
  registerShotgunHandlers(bot, deps);
  registerConfigCommandHandlers(bot, deps);
  registerAdvisoryHandlers(bot, deps);
  registerWorkflowHandlers(bot, deps);
  registerProjectSelectHandlers(bot, deps);
  registerMessageHandlers(bot, deps);
}
