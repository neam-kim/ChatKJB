import {
  buildJudgePrompt,
  buildPeerCritiquePrompt,
  buildRevisionPrompt,
  buildSynthesisPrompt,
  parseJudgeResponse,
  type JudgeCandidate,
  type JudgeVerdict,
  type SynthCritique
} from "../judge.js";
import {
  latestClaudeFableModel,
  type CodexReasoningEffort,
  type ModelCatalog
} from "../model-catalog.js";
import type { ProviderKind, SessionRecord } from "../types.js";

const JUDGE_CLAUDE_THINKING = "high";
const JUDGE_CLAUDE_EFFORT = "high";

// SDK/CLI 초기화를 같은 순간에 몰아 저수준 read 실패와 fd 스파이크를 일으키지 않도록
// 시작 시점만 어긋나게 한다. 시작된 provider들은 계속 병렬로 실행된다.
const PROVIDER_START_STAGGER_MS = 400;
const SYNTHESIS_PROVIDERS = ["claude", "codex", "agy", "grok", "cline"] as const;

export interface ReadOnlyExecutionOptions {
  claudeModelOverride?: string;
  claudeThinkingOverride?: string;
  claudeEffortOverride?: string;
  codexModelOverride?: string;
  codexReasoningOverride?: CodexReasoningEffort;
  timeoutMs?: number;
  toolFree?: boolean;
}

export interface SynthesisResult {
  ok: boolean;
  reason?: string;
  answer?: string;
  candidates?: ProviderKind[];
  verdict?: JudgeVerdict;
  synthesizedBy?: ProviderKind;
}

export interface SynthesisDependencies {
  modelCatalog: ModelCatalog;
  isProviderAvailable: (provider: ProviderKind) => boolean;
  executeReadOnly: (
    session: SessionRecord,
    provider: ProviderKind,
    prompt: string,
    options?: ReadOnlyExecutionOptions
  ) => Promise<string>;
  reportError: (context: string, error: unknown) => void;
}

function staggerProviderStart(index: number): Promise<void> {
  if (index === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, index * PROVIDER_START_STAGGER_MS);
  });
}

async function collectCandidates(
  dependencies: SynthesisDependencies,
  session: SessionRecord,
  prompt: string,
  providers: readonly ProviderKind[]
): Promise<JudgeCandidate[]> {
  const settled = await Promise.allSettled(
    providers.map(async (provider, index) => {
      await staggerProviderStart(index);
      return dependencies.executeReadOnly(session, provider, prompt);
    })
  );
  const candidates: JudgeCandidate[] = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled" && result.value.trim()) {
      candidates.push({ provider: providers[index]!, text: result.value.trim() });
    }
  }
  return candidates;
}

async function collectPeerCritiques(
  dependencies: SynthesisDependencies,
  session: SessionRecord,
  question: string,
  candidates: readonly JudgeCandidate[]
): Promise<SynthCritique[]> {
  const settled = await Promise.allSettled(
    candidates.map(async (candidate, index) => {
      await staggerProviderStart(index);
      const prompt = buildPeerCritiquePrompt(question, candidates, candidate.provider);
      return {
        provider: candidate.provider,
        text: (await dependencies.executeReadOnly(
          session,
          candidate.provider,
          prompt
        )).trim()
      };
    })
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value.text ? [result.value] : []
  );
}

async function reviseCandidates(
  dependencies: SynthesisDependencies,
  session: SessionRecord,
  question: string,
  candidates: readonly JudgeCandidate[],
  critiques: readonly SynthCritique[]
): Promise<JudgeCandidate[]> {
  if (critiques.length === 0) return [];
  const settled = await Promise.allSettled(
    candidates.map(async (candidate, index) => {
      await staggerProviderStart(index);
      const prompt = buildRevisionPrompt(question, candidate, candidates, critiques);
      return {
        provider: candidate.provider,
        text: (await dependencies.executeReadOnly(
          session,
          candidate.provider,
          prompt
        )).trim()
      };
    })
  );
  return settled.flatMap((result) =>
    result.status === "fulfilled" && result.value.text ? [result.value] : []
  );
}

async function judgeCandidates(
  dependencies: SynthesisDependencies,
  session: SessionRecord,
  question: string,
  candidates: readonly JudgeCandidate[]
): Promise<JudgeVerdict> {
  const fable = dependencies.isProviderAvailable("claude")
    ? latestClaudeFableModel(dependencies.modelCatalog)
    : undefined;
  if (fable) {
    try {
      const text = await dependencies.executeReadOnly(
        session,
        "claude",
        buildJudgePrompt(question, candidates),
        {
          claudeModelOverride: fable.id,
          claudeThinkingOverride: JUDGE_CLAUDE_THINKING,
          claudeEffortOverride: JUDGE_CLAUDE_EFFORT
        }
      );
      const parsed = parseJudgeResponse(text, candidates.length);
      if (parsed) return { ...parsed, judge: "claude", judgeModel: fable.id };
    } catch (error) {
      dependencies.reportError(`Claude Fable synthesis judge failed (${fable.id})`, error);
    }
  }

  return {
    winner: 1,
    reason: fable
      ? `승점제 심사자(${fable.label})를 사용할 수 없어 첫 후보를 선택했습니다.`
      : dependencies.isProviderAvailable("claude")
        ? "Claude 모델 카탈로그에서 Fable을 찾지 못해 첫 후보를 선택했습니다."
        : "Claude OAuth가 없어 Claude 전용 심사를 건너뛰고 첫 후보를 선택했습니다.",
    judge: "fallback"
  };
}

/**
 * 읽기 전용 provider 후보 생성 → 상호 비평 → 개정 → 심사 → 최종 통합을 조정한다.
 * 세션 큐와 provider별 실행 세부사항은 주입받아 이 모듈이 런타임 상태를 직접 소유하지 않는다.
 */
export async function synthesizeProviderResponses(
  dependencies: SynthesisDependencies,
  session: SessionRecord,
  question: string
): Promise<SynthesisResult> {
  const providers = SYNTHESIS_PROVIDERS
    .filter((provider): provider is ProviderKind =>
      dependencies.isProviderAvailable(provider)
    );
  const candidates = await collectCandidates(dependencies, session, question, providers);
  if (candidates.length === 0) {
    return { ok: false, reason: "후보 제공자가 모두 응답하지 못했습니다." };
  }

  if (candidates.length === 1) {
    return {
      ok: true,
      answer: candidates[0]!.text,
      candidates: [candidates[0]!.provider],
      synthesizedBy: candidates[0]!.provider
    };
  }

  const critiques = await collectPeerCritiques(dependencies, session, question, candidates);
  const revised = await reviseCandidates(
    dependencies,
    session,
    question,
    candidates,
    critiques
  );
  const judgedCandidates = revised.length >= 2 ? revised : candidates;
  const verdict = await judgeCandidates(dependencies, session, question, judgedCandidates);
  const winner = judgedCandidates[verdict.winner - 1] ?? judgedCandidates[0]!;

  let answer = winner.text;
  try {
    answer = (await dependencies.executeReadOnly(
      session,
      winner.provider,
      buildSynthesisPrompt(question, judgedCandidates, verdict)
    )).trim() || winner.text;
  } catch (error) {
    dependencies.reportError("Synthesis merge failed", error);
  }

  return {
    ok: true,
    answer,
    candidates: judgedCandidates.map((candidate) => candidate.provider),
    verdict,
    synthesizedBy: winner.provider
  };
}
