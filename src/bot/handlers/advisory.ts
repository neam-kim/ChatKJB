import { Bot } from "grammy";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  modelLabel
} from "../../model-catalog.js";
import { agentStrengthsPath, loadStrengthHints, routeProvider, wikiVaultPath } from "../../router.js";
import { projectSourceDir } from "../../runtime-paths.js";
import { safeErrorMessage } from "../../telegram-transport.js";
import type { BotDeps } from "../deps.js";
import {
  providerDisplayLabel
} from "../formatting.js";
import {
  buildCompileNotifyText,
  buildWikiCompilePrompt,
  describeKjbWikiPostCompileConfig,
  isTransientTelegramError,
  runConfiguredKjbWikiPostCompile,
  splitTelegramText,
  summarizeCompileOutput
} from "../wiki-compile.js";

const execFileAsync = promisify(execFile);
// 인박스 크기에 따라 compile 배치는 수 시간까지 걸릴 수 있고, 각 agy 전처리·도구 호출은
// 자체 제한시간을 갖는다. 전체 배치에 별도 고정 제한시간을 씌우면 정상 진행 중인 작업도
// 중간에 AbortError로 끊기므로 /compile에는 전체 제한시간을 두지 않는다.
let wikiCompileRunning = false;
let transcriptDumpRunning = false;

/** 테스트 전용: /compile·/dpbot 모듈 플래그를 초기화한다. */
export function resetAdvisoryRuntimeStateForTests(): void {
  wikiCompileRunning = false;
  transcriptDumpRunning = false;
}

