import { Bot } from "grammy";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildWorkflowSkillPrompt,
  WORKFLOW_SKILLS,
  workflowStateRoot
} from "../../workflow-skills.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { BotDeps } from "../deps.js";
import { pendingStartKey } from "../pending-keys.js";

export function registerWorkflowHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    sessions,
    pendingStarts,
    selectProjectForTask,
    startSessionFromOptions
  } = deps;

  for (const workflow of WORKFLOW_SKILLS) {
    bot.command(workflow.command, async (ctx) => {
      const topicId = ctx.message?.message_thread_id;
      const input = ctx.match.trim();
      const session = topicId
        ? store.getSessionByTopic(config.chatId, topicId)
        : undefined;
      if (!session) {
        const userId = ctx.from?.id;
        if (userId === undefined) {
          await ctx.reply("세션 토픽 안에서 사용하세요. /new로 작업 토픽을 먼저 여십시오.");
          return;
        }
        const pendingKey = pendingStartKey(userId, topicId);
        const pending = pendingStarts.get(pendingKey);
        if (!pending) {
          await ctx.reply("세션 토픽 안에서 사용하세요. /new로 작업 토픽을 먼저 여십시오.");
          return;
        }
        if (!input) {
          await ctx.reply(
            `사용법: ${workflow.usage}\n`
            + `이 명령은 현재 제공자에게 공용 ${workflow.label} 워크플로를 명시적으로 호출합니다.`
          );
          return;
        }

        // await 전에 pending 입력을 선점해 같은 토픽에서 동시에 들어온 명령이
        // 세션을 중복 생성하지 못하게 한다. 실패 시 실제 세션이 없을 때만 복구한다.
        pendingStarts.delete(pendingKey);
        let project;
        try {
          project = pending.kind === "project"
            ? pending.project
            : await selectProjectForTask(input, pending.selectionDefaults);
        } catch (error) {
          pendingStarts.set(pendingKey, pending);
          await ctx.reply(
            `프로젝트 자동 선택 실패: ${safeErrorMessage(error)}\n`
            + "이 작업 토픽은 유지되므로 지시를 수정해 다시 시도하실 수 있습니다."
          );
          return;
        }

        const startTopicId = pending.pendingTopicId ?? topicId;
        try {
          const created = await startSessionFromOptions(
            project,
            (newSession) => buildWorkflowSkillPrompt(
              workflow.name,
              input,
              newSession.id
            ),
            pending,
            startTopicId,
            input
          );
          await ctx.reply(
            `${workflow.label} 워크플로를 시작합니다.\n`
            + `상태 경로: ${workflowStateRoot(created.id, workflow.name)}`
          );
        } catch (error) {
          if (!startTopicId || !store.getSessionByTopic(config.chatId, startTopicId)) {
            pendingStarts.set(pendingKey, pending);
          }
          await ctx.reply(`세션 시작 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
        }
        return;
      }
      if (sessions.isActive(session.id)) {
        await ctx.reply("현재 세션이 작업 중입니다. 끝난 뒤 다시 시도하거나 /steer로 지시하세요.");
        return;
      }

      const stateRoot = workflowStateRoot(session.id, workflow.name);
      const hasSavedState = existsSync(resolve(session.cwd, stateRoot));
      if (!input && !hasSavedState) {
        await ctx.reply(
          `사용법: ${workflow.usage}\n`
          + `이 명령은 현재 제공자에게 공용 ${workflow.label} 워크플로를 명시적으로 호출합니다.`
        );
        return;
      }

      const request = input || "저장된 워크플로 상태를 읽고 중단 지점부터 재개하십시오.";
      const prompt = buildWorkflowSkillPrompt(workflow.name, request, session.id);
      if (!sessions.resume(session, prompt)) {
        await ctx.reply("워크플로를 시작하지 못했습니다. 세션 상태와 제공자 대화 문맥을 확인하세요.");
        return;
      }
      await ctx.reply(
        `${workflow.label} 워크플로를 시작합니다.\n`
        + `상태 경로: ${stateRoot}`
      );
    });
  }
}
