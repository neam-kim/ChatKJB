import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate
} from "@anthropic-ai/claude-agent-sdk";
import {
  InlineKeyboard,
} from "grammy";
import { randomBytes } from "node:crypto";
import { StateStore } from "./store.js";
import type { MessageTransport, SessionRecord } from "./types.js";
import type {
  UserInputAnswers,
  UserInputRequest
} from "./user-input-protocol.js";

type CanUseToolOptions = Parameters<CanUseTool>[2];

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

interface PendingApproval {
  session: SessionRecord;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
  signal: AbortSignal;
  abortHandler: () => void;
}

interface QuestionFlow {
  nonce: string;
  session: SessionRecord;
  input: Record<string, unknown>;
  questions: Question[];
  index: number;
  answers: Record<string, string | string[]>;
  selected: Set<number>;
  awaitingText: boolean;
  messageId: number | null;
  resolve: (result: PermissionResult) => void;
  timeout: NodeJS.Timeout;
  signal: AbortSignal;
  abortHandler: () => void;
}

const MAX_PREVIEW_LENGTH = 1800;

function nonce(): string {
  return randomBytes(8).toString("base64url");
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}

function describeTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash") {
    return String(input.command ?? input.description ?? JSON.stringify(input));
  }
  const path = input.file_path ?? input.path;
  if (typeof path === "string") return path;
  return JSON.stringify(input, null, 2);
}

function scopedRememberSuggestions(
  suggestions: PermissionUpdate[],
  toolName: string
): PermissionUpdate[] {
  return suggestions.flatMap((suggestion) => {
    if (suggestion.type !== "addRules" || suggestion.behavior !== "allow") return [];
    const rules = suggestion.rules.filter((rule) =>
      rule.toolName === toolName
      && typeof rule.ruleContent === "string"
      && rule.ruleContent.trim().length > 0
    );
    return rules.length > 0
      ? [{ ...suggestion, rules, destination: "session" as const }]
      : [];
  });
}