export function registerAdvisoryHandlers(bot: Bot, deps: BotDeps): void {
  const {
    config,
    store,
    sessions,
    refreshProjectCatalog
  } = deps;

  bot.command("catbot", async (ctx) => {
    try {
      const count = await refreshProjectCatalog();
      await ctx.reply(`프로젝트 카탈로그를 갱신했습니다.\n확인된 프로젝트: ${count}개`);
    } catch (error) {
      await ctx.reply(`프로젝트 카탈로그 갱신 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
    }
  });

  bot.command("route", async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "작업 설명과 함께 사용하세요.\n예: /route 이 PDF를 요약해줘\n"
        + "작업유형과 이력 기반 강점 사전을 보고 인증된 Claude·Codex·Antigravity·Grok 중 적합한 제공자를 추천합니다."
      );
      return;
    }
    const hints = loadStrengthHints(agentStrengthsPath());
    const decision = routeProvider(arg, hints, config.availableProviders);
    const hintNote = Object.keys(hints).length === 0
      ? "\n(강점 사전이 아직 비어 있어 기본 규칙으로만 판단했습니다.)"
      : decision.usedHint
        ? "\n(이력 기반 강점 사전이 기본 규칙을 보정했습니다.)"
        : "";
    await ctx.reply(
      `추천 제공자: ${providerDisplayLabel(decision.provider)}\n`
      + `작업유형: ${decision.taskType}\n`
      + `근거: ${decision.reason}${hintNote}`
    );
  });

  // /synth <작업>: 병렬 종합. 인증된 Claude·Codex·Antigravity·Grok을 읽기 전용으로 동시에 시키고,
  // 서로 비판한 뒤 원 모델들이 보완 답을 낸다. 동적으로 감지한 최신 Claude Fable 심사자가 보완 후보를
  // 승점제 리그 방식으로 비교해 최우수 답을 고른 뒤 승자가 통합해 최종답을 낸다.
  // 읽기·조언 작업 전용(파일 수정 안 함). 토큰·시간이 N배인 비싼 경로.

  bot.command("synth", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "작업 설명과 함께 사용하세요.\n예: /synth 이 설계의 위험 요소를 분석해줘\n"
        + "인증된 Claude·Codex·Antigravity·Grok을 읽기 전용으로 실행하고 상호 비판 → 원 모델별 보완 → 승점제 리그 심사 → 승자 통합 순서로 답합니다. "
        + "읽기·조언 작업 전용이며 토큰·시간이 더 듭니다."
      );
      return;
    }
    await ctx.reply(
      "병렬 종합을 시작합니다. 인증된 Claude·Codex·Antigravity·Grok 원답 → 상호 비판 → 원 모델별 보완 → 최신 Claude Fable 심사 → 통합. "
      + "잠시 걸립니다."
    );
    try {
      const result = await sessions.runSynthesis(session, arg);
      if (!result.ok) {
        await ctx.reply(`병렬 종합을 완료하지 못했습니다: ${result.reason ?? "원인 불명"}`);
        return;
      }
      const judgeLabel = result.verdict
        ? result.verdict.judge === "claude"
          ? `Claude ${modelLabel(config.modelCatalog, result.verdict.judgeModel ?? "Fable")} high`
          : "폴백(첫 후보)"
        : "단일 후보(심사 생략)";
      const candidateLabels = (result.candidates ?? [])
        .map((p) => providerDisplayLabel(p))
        .join("·");
      const scoreLine = result.verdict?.scores && result.candidates
        ? "\n승점: " + result.verdict.scores
          .map((score, index) => `${providerDisplayLabel(result.candidates![index]!)} ${score}`)
          .join(" / ")
        : "";
      const tail =
        `\n\n———\n후보: ${candidateLabels} / 심사: ${judgeLabel}`
        + (result.synthesizedBy ? ` / 통합: ${providerDisplayLabel(result.synthesizedBy)}` : "")
        + scoreLine
        + (result.verdict ? `\n근거: ${result.verdict.reason}` : "");
      await ctx.reply(`${result.answer ?? ""}${tail}`);
    } catch (error) {
      await ctx.reply(`병렬 종합 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
    }
  });

  // /query <질문>: LLM-Wiki에 질문한다. 현재 세션 에이전트(Claude/Codex/agy)에게
  // llm-wiki 커넥터를 우선 사용하고, 없으면 위키 규약(.claude/commands/query.md)을
  // 읽어 그대로 수행하라고 주입한다. 검색 대상은 항상 LLM-Wiki(절대경로)이며 현재
  // 세션 프로젝트 cwd와 무관하다.

  bot.command("query", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "질문과 함께 사용하세요.\n예: /query 멀티모델 오케스트레이션이 뭐야?\n"
        + "현재 세션 에이전트가 llm-wiki 커넥터 또는 query.md 규약으로 검색해 인용과 함께 답합니다."
      );
      return;
    }
    if (sessions.isActive(session.id)) {
      await ctx.reply("현재 세션이 작업 중입니다. 끝난 뒤 다시 시도하거나 /steer로 지시하세요.");
      return;
    }
    const vault = wikiVaultPath();
    const prompt =
      `다음 질문에 LLM-Wiki로 답하라.\n\n`
      + `질문: ${arg}\n\n`
      + `절차: llm-wiki 커넥터가 노출되어 있으면 먼저 그 커넥터의 query/search/read 도구로 `
      + `후보를 회수한다. 커넥터가 없으면 \`${vault}/.claude/commands/query.md\`를 읽고, `
      + `그 규약(2단 라우팅 Route→Search, 근거 인용, 지어내기 금지)을 그대로 따른다. `
      + `검색 대상 저장소 루트는 `
      + `\`${vault}\` 이며, 현재 작업 디렉터리가 아니라 이 절대경로 안의 파일만 읽는다. `
      + `규약대로 회수한 페이지 내용으로만, 각 주장에 \`[[페이지]]\` 인용을 붙여 답하라. `
      + `근거가 없으면 "위키에 없음 — /ingest 필요"라고 답하고 지어내지 마라. `
      + `규약의 복리 환원 단계가 적용되는 경우 \`50-queries/\`, 관련 위키 인덱스, 로그 갱신은 수행해도 된다. `
      + `단, 원본 보존을 위해 \`10-inbox/\`와 \`20-raw/\`의 원본 자료는 삭제하거나 덮어쓰지 마라.`;
    if (!sessions.resume(session, prompt)) {
      await ctx.reply("질의를 시작하지 못했습니다. 세션 상태를 확인하세요.");
      return;
    }
    await ctx.reply(`LLM-Wiki에 질의합니다: ${arg}`);
  });

  bot.command("compile", async (ctx) => {
    const arg = ctx.match.trim();
    // 통지 전송 자체가 네트워크 실패로 reject되면(예: 타임아웃 직후 텔레그램 일시 단절)
    // fire-and-forget 체인에서 unhandledRejection으로 번져 전역 가드가 울린다. 통지는 항상
    // 삼켜서, 컴파일 자체의 성패와 무관하게 프로미스 체인이 조용히 안정 종료되게 한다.
    // compile은 수십 분이 걸리므로 완료 통지를 놓치면 사용자는 결과를 영영 알 수 없다.
    // 긴 본문은 4096자 단위로 나눠 순차 전송하고(내용 폐기 없음), 네트워크 일시 단절만
    // 조각 단위 지수 백오프로 재시도한다. message is too long 은 더 잘게 다시 나눠 재시도한다.
    const sendChunk = async (payload: string, label: string): Promise<void> => {
      const delaysMs = [1_000, 5_000, 15_000, 45_000, 120_000];
      for (let attempt = 0; ; attempt += 1) {
        try {
          await ctx.api.sendMessage(config.chatId, payload);
          if (attempt > 0) {
            console.warn(`[compile] 통지 전송 성공(${label}, 재시도 ${attempt}회)`);
          }
          return;
        } catch (err) {
          const detail = safeErrorMessage(err);
          // 분할 후에도 길이 오류가 나면(이론상 드묾) 내용을 버리지 않고 더 잘게 다시 나눈다.
          if (
            String(detail).toLowerCase().includes("message is too long")
            && payload.length > 1
          ) {
            const smaller = splitTelegramText(payload, Math.max(1, Math.floor(payload.length / 2)));
            console.warn(
              `[compile] 조각 ${label} 길이 거절 → ${smaller.length}개로 재분할:`,
              detail
            );
            for (let sub = 0; sub < smaller.length; sub += 1) {
              await sendChunk(smaller[sub]!, `${label}.${sub + 1}`);
            }
            return;
          }
          if (!isTransientTelegramError(err)) {
            console.error(
              `[compile] 통지 전송 최종 실패(비재시도, ${label}): chars=${payload.length}:`,
              detail
            );
            return;
          }
          const delay = delaysMs[attempt];
          if (delay === undefined) {
            console.error(
              `[compile] 통지 전송 최종 실패(${label}): chars=${payload.length}:`,
              detail
            );
            return;
          }
          console.warn(
            `[compile] 통지 전송 실패(${label}), ${delay / 1_000}초 뒤 재시도:`,
            detail
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    };

    const notify = async (text: string): Promise<void> => {
      const chunks = splitTelegramText(text);
      if (chunks.length > 1) {
        console.warn(`[compile] 통지 ${chunks.length}개 조각으로 순차 전송 (total=${text.length})`);
      }
      for (let index = 0; index < chunks.length; index += 1) {
        await sendChunk(chunks[index]!, `${index + 1}/${chunks.length}`);
      }
    };
    if (wikiCompileRunning) {
      await notify("LLM-Wiki compile이 이미 진행 중입니다.");
      return;
    }
    const vault = wikiVaultPath();
    const defaults = store.getSessionDefaults();
    wikiCompileRunning = true;
    await notify(
      `LLM-Wiki compile을 시작합니다.\n${providerDisplayLabel(defaults.provider)} · ${vault}`
    );
    void sessions.runOneOffTask({
      provider: defaults.provider,
      defaults,
      cwd: vault,
      prompt: buildWikiCompilePrompt(vault, arg),
      allowProviderFallback: false
    }).then(async (output) => {
      const summary = summarizeCompileOutput(output);
      try {
        const postCompileOutput = await runConfiguredKjbWikiPostCompile();
        if (postCompileOutput !== undefined) {
          const postCompileSummary = summarizeCompileOutput(postCompileOutput);
          console.log(
            `[compile] KJB Wiki 공개 그래프 재생성·배포 완료${postCompileSummary ? `\n${postCompileSummary}` : ""}`
          );
          await notify(buildCompileNotifyText(
            "LLM-Wiki compile 및 KJB Wiki 공개 그래프 배포 완료.",
            summary
          ));
          return;
        }
      } catch (error: unknown) {
        await notify(buildCompileNotifyText(
          `LLM-Wiki compile은 완료했지만 KJB Wiki 공개 그래프 배포 오류: ${safeErrorMessage(error)}`,
          summary
        ));
        return;
      }
      // 후처리 스크립트가 없거나 경로가 비면 배포를 건너뛴다. 예전에는 이 사실이
      // 통지에 안 나와 "compile만 되고 kjb wiki는 안 된다"로 오인되기 쉬웠다.
      const skip = describeKjbWikiPostCompileConfig();
      await notify(buildCompileNotifyText(
        "LLM-Wiki compile 완료.",
        [summary, skip.detail].filter(Boolean).join("\n")
      ));
    }).catch(async (error: unknown) => {
      await notify(buildCompileNotifyText(
        `LLM-Wiki compile 오류: ${safeErrorMessage(error)}`
      ));
    }).finally(() => {
      wikiCompileRunning = false;
    });
  });

  // /dpbot: transcript 덤프는 사용자가 명시적으로 요청한 경우에만 실행한다.
  // 덤프 스크립트 자체의 Telegram 통지는 끄고, 명령을 호출한 대화에만 시작·완료 결과를 남긴다.
  bot.command("dpbot", async (ctx) => {
    if (transcriptDumpRunning) {
      await ctx.reply("트랜스크립트 덤프가 이미 진행 중입니다.");
      return;
    }
    const sourceDir = projectSourceDir();
    const scriptPath = resolve(sourceDir, "scripts", "dump-transcripts.mjs");
    if (!existsSync(scriptPath)) {
      await ctx.reply("트랜스크립트 덤프 스크립트를 찾을 수 없습니다.");
      return;
    }
    transcriptDumpRunning = true;
    await ctx.reply("트랜스크립트 덤프를 시작합니다.");
    void execFileAsync(process.execPath, ["--no-warnings", scriptPath], {
      cwd: sourceDir,
      env: { ...process.env, DUMP_NOTIFY: "0" },
      maxBuffer: 10 * 1024 * 1024
    }).then(async ({ stdout, stderr }) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      const tail = output.length > 3000 ? output.slice(-3000) : output;
      await ctx.reply(`트랜스크립트 덤프를 완료했습니다.${tail ? `\n\n${tail}` : ""}`);
    }).catch(async (error: unknown) => {
      await ctx.reply(`트랜스크립트 덤프 중 오류가 발생했습니다: ${safeErrorMessage(error)}`);
    }).finally(() => {
      transcriptDumpRunning = false;
    });
  });

  bot.command("diff", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const session = topicId ? store.getSessionByTopic(config.chatId, topicId) : undefined;
    if (!session) {
      await ctx.reply("세션 토픽 안에서 사용하세요.");
      return;
    }
    try {
      const { stdout } = await execFileAsync("git", ["-C", session.cwd, "diff", "--stat"], {
        maxBuffer: 1024 * 1024
      });
      await ctx.reply(stdout.trim() || "현재 git diff가 없습니다.");
    } catch {
      await ctx.reply("이 프로젝트에서 git diff를 읽을 수 없습니다.");
    }
  });
}
