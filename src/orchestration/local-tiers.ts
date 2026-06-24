import type { TaskContract, DiffBudget } from "./types.js";

export const TIER1_MODEL = "gemma4:e4b-64k";
export const TIER2_MODEL = "qwen3.6:27b-96k";
export const TIER3_MODEL = "qwen3-coder:30b-96k";
export const TIER2_JUDGE_TIMEOUT_MS = 300000;

export interface OllamaConfig {
  url: string;
  timeoutMs: number;
}

export function ollamaConfig(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  return {
    url: env.OLLAMA_URL || "http://localhost:11434/api/chat",
    timeoutMs: Number(env.OLLAMA_TIMEOUT_MS) || 120000,
  };
}

export function ollamaTimeoutForModel(model: string, config: OllamaConfig): number {
  return model === TIER2_MODEL ? TIER2_JUDGE_TIMEOUT_MS : config.timeoutMs;
}

export interface TierPrompt {
  system: string;
  user: string;
}

export function buildTier1Prompt(task: string): TierPrompt {
  return {
    system: `gemma는 클레크/요약자/분류기입니다. 허용된 작업: 로그 요약, diff 요약, 진행 보고서, 검색 순위 매기기, 실패 클러스터링, 변경 파일 목록. 금지(FORBIDDEN)된 작업: 근본 원인 판단, 아키텍처 권장, 공개 API 변경 제안, 최종 전략 결정. 출력에는 반드시 포함해야 합니다: 요약, 근거 파일/라인 포인터, 불확실성 표시.`,
    user: task.trim(),
  };
}

export function buildTier2Prompt(task: string): TierPrompt {
  return {
    system: `qwen3.6는 장문의 문서 분석가 / 요구사항 해독기 / 문서 작성자 / 리뷰 패킷 기획자입니다. 허용된 작업: 장문 문서 요약, 요구사항 해독, KR/EN 설명 작성, 리뷰 패킷 초안 작성, 작업 컨텍스트 정리. 금지된 작업: 최종 아키텍처 결정, 최종 위험 판단, 체크포인트 승인, 작업 계약 변경, 허용 파일 범위 확장.`,
    user: task.trim(),
  };
}

export function buildTier3Prompt(contract: TaskContract): TierPrompt {
  const { goal, allowedFiles, forbiddenFiles, forbiddenChanges, inputs, expectedOutput, acceptanceCriteria, diffBudget } = contract;
  const budget = diffBudget;
  const user = [
    `목표: ${goal}`,
    `허용 파일: ${allowedFiles.join("\n- ")}`,
    `금지 파일: ${forbiddenFiles.join("\n- ")}`,
    `금지 변경: ${forbiddenChanges.join("\n- ")}`,
    `입력: ${inputs.join("\n- ")}`,
    `예상 출력: ${expectedOutput.join("\n- ")}`,
    `수용 기준: ${acceptanceCriteria.join("\n- ")}`,
    `diff 예산: maxChangedFiles:${budget.maxChangedFiles}, maxAddedLoc:${budget.maxAddedLoc}, maxDeletedLoc:${budget.maxDeletedLoc}`,
  ].join("\n\n");
  return {
    system: `qwen3-coder는 구현 작업자입니다. 반드시 allowedFiles 내에서만 작업해야 하며, forbiddenFiles에 접근하거나 forbiddenChanges를 수행해서는 안 됩니다. 최소한의 diff만 생성해야 하며, 테스트 없이는 done을 선언해서는 안 됩니다. 만약 수정이 허용된 범위를 벗어나면 블로커로 간주하고 보고해야 합니다.`,
    user,
  };
}

export interface CodeBlock {
  path: string | null;
  code: string;
}

export function extractCodeBlocks(content: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      // fence open — collect body lines until next fence-start line
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        bodyLines.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      // trim leading/trailing blank lines from body
      while (bodyLines.length > 0 && (bodyLines[0] ?? "").trim() === "") bodyLines.shift();
      while (bodyLines.length > 0 && (bodyLines[bodyLines.length - 1] ?? "").trim() === "") bodyLines.pop();
      const code = bodyLines.join("\n");
      // detect path from first line matching `// <path-with-extension>`
      const firstLine = (bodyLines[0] ?? "").trim();
      let path: string | null = null;
      if (firstLine.startsWith("// ")) {
        const pathMatch = firstLine.match(/^\/\/ (.+\.\w+)$/);
        path = pathMatch != null ? (pathMatch[1] ?? null) : null;
      }
      blocks.push({ path, code });
    } else {
      i++;
    }
  }
  return blocks;
}

export async function callOllama(model: string, prompt: TierPrompt, config?: OllamaConfig): Promise<string> {
  const resolvedConfig = config ?? ollamaConfig();
  const { url } = resolvedConfig;
  const timeoutMs = ollamaTimeoutForModel(model, resolvedConfig);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: 98304,
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}`);
    }
    const data = await response.json();
    return data.message?.content ?? "";
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export async function runTier1(task: string, config?: OllamaConfig): Promise<string> {
  return callOllama(TIER1_MODEL, buildTier1Prompt(task), config);
}

export async function runTier2(task: string, config?: OllamaConfig): Promise<string> {
  return callOllama(TIER2_MODEL, buildTier2Prompt(task), config);
}

export async function runTier3(contract: TaskContract, config?: OllamaConfig): Promise<CodeBlock[]> {
  const raw = await callOllama(TIER3_MODEL, buildTier3Prompt(contract), config);
  return extractCodeBlocks(raw);
}
