import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { FALLBACK_MODEL_CATALOG, loadModelCatalog } from "./model-catalog.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";
import { syncSharedResources } from "./resource-sync.js";

const TELEGRAM_POLL_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = new StateStore(config.databasePath);
  store.syncProjects(config.projects);
  const interrupted = store.interruptIncompleteSessions();
  const shared = syncSharedResources();
  console.log(
    `Shared resources → skills: ${shared.skillCount}, connectors: ${shared.connectorCount}, `
    + `providers: ${shared.providerSkillRoots}`
  );

  // 제공사 카탈로그(Claude=SDK supportedModels, Codex=번들 바이너리 debug models)를 읽어
  // 모델·사고(thinking)·추론(reasoning) 선택지를 동적으로 채운다. 실패하면 정적 fallback 유지.
  const firstProject = config.projects[0];
  if (firstProject) {
    config.modelCatalog = await loadModelCatalog({
      cwd: firstProject.cwd,
      oauthToken: config.claudeCodeOauthToken,
      claudeCodeExecutable: config.claudeCodeExecutable,
      agyExecutable: config.agyExecutable,
      geminiApiKey: config.geminiApiKey,
      mcpToolTimeoutMs: config.mcpToolTimeoutMs
    }).catch(() => FALLBACK_MODEL_CATALOG);
    const claudeDynamic = config.modelCatalog.claudeModels.some((m) => m.source === "api");
    const codexDynamic = config.modelCatalog.codexModels.some((m) => m.source === "cli");
    const agyDynamic = config.modelCatalog.agyModels.some((m) => m.source === "api");
    console.log(
      `Model catalog → Claude: ${claudeDynamic ? "동적" : "기본값"}, `
      + `Codex: ${codexDynamic ? "동적" : "기본값"}, `
      + `Antigravity: ${agyDynamic ? "동적" : "기본값"}`
    );
  }

  const { bot } = createBot(config, store);

  // 전역 안전망: 단일 요청(특히 /synth의 Claude·Codex·agy 병렬 실행)에서 처리되지 못한
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

  await bot.api.setMyCommands([
    { command: "new", description: "새 작업 시작 (Claude/Codex/Antigravity)" },
    { command: "start", description: "도움말과 기본값 패널 표시" },
    { command: "reserve", description: "지정 시각에 새 작업 시작" },
    { command: "cancel", description: "대기 중인 예약 작업 선택 취소" },
    { command: "tokenid", description: "새 Codex 세션 시작 전 사용할 계정 번호 지정" },
    { command: "status", description: "오케스트레이터와 현재 작업 상태" },
    { command: "doctor", description: "실행 환경 진단" },
    { command: "addp", description: "절대경로 프로젝트 추가" },
    { command: "deltp", description: "등록 프로젝트 삭제" },
    { command: "sessions", description: "최근 세션 목록" },
    { command: "usage", description: "현재 한도 사용량" },
    { command: "projects", description: "등록 프로젝트 목록" },
    { command: "steer", description: "실행 중 작업에 즉시 지시" },
    { command: "next", description: "현재 작업 뒤 후속 작업 예약" },
    { command: "goal", description: "조건 충족까지 자동 진행 — check: 결정론 검증 후 판관이 판정" },
    { command: "route", description: "작업에 적합한 제공자(Claude/Codex/Antigravity) 추천" },
    { command: "synth", description: "여러 제공자 답을 비교·심사 후 장점 통합" },
    { command: "query", description: "LLM-Wiki에 질문 (인용 포함 답변)" },
    { command: "stop", description: "현재 토픽 작업 중단" },
    { command: "fork", description: "현재 세션 분기" },
    { command: "compact", description: "현재 세션 컨텍스트 압축" },
    { command: "memory", description: "현재 세션을 전역 메모리에 기록" },
    { command: "mode", description: "권한 모드 확인 또는 변경" },
    { command: "model", description: "제공자(Claude/Codex/Antigravity)·모델 확인 또는 변경" },
    { command: "thinking", description: "Claude 확장적 사고 on/off 확인 또는 변경" },
    { command: "power", description: "현재 AI 작업량/추론 강도 확인 또는 변경" },
    { command: "lean", description: "최소 구현 원칙 확인 또는 변경" },
    { command: "reset", description: "세션 문맥만 초기화" },
    { command: "diff", description: "프로젝트 git diff 요약" },
    { command: "delete", description: "토픽과 로컬 세션 삭제" }
  ]).catch((error: unknown) => {
    // Telegram API가 일시적으로 불안정해도 기존 명령 목록으로 봇 본체는 계속
    // 실행되어야 한다. 다음 데몬 재시작 때 명령 동기화를 다시 시도한다.
    console.error(`Telegram command sync failed: ${safeErrorMessage(error)}`);
  });

  if (interrupted > 0) {
    await bot.api.sendMessage(
      config.chatId,
      `[RECOVERY] 재시작 전 실행 중이던 ${interrupted}개 세션을 중단 상태로 표시했습니다. 기존 토픽에 후속 지시를 보내 재개할 수 있습니다.`
    ).catch((error: unknown) => {
      console.error(`Telegram recovery notice failed: ${safeErrorMessage(error)}`);
    });
  }

  let shuttingDown = false;
  const shutdown = () => {
    shuttingDown = true;
    void bot.stop().catch((error: unknown) => {
      console.error(`Telegram shutdown failed: ${safeErrorMessage(error)}`);
    }).finally(() => {
      store.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`Telegram Claude orchestrator started with ${config.projects.length} project(s).`);
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
}

main().catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