export class PermissionBroker {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, QuestionFlow>();
  private readonly questionBySession = new Map<string, string>();
  /** Optional cockpit flush when entering/leaving approval wait. */
  private progressHook: ((sessionId: string, phase: "waiting" | "resolved") => void) | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly transport: MessageTransport,
    private readonly timeoutMs: number
  ) {}

  setProgressHook(
    hook: ((sessionId: string, phase: "waiting" | "resolved") => void) | null
  ): void {
    this.progressHook = hook;
  }

  dispose(): void {
    for (const id of [...this.approvals.keys()]) {
      this.finishApproval(id, {
        behavior: "deny",
        message: "오케스트레이터가 종료되었습니다.",
        interrupt: true
      }, "expired");
    }
    for (const id of [...this.questions.keys()]) {
      this.finishQuestions(id, {
        behavior: "deny",
        message: "오케스트레이터가 종료되었습니다.",
        interrupt: true
      });
    }
  }

  async request(
    session: SessionRecord,
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions
  ): Promise<PermissionResult> {
    const current = this.store.getSession(session.id) ?? session;
    if (toolName === "AskUserQuestion") {
      return this.requestQuestions(current, input, options.signal);
    }
    return this.requestApproval(current, toolName, input, options);
  }

  async requestPlanDecision(
    session: SessionRecord,
    signal: AbortSignal
  ): Promise<{ action: "approve" | "reject" | "change"; text?: string; }> {
    const question = "이 구현 계획을 진행할까요? 수정이 필요하면 '기타-직접 입력'으로 변경 요청을 보내세요.";
    const result = await this.requestQuestions(session, {
      questions: [{
        question,
        header: "계획 승인",
        options: [{ label: "승인" }, { label: "거절" }],
        multiSelect: false
      }]
    }, signal);
    if (result.behavior === "deny") return { action: "reject" };

    const answers = (result.updatedInput?.answers ?? {}) as Record<string, string | string[]>;
    const raw = answers[question];
    const answer = Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
    if (answer === "승인") return { action: "approve" };
    if (answer === "거절") return { action: "reject" };
    return { action: "change", text: answer };
  }

  /** 제공자 중립 질문 요청을 기존 Telegram AskUserQuestion 흐름으로 처리한다. */
  async requestUserInput(
    session: SessionRecord,
    input: UserInputRequest,
    signal: AbortSignal
  ): Promise<UserInputAnswers> {
    const result = await this.requestQuestions(session, input as unknown as Record<string, unknown>, signal);
    if (result.behavior === "deny") {
      throw new Error(result.message || "사용자 선택을 받지 못했습니다.");
    }
    const answers = result.updatedInput?.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      throw new Error("사용자 선택 결과 형식을 읽을 수 없습니다.");
    }
    return answers as UserInputAnswers;
  }

  async handleCallback(data: string): Promise<string> {
    const [kind, id, action, rawIndex] = data.split(":");
    if (kind === "ap" && id && action) {
      return this.handleApprovalCallback(id, action);
    }
    if (kind === "q" && id && action) {
      return this.handleQuestionCallback(id, action, rawIndex);
    }
    return "알 수 없는 요청입니다.";
  }

  async handleTextInput(sessionId: string, text: string): Promise<boolean> {
    const id = this.questionBySession.get(sessionId);
    if (!id) return false;
    const flow = this.questions.get(id);
    if (!flow) return false;
    const question = flow.questions[flow.index];
    if (!question) return false;

    const clean = text.trim();
    if (!clean) return false;
    const selectedIndexes = this.questionOptionIndexes(question, clean);
    if (selectedIndexes.length > 0) {
      flow.answers[question.question] = question.multiSelect
        ? selectedIndexes.map((index) => question.options[index]!.label)
        : question.options[selectedIndexes[0]!]!.label;
    } else {
      flow.answers[question.question] = clean;
    }
    flow.awaitingText = false;
    flow.index += 1;
    flow.selected.clear();
    await this.advanceQuestion(flow);
    return true;
  }

  private questionOptionIndexes(question: Question, text: string): number[] {
    const indexes = new Set<number>();
    for (const match of text.matchAll(/(?:^|[^\d])(\d+)\s*번/g)) {
      const index = Number(match[1]) - 1;
      if (index >= 0 && index < question.options.length) indexes.add(index);
    }
    if (/^\d+$/.test(text)) {
      const index = Number(text) - 1;
      if (index >= 0 && index < question.options.length) indexes.add(index);
    }
    question.options.forEach((option, index) => {
      const label = option.label.trim();
      if (label && (text === label || text.includes(label))) indexes.add(index);
    });
    return [...indexes].sort((a, b) => a - b);
  }

  private async requestApproval(
    session: SessionRecord,
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions
  ): Promise<PermissionResult> {
    const id = nonce();
    const expiresAt = Date.now() + this.timeoutMs;
    const suggestions = options.suggestions ?? [];
    const rememberSuggestions = scopedRememberSuggestions(suggestions, toolName);
    const canRemember = toolName !== "Bash" && rememberSuggestions.length > 0;
    const keyboard = new InlineKeyboard()
      .text("허용", `ap:${id}:a`)
      .text("거부", `ap:${id}:d`);
    if (canRemember) keyboard.row().text("이 세션에서 항상 허용", `ap:${id}:s`);

    const title = options.title ?? `[APPROVAL] ${toolName}`;
    const detail = truncate(describeTool(toolName, input), MAX_PREVIEW_LENGTH);
    const messageId = await this.transport.sendText(
      session.chatId,
      session.topicId,
      `${title}\n\n${detail}\n\n30분 이내에 선택하세요.`,
      keyboard
    );

    this.store.updateSession(session.id, { status: "waiting_approval" });
    this.progressHook?.(session.id, "waiting");
    this.store.createApproval({
      nonce: id,
      toolUseId: options.toolUseID,
      sessionId: session.id,
      toolName,
      input,
      suggestions,
      status: "pending",
      expiresAt,
      messageId
    });

    return new Promise<PermissionResult>((resolve) => {
      const abortHandler = () => this.finishApproval(id, {
        behavior: "deny",
        message: "세션이 중단되었습니다.",
        interrupt: true
      }, "expired");
      options.signal.addEventListener("abort", abortHandler, { once: true });
      const timeout = setTimeout(() => {
        void this.transport.editText(
          session.chatId,
          messageId,
          `[EXPIRED] ${toolName}\n\n${detail}`
        ).catch(() => undefined);
        this.finishApproval(id, {
          behavior: "deny",
          message: "사용자 승인 시간이 만료되었습니다."
        }, "expired");
      }, this.timeoutMs);

      this.approvals.set(id, {
        session,
        input,
        resolve,
        timeout,
        signal: options.signal,
        abortHandler
      });
    });
  }

  private async handleApprovalCallback(id: string, action: string): Promise<string> {
    const pending = this.approvals.get(id);
    const record = this.store.getApproval(id);
    if (!pending || !record || record.status !== "pending") {
      return "이미 처리되었거나 만료된 요청입니다.";
    }

    if (action === "d") {
      this.finishApproval(id, { behavior: "deny", message: "사용자가 거부했습니다." }, "denied");
      await this.transport.editText(
        pending.session.chatId,
        record.messageId ?? 0,
        `[DENIED] ${record.toolName}\n\n${truncate(describeTool(record.toolName, record.input), MAX_PREVIEW_LENGTH)}`
      ).catch(() => undefined);
      return "거부했습니다.";
    }

    const remember = action === "s";
    const updatedPermissions = remember
      ? scopedRememberSuggestions(record.suggestions, record.toolName)
      : [];
    if (remember && updatedPermissions.length === 0) {
      return "범위가 지정된 허용 규칙이 없어 세션 허용을 적용할 수 없습니다.";
    }
    const result: PermissionResult = {
      behavior: "allow",
      updatedInput: pending.input,
      ...(updatedPermissions.length > 0
        ? { updatedPermissions }
        : {})
    };
    this.finishApproval(id, result, "allowed");
    await this.transport.editText(
      pending.session.chatId,
      record.messageId ?? 0,
      `[ALLOWED${remember ? " FOR SESSION" : ""}] ${record.toolName}\n\n${truncate(describeTool(record.toolName, record.input), MAX_PREVIEW_LENGTH)}`
    ).catch(() => undefined);
    return remember ? "이 세션에서 계속 허용합니다." : "허용했습니다.";
  }

  private finishApproval(
    id: string,
    result: PermissionResult,
    status: "allowed" | "denied" | "expired"
  ): void {
    const pending = this.approvals.get(id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.abortHandler);
    this.approvals.delete(id);
    this.store.updateApproval(id, status);
    if (!(result.behavior === "deny" && result.interrupt)) {
      this.store.updateSession(pending.session.id, { status: "running" });
    }
    this.progressHook?.(pending.session.id, "resolved");
    pending.resolve(result);
  }

  private async requestQuestions(
    session: SessionRecord,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    const questions = this.parseQuestions(input);
    if (questions.length === 0) {
      return { behavior: "deny", message: "질문 형식을 읽을 수 없습니다." };
    }
    if (this.questionBySession.has(session.id)) {
      return { behavior: "deny", message: "이 세션에는 이미 응답을 기다리는 질문이 있습니다." };
    }
    const id = nonce();

    return new Promise<PermissionResult>((resolve) => {
      const abortHandler = () => this.finishQuestions(id, {
        behavior: "deny",
        message: "세션이 중단되었습니다.",
        interrupt: true
      });
      signal.addEventListener("abort", abortHandler, { once: true });
      const timeout = setTimeout(() => {
        this.finishQuestions(id, {
          behavior: "deny",
          message: "사용자 응답 시간이 만료되었습니다."
        });
      }, this.timeoutMs);
      const flow: QuestionFlow = {
        nonce: id,
        session,
        input,
        questions,
        index: 0,
        answers: {},
        selected: new Set(),
        awaitingText: false,
        messageId: null,
        resolve,
        timeout,
        signal,
        abortHandler
      };
      this.questions.set(id, flow);
      this.questionBySession.set(session.id, id);
      this.store.updateSession(session.id, { status: "waiting_approval" });
      this.progressHook?.(session.id, "waiting");
      void this.advanceQuestion(flow).catch((error: unknown) => {
        this.finishQuestions(id, {
          behavior: "deny",
          message: `질문 전송 실패: ${String(error)}`
        });
      });
    });
  }

  private parseQuestions(input: Record<string, unknown>): Question[] {
    if (!Array.isArray(input.questions)) return [];
    return input.questions.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const raw = value as Record<string, unknown>;
      if (typeof raw.question !== "string" || !Array.isArray(raw.options)) return [];
      const options = raw.options.flatMap((option) => {
        if (!option || typeof option !== "object") return [];
        const item = option as Record<string, unknown>;
        if (typeof item.label !== "string") return [];
        return [{
          label: item.label,
          ...(typeof item.description === "string" ? { description: item.description } : {})
        }];
      });
      return [{
        question: raw.question,
        ...(typeof raw.header === "string" ? { header: raw.header } : {}),
        options,
        multiSelect: raw.multiSelect === true
      }];
    });
  }

  private questionKeyboard(flow: QuestionFlow): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    const question = flow.questions[flow.index];
    if (!question) return keyboard;
    question.options.forEach((option, index) => {
      const selected = flow.selected.has(index) ? "[선택] " : "";
      keyboard.text(`${selected}${option.label}`, `q:${flow.nonce}:o:${index}`).row();
    });
    keyboard.text("기타-직접 입력", `q:${flow.nonce}:t`);
    if (question.multiSelect) keyboard.text("선택 완료", `q:${flow.nonce}:d`);
    return keyboard;
  }

  private questionText(flow: QuestionFlow): string {
    const question = flow.questions[flow.index];
    if (!question) return "";
    const descriptions = question.options
      .map((option, index) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`)
      .join("\n");
    return `[QUESTION ${flow.index + 1}/${flow.questions.length}] ${question.header ?? ""}\n${question.question}\n\n${descriptions}`;
  }

  private async advanceQuestion(flow: QuestionFlow): Promise<void> {
    if (flow.index >= flow.questions.length) {
      this.finishQuestions(flow.nonce, {
        behavior: "allow",
        updatedInput: {
          questions: flow.input.questions,
          answers: flow.answers
        }
      });
      return;
    }

    const text = this.questionText(flow);
    const keyboard = this.questionKeyboard(flow);
    if (flow.messageId === null) {
      flow.messageId = await this.transport.sendText(
        flow.session.chatId,
        flow.session.topicId,
        text,
        keyboard
      );
    } else {
      await this.transport.editText(flow.session.chatId, flow.messageId, text, keyboard);
    }
  }

  private async handleQuestionCallback(
    id: string,
    action: string,
    rawIndex?: string
  ): Promise<string> {
    const flow = this.questions.get(id);
    if (!flow) return "이미 처리되었거나 만료된 질문입니다.";
    const question = flow.questions[flow.index];
    if (!question) return "질문 상태가 올바르지 않습니다.";

    if (action === "t") {
      flow.awaitingText = true;
      if (flow.messageId !== null) {
        await this.transport.editText(
          flow.session.chatId,
          flow.messageId,
          `${this.questionText(flow)}\n\n이 토픽에 직접 답변을 입력하세요.`
        );
      }
      return "직접 답변을 기다립니다.";
    }

    if (action === "o") {
      const index = Number(rawIndex);
      const option = question.options[index];
      if (!option) return "선택지가 올바르지 않습니다.";
      if (question.multiSelect) {
        flow.selected.has(index) ? flow.selected.delete(index) : flow.selected.add(index);
        if (flow.messageId !== null) {
          await this.transport.editText(
            flow.session.chatId,
            flow.messageId,
            this.questionText(flow),
            this.questionKeyboard(flow)
          );
        }
        return "선택 상태를 갱신했습니다.";
      }
      flow.answers[question.question] = option.label;
      flow.index += 1;
      flow.selected.clear();
      await this.advanceQuestion(flow);
      return "선택했습니다.";
    }

    if (action === "d" && question.multiSelect) {
      if (flow.selected.size === 0) return "하나 이상 선택하세요.";
      flow.answers[question.question] = [...flow.selected]
        .sort((a, b) => a - b)
        .map((index) => question.options[index]?.label)
        .filter((label): label is string => Boolean(label));
      flow.index += 1;
      flow.selected.clear();
      await this.advanceQuestion(flow);
      return "선택을 완료했습니다.";
    }

    return "알 수 없는 선택입니다.";
  }

  private finishQuestions(id: string, result: PermissionResult): void {
    const flow = this.questions.get(id);
    if (!flow) return;
    clearTimeout(flow.timeout);
    flow.signal.removeEventListener("abort", flow.abortHandler);
    this.questions.delete(id);
    this.questionBySession.delete(flow.session.id);
    if (!(result.behavior === "deny" && result.interrupt)) {
      this.store.updateSession(flow.session.id, { status: "running" });
    }
    this.progressHook?.(flow.session.id, "resolved");
    if (result.behavior === "allow") {
      void this.transport.sendText(
        flow.session.chatId,
        flow.session.topicId,
        "[PROGRESS] 선택을 받았습니다. 작업을 계속합니다."
      ).then((messageId) => {
        console.log(
          `[telegram] session=${flow.session.id} question-resumed delivered message=${messageId}`
        );
      }).catch((error: unknown) => {
        console.error(
          `[telegram] session=${flow.session.id} question-resumed delivery failed: ${String(error)}`
        );
      });
    }
    flow.resolve(result);
  }
}
