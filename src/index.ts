import { createBot } from "./bot.js";
import { BOT_COMMANDS } from "./bot-commands.js";
import { reapOrphanedClineMcp } from "./cline-orphan-reaper.js";
import { loadConfig } from "./config.js";
import { startDaemonUsagePublisher } from "./daemon-usage-publisher.js";
import { FALLBACK_MODEL_CATALOG, loadModelCatalog } from "./model-catalog.js";
import { DEFAULT_CODEX_MODEL } from "./model-catalog.js";
import { syncSharedResourcesCached } from "./resource-sync.js";
import { buildServiceRecoveryPrompt } from "./session-prompts.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";

const TELEGRAM_POLL_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new StateStore(config.databasePath);
  store.syncProjects(config.projects);
  const interrupted = store.interruptIncompleteSessions();
  const shared = syncSharedResourcesCached();
  console.log(
    `Shared resources → skills: ${shared.skillCount}, connectors: ${shared.connectorCount}, `
    + `providers: ${shared.providerSkillRoots}`
  );

  // 크래시·SIGKILL로 죽은 직전 실행은 ClineExecutor.dispose()를 못 부르고, Cline 허브는
  // 끊긴 클라이언트의 MCP 함대를 회수하지 않는다. launchd KeepAlive 재시작마다 한 벌씩
  // 쌓이므로 시작 시점에 고아 함대를 정리한다.
  const reaped = await reapOrphanedClineMcp().catch((error: unknown) => {
    console.error(`Cline orphan MCP reap failed: ${safeErrorMessage(error)}`);
    return null;
  });
  if (reaped?.reapedPids.length) {
    console.log(`Cline orphan MCP reaped → ${reaped.reapedPids.length} process(es).`);
  } else if (reaped?.skippedBusy) {
    console.log("Cline orphan MCP reap skipped → hub has connected clients.");
  }

  // 제공사 카탈로그(Claude=선택된 Claude CLI 경유 SDK, Codex=선택된 CLI debug models)를 읽어
  // 모델·사고(thinking)·추론(reasoning) 선택지를 동적으로 채운다. 실패하면 정적 fallback 유지.
  const firstProject = config.projects[0];
  if (firstProject) {
    config.modelCatalog = await loadModelCatalog({
      cwd: firstProject.cwd,
      oauthToken: config.claudeCodeOauthToken,
      availableProviders: config.availableProviders,
      claudeCodeExecutable: config.claudeCodeExecutable,
      codexExecutable: config.codexExecutable,
      agyExecutable: config.agyExecutable,
      grokExecutable: config.grokExecutable,
      mcpToolTimeoutMs: config.mcpToolTimeoutMs,
      alibabaTokenPlan: config.alibabaTokenPlan
    }).catch(() => FALLBACK_MODEL_CATALOG);
    // Token Plan이 설정된 첫 적용에서는 기존 GPT 기본값만 사용자가 요청한 모델로 전환한다.
    // 사용자가 이미 선택한 다른 모델과 실행 중인 세션은 건드리지 않는다.
    if (config.alibabaTokenPlan
      && config.modelCatalog.codexModels.some((model) =>
        model.source === "token-plan"
        && model.id.toLowerCase() === config.alibabaTokenPlan!.defaultModel.toLowerCase()
      )
      && store.getSessionDefaults().codexModel === DEFAULT_CODEX_MODEL) {
      store.updateSessionDefaults({ codexModel: config.alibabaTokenPlan.defaultModel });
    }
    const claudeDynamic = config.modelCatalog.claudeModels.some((m) => m.source === "api");
    const codexDynamic = config.modelCatalog.codexModels.some((m) => m.source === "cli");
    const alibabaDynamic = config.modelCatalog.codexModels.some((m) => m.source === "token-plan");
    const agyDynamic = config.modelCatalog.agyModels.some((m) => m.source === "cli");
    const grokDynamic = config.modelCatalog.grokModels.some((m) => m.source === "cli");
    const clineDynamic = config.modelCatalog.clineProviders.length > 0;
    console.log(
      `Model catalog → Claude: ${claudeDynamic ? "동적" : "기본값"}, `
      + `Codex: ${codexDynamic ? "동적" : "기본값"}`
      + `${alibabaDynamic ? " · Alibaba Token Plan: 동적" : ""}, `
      + `Antigravity: ${agyDynamic ? "동적" : "기본값"}, `
      + `Grok: ${grokDynamic ? "동적" : "기본값"}, `
      + `Cline: ${clineDynamic ? `동적(${config.modelCatalog.clineProviders.length} providers)` : "사용 불가"}`
    );
  }

  const { bot, sessions, startProjectCatalog, startTopicDeletionMonitor, dispose } = createBot(config, store);

  // 다른 Mac 의 Terminal 이 **이 데몬 호스트의 사용량**을 볼 수 있도록 공유 캐시에 게시.
  // (NAS Program/chatkjb-usage.json 등 — Terminal DMG 와 같은 폴더 계열)
  const usagePublisher = startDaemonUsagePublisher({
    databasePath: config.databasePath,
    codexExecutable: config.codexExecutable,
    grokExecutable: config.grokExecutable,
    codexAccountHomes: config.codexAccountHomes,
    projectDir: process.env.CHATKJB_PROJECT_DIR?.trim() || process.cwd()
  });

  // 전역 안전망: 단일 요청(특히 /synth의 Claude·Codex·agy·Grok 병렬 실행)에서 처리되지 못한
  // 예외가 새어 나와도 데몬 전체를 죽이지 않는다. Node 기본 동작은 uncaughtException·
  // unhandledRejection 시 프로세스 종료이므로, 가드가 없으면 그 한 번의 결함으로 진행 중이던
  // 모든 토픽의 대화가 함께 죽고 launchd 재시작에 의존하게 된다(실제 /synth 실행 중
  // 모듈 로딩 단계 저수준 read 실패 errno 11로 봇이 통째로 내려간 사례). 상태 손상
  // 가능성이 있는 uncaughtException도 여기서는 로깅·통지 후 생존을 택한다 — 멀티 토픽 봇에서
  // 한 작업의 결함으로 전체를 내리는 것이 더 큰 손해다.
  const notifyFault = (label: string, error: unknown) => {
    const message = safeErrorMessage(error);
    console.error(`[guard] 처리되지 않은 ${label} 가드: ${message}`);
    void bot.api.sendMessage(
      config.chatId,
      `[안정성] 처리되지 않은 ${label}를 가드했습니다. 봇은 계속 실행 중입니다.\n${message}`
    ).catch(() => {});
  };
  process.on("unhandledRejection", (reason) => notifyFault("unhandledRejection", reason));
  process.on("uncaughtException", (error) => notifyFault("uncaughtException", error));

  await startProjectCatalog().then((count) => {
    console.log(`Project catalog ready with ${count} project(s).`);
  }).catch((error: unknown) => {
    console.error(`Project catalog startup refresh failed: ${safeErrorMessage(error)}`);
  });

  await bot.api.setMyCommands(BOT_COMMANDS.map((command) => ({ ...command }))).catch((error: unknown) => {
    // Telegram API가 일시적으로 불안정해도 기존 명령 목록으로 봇 본체는 계속
    // 실행되어야 한다. 다음 데몬 재시작 때 명령 동기화를 다시 시도한다.
    console.error(`Telegram command sync failed: ${safeErrorMessage(error)}`);
  });

  await startTopicDeletionMonitor().then((started) => {
    if (started) console.log("MTProto topic deletion monitor started.");
  }).catch(async (error: unknown) => {
    const message = safeErrorMessage(error, [
      config.telegramBotToken,
      config.telegramMtproto?.apiHash ?? ""
    ]);
    console.error(`MTProto topic deletion monitor failed to start: ${message}`);
    await bot.api.sendMessage(
      config.chatId,
      `[설정 경고] Telegram topic 직접 삭제 동기화를 시작하지 못했습니다.\n${message}`
    ).catch(() => undefined);
  });

  // 재설치·재시작은 정상 배포 경로이므로, 직전 실행 중이던 작업은 원래 제공자
  // 문맥으로 한 번 이어 간다. 승인/한도 대기는 사용자 입력 또는 실제 한도 확인이
  // 필요하므로 자동 실행하지 않는다.
  // MTProto 시작 시 이미 삭제된 Telegram 토픽의 로컬 세션이 정리될 수 있으므로,
  // 시작 전에 캡처한 복구 후보를 DB에 아직 남은 세션으로 다시 제한한다.
  const remainingInterrupted = interrupted.filter((session) => store.getSession(session.id) !== undefined);
  const resumed = remainingInterrupted.filter((session) =>
    (session.status === "running" || session.status === "queued")
    && config.availableProviders.includes(session.provider)
    && sessions.resume(session, buildServiceRecoveryPrompt())
  );

  if (remainingInterrupted.length > 0) {
    await bot.api.sendMessage(
      config.chatId,
      `[RECOVERY] 재시작 전 미완료 세션 ${remainingInterrupted.length}개를 복구했습니다. `
      + `실행 중이던 ${resumed.length}개 세션은 기존 문맥으로 자동 재개했습니다.`
    ).catch((error: unknown) => {
      console.error(`Telegram recovery notice failed: ${safeErrorMessage(error)}`);
    });
    for (const session of resumed) {
      await bot.api.sendMessage(
        session.chatId,
        "[RECOVERY] 재설치로 중단된 작업을 기존 문맥에서 자동 재개했습니다.",
        { message_thread_id: session.topicId }
      ).catch((error: unknown) => {
        console.error(`Telegram session recovery notice failed: ${safeErrorMessage(error)}`);
      });
    }
  }

  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    usagePublisher.stop();
    shutdownPromise = Promise.allSettled([
      dispose(),
      Promise.resolve().then(() => bot.stop())
    ]).then((results) => {
      const stopResult = results[1];
      if (stopResult?.status === "rejected") {
        console.error(`Telegram shutdown failed: ${safeErrorMessage(stopResult.reason)}`);
      }
      store.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(
    `ChatKJB orchestrator started with ${config.projects.length} project(s); `
    + `authenticated providers: ${config.availableProviders.join(", ")}.`
  );
  while (!shuttingDown) {
    try {
      await bot.start({
        allowed_updates: ["message", "callback_query"]
      });
      if (!shuttingDown) {
        console.error("Telegram polling stopped unexpectedly; restarting in 5 seconds.");
      }
    } catch (error: unknown) {
      if (!shuttingDown) {
        console.error(`Telegram polling failed: ${safeErrorMessage(error)}; restarting in 5 seconds.`);
      }
    }
    if (!shuttingDown) {
      await sleep(TELEGRAM_POLL_RETRY_DELAY_MS);
    }
  }
  if (shutdownPromise) await shutdownPromise;
}

main().catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
