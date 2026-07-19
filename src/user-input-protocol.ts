export interface UserInputOption {
  label: string;
  description?: string;
}

export interface UserInputQuestion {
  question: string;
  header?: string;
  options: UserInputOption[];
  multiSelect?: boolean;
}

export interface UserInputRequest {
  questions: UserInputQuestion[];
}

export type UserInputAnswers = Record<string, string | string[]>;

export interface ParsedUserInputRequest {
  visibleText: string;
  request: UserInputRequest | null;
  error: string | null;
}

const CLOSE_MARKER = "[[/REQUEST_USER_INPUT]]";
const COMPLETE_BLOCK = /(?:^|\r?\n)[ \t]*\[\[REQUEST_USER_INPUT\]\][ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\[\[\/REQUEST_USER_INPUT\]\][ \t]*(?=\r?\n|$)/g;
const STANDALONE_OPEN_MARKER = /(?:^|\r?\n)[ \t]*\[\[REQUEST_USER_INPUT\]\][ \t]*(?=\r?\n|$)/;

const MAX_BLOCK_LENGTH = 12_000;
const MAX_QUESTIONS = 3;
const MAX_QUESTION_LENGTH = 500;
const MAX_HEADER_LENGTH = 80;
const MAX_OPTIONS = 4;
const MAX_LABEL_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > maxLength) return null;
  return clean;
}

function validateRequest(value: unknown): UserInputRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.questions)
    || raw.questions.length === 0
    || raw.questions.length > MAX_QUESTIONS
  ) return null;

  const questions: UserInputQuestion[] = [];
  const seenQuestions = new Set<string>();
  for (const value of raw.questions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const questionRaw = value as Record<string, unknown>;
    const question = cleanString(questionRaw.question, MAX_QUESTION_LENGTH);
    if (!question || seenQuestions.has(question)) return null;
    seenQuestions.add(question);

    const header = questionRaw.header === undefined
      ? null
      : cleanString(questionRaw.header, MAX_HEADER_LENGTH);
    if (questionRaw.header !== undefined && !header) return null;
    if (
      !Array.isArray(questionRaw.options)
      || questionRaw.options.length < 2
      || questionRaw.options.length > MAX_OPTIONS
    ) return null;

    const options: UserInputOption[] = [];
    const seenLabels = new Set<string>();
    for (const value of questionRaw.options) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const optionRaw = value as Record<string, unknown>;
      const label = cleanString(optionRaw.label, MAX_LABEL_LENGTH);
      if (!label || seenLabels.has(label)) return null;
      seenLabels.add(label);
      const description = optionRaw.description === undefined
        ? null
        : cleanString(optionRaw.description, MAX_DESCRIPTION_LENGTH);
      if (optionRaw.description !== undefined && !description) return null;
      options.push({
        label,
        ...(description ? { description } : {})
      });
    }

    questions.push({
      question,
      ...(header ? { header } : {}),
      options,
      ...(questionRaw.multiSelect === true ? { multiSelect: true } : {})
    });
  }
  return { questions };
}

/** 응답 본문에서 선택형 UI 제어 블록을 제거한다. 미완성 스트림은 여는 표지부터 숨긴다. */
export function stripUserInputRequestBlocks(text: string): string {
  const stripped = text.replace(COMPLETE_BLOCK, "");
  const incomplete = STANDALONE_OPEN_MARKER.exec(stripped);
  const visible = incomplete?.index !== undefined ? stripped.slice(0, incomplete.index) : stripped;
  return visible.replace(/\n{3,}/g, "\n\n").trim();
}

/** 제공자 응답에서 질문 요청 하나를 읽고, 사용자에게 공개할 본문과 분리한다. */
export function parseUserInputRequest(text: string): ParsedUserInputRequest {
  const matches = [...text.matchAll(COMPLETE_BLOCK)];
  const visibleText = stripUserInputRequestBlocks(text);
  if (matches.length === 0) {
    return {
      visibleText,
      request: null,
      error: STANDALONE_OPEN_MARKER.test(text)
        ? `선택형 UI 요청에 닫는 표지 ${CLOSE_MARKER}가 없습니다.`
        : null
    };
  }
  if (matches.length > 1) {
    return { visibleText, request: null, error: "한 턴에는 선택형 UI 요청을 하나만 보낼 수 있습니다." };
  }
  const match = matches[0]!;
  const trailing = text.slice((match.index ?? 0) + match[0].length).trim();
  if (trailing) {
    return { visibleText, request: null, error: "선택형 UI 요청 블록은 응답의 마지막에 있어야 합니다." };
  }
  const json = match[1]?.trim() ?? "";
  if (!json || json.length > MAX_BLOCK_LENGTH) {
    return { visibleText, request: null, error: "선택형 UI 요청의 크기가 허용 범위를 벗어났습니다." };
  }
  try {
    const request = validateRequest(JSON.parse(json));
    if (!request) {
      return { visibleText, request: null, error: "선택형 UI 요청의 질문 또는 선택지 형식이 올바르지 않습니다." };
    }
    return { visibleText, request, error: null };
  } catch {
    return { visibleText, request: null, error: "선택형 UI 요청의 JSON을 읽을 수 없습니다." };
  }
}

export function buildUserInputContinuation(answers: UserInputAnswers): string {
  return [
    "[CHATKJB_USER_INPUT]",
    "방금 요청한 선택형 질문에 사용자가 다음과 같이 답했습니다.",
    JSON.stringify({ answers }, null, 2),
    "이 답을 현재 작업의 확정 입력으로 적용하여 중단 지점부터 계속 진행하십시오.",
    "같은 결정을 다시 묻지 말고, 새롭고 중대한 선택이 실제로 필요한 경우에만 질문하십시오.",
    "[/CHATKJB_USER_INPUT]"
  ].join("\n");
}
