import { Bot } from "grammy";
import { buildShotgunPrompt } from "../../session-prompts.js";
import type { BotDeps } from "../deps.js";
import { providerDisplayLabel } from "../formatting.js";

/**
 * Claude Code 전용 shotgun 플러그인의 사과·재검토 흐름을 ChatKJB 세션에 맞게
 * 제공자 중립으로 전달한다. 마이크 캡처·키보드 자동 입력은 시작하지 않는다.
 */
export function registerShotgunHandlers(bot: Bot, deps: BotDeps): void {
  const { config, store, sessions } = deps;

  bot.command("shotgun", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    const arg = ctx.match.trim();
    if (!session) {
      await ctx.reply(
        "세션 토픽 안에서 사용하세요. `/shotgun`은 현재 Claude·Codex·Antigravity·Grok 작업을 사과 후 재검토·수정하도록 지시합니다."
      );
      return;
    }
    if (arg.toLowerCase() === "help") {
      await ctx.reply(
        "사용법: `/shotgun [누락·오류 설명]`\n"
        + "현재 제공자가 먼저 사과하고, 원래 요청과 실제 결과의 차이를 재검토한 뒤 수정·검증합니다. "
        + "마이크 감지나 창 자동 입력은 실행하지 않습니다."
      );
      return;
    }

    const prompt = buildShotgunPrompt(arg);
    if (sessions.isActive(session.id)) {
      const steered = sessions.steer(session.id, prompt);
      if (!steered) {
        await ctx.reply("현재 작업에 재검토 지시를 전달하지 못했습니다. 작업 상태를 확인하세요.");
        return;
      }
      await ctx.reply(
        steered === "restarted"
          ? "Shotgun 재검토를 우선 적용합니다. 현재 Codex 턴을 중단하고 사과·재검토부터 다시 시작합니다."
          : `Shotgun 재검토를 ${providerDisplayLabel(session.provider)} 작업에 우선 전달했습니다.`
      );
      return;
    }

    if (!sessions.resume(session, prompt)) {
      await ctx.reply("재검토할 제공자 문맥이 없습니다. 일반 메시지로 작업을 먼저 시작한 뒤 다시 사용하세요.");
      return;
    }
    await ctx.reply(`Shotgun 재검토를 시작했습니다. ${providerDisplayLabel(session.provider)}가 사과·재검토·수정 순서로 응답합니다.`);
  });
}
