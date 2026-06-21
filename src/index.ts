import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";
import { FALLBACK_MODEL_CATALOG, loadModelCatalog } from "./model-catalog.js";
import { StateStore } from "./store.js";
import { safeErrorMessage } from "./telegram-transport.js";
import { syncSharedResources } from "./resource-sync.js";

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
      + `agy: ${agyDynamic ? "동적" : "기본값"}`
    );
  }

  const { bot } = createBot(config, store);

  await bot.api.setMyCommands([
    { command: "new", description: "새 작업 시작 (Claude/Codex/agy)" },
    { command: "status", description: "오케스트레이터와 현재 작업 상태" },
    { command: "doctor", description: "실행 환경 진단" },
    { command: "addp", description: "절대경로 프로젝트 추가" },
    { command: "deltp", description: "등록 프로젝트 삭제" },
    { command: "sessions", description: "최근 세션 목록" },
    { command: "usage", description: "현재 한도 사용량" },
    { command: "projects", description: "등록 프로젝트 목록" },
    { command: "steer", description: "실행 중 작업에 즉시 지시" },
    { command: "next", description: "현재 작업 뒤 후속 작업 예약" },
    { command: "goal", description: "목표 조건 달성까지 자동으로 턴 이어가기" },
    { command: "stop", description: "현재 토픽 작업 중단" },
    { command: "fork", description: "현재 세션 분기" },
    { command: "compact", description: "현재 세션 컨텍스트 압축" },
    { command: "memory", description: "현재 세션을 전역 메모리에 기록" },
    { command: "mode", description: "권한 모드 확인 또는 변경" },
    { command: "model", description: "제공자(Claude/Codex/agy)·모델 확인 또는 변경" },
    { command: "thinking", description: "Claude 확장적 사고 on/off 확인 또는 변경" },
    { command: "power", description: "현재 AI 작업량/추론 강도 확인 또는 변경" },
    { command: "lean", description: "최소 구현 원칙 확인 또는 변경" },
    { command: "reset", description: "세션 문맥만 초기화" },
    { command: "diff", description: "프로젝트 git diff 요약" },
    { command: "delete", description: "토픽과 로컬 세션 삭제" }
  ]);

  if (interrupted > 0) {
    await bot.api.sendMessage(
      config.chatId,
      `[RECOVERY] 재시작 전 실행 중이던 ${interrupted}개 세션을 중단 상태로 표시했습니다. 기존 토픽에 후속 지시를 보내 재개할 수 있습니다.`
    );
  }

  const shutdown = () => {
    bot.stop();
    store.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`Telegram Claude orchestrator started with ${config.projects.length} project(s).`);
  await bot.start({
    allowed_updates: ["message", "callback_query"]
  });
}

main().catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
