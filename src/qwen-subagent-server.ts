import { createInterface } from "node:readline";
import { constants as fsConstants } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

const serverName = "chatkjb_qwen_subagent";
const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
const baseUrl = (process.env.DASHSCOPE_BASE_URL?.trim()
  || "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
// Token Plan의 이전 기본값 qwen3.8-max는 더 이상 제공되지 않아 404를 반환한다.
// 정상 경로는 선택 모델을 항상 넘기며, 누락 시에도 현재 지원되는 모델로 안전하게 복구한다.
const model = process.env.CHATKJB_QWEN_SUBAGENT_MODEL?.trim() || "qwen3.8-max-preview";
// 부모 에이전트가 넘겨준 세션 작업 디렉터리. 로컬 파일 도구는 이 루트 안에서만 동작한다.
const requestedCwd = process.env.CHATKJB_QWEN_SUBAGENT_CWD?.trim();

// 파일 도구 안전 상한 — 모델·모델이 준 인자는 모두 신뢰하지 않는다.
const MAX_TOOL_ROUNDS = 8;
const MAX_TOOL_CALLS_TOTAL = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_FILES = 800;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_PATTERN_LENGTH = 256;
const IGNORED_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".cache", ".turbo"]);

function send(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: unknown, value: JsonRecord): void {
  send({ jsonrpc: "2.0", id, result: value });
}

function toolError(id: unknown, message: string): void {
  result(id, { content: [{ type: "text", text: message }], isError: true });
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 루트를 한 번만 canonicalize한다. 존재하지 않으면 파일 도구는 비활성(fail-closed). */
let rootReal: string | null = null;
let rootResolved: Promise<string | null> | null = null;
async function resolveRoot(): Promise<string | null> {
  // initialize와 tools/list가 순서 뒤바뀌어 와도 같은 계산을 공유해 레이스를 막는다.
  rootResolved ??= (async () => {
    if (!requestedCwd) return null;
    try {
      const real = await realpath(resolve(requestedCwd));
      const info = await stat(real);
      return info.isDirectory() ? real : null;
    } catch {
      return null;
    }
  })();
  rootReal = await rootResolved;
  return rootReal;
}

class ToolInputError extends Error {}

/** 사용자가 준 상대경로를 root 안으로만 해석한다. 절대경로·traversal·제어문자는 거부. */
function resolveWithinRoot(root: string, input: unknown): string {
  const raw = asString(input);
  if (!raw) throw new ToolInputError("path는 비어 있지 않은 문자열이어야 합니다.");
  if (raw.length > MAX_PATH_LENGTH) throw new ToolInputError("path가 너무 깁니다.");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(raw)) throw new ToolInputError("path에 제어 문자를 포함할 수 없습니다.");
  if (isAbsolute(raw)) throw new ToolInputError("절대경로는 허용되지 않습니다. 루트 기준 상대경로를 사용하세요.");
  const target = resolve(root, raw);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
    throw new ToolInputError("작업 디렉터리 밖 경로에는 접근할 수 없습니다.");
  }
  return target;
}

/** 최종 경로를 realpath로 다시 확인해 symlink 탈출을 막는다. */
async function assertRealpathWithinRoot(root: string, target: string): Promise<string> {
  const real = await realpath(target);
  const rel = relative(root, real);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
    throw new ToolInputError("심볼릭 링크가 작업 디렉터리 밖을 가리켜 접근을 거부했습니다.");
  }
  return real;
}

function looksBinary(buffer: Buffer): boolean {
  const scan = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of scan) if (byte === 0) return true;
  return false;
}

async function readFileTool(root: string, args: JsonRecord): Promise<string> {
  const target = resolveWithinRoot(root, args.path);
  const info = await stat(target);
  if (info.isDirectory()) throw new ToolInputError("경로가 디렉터리입니다. list_files를 사용하세요.");
  await assertRealpathWithinRoot(root, target);
  // O_NOFOLLOW로 최종 경로 요소가 symlink면 열기를 거부한다.
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ToolInputError("심볼릭 링크 파일은 열 수 없습니다.");
    }
    throw error;
  });
  try {
    const bytesToRead = Math.min(info.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    await handle.read(buffer, 0, bytesToRead, 0);
    if (looksBinary(buffer)) {
      return `[바이너리 파일: 내용 생략] size=${info.size} bytes`;
    }
    const truncated = info.size > MAX_FILE_BYTES;
    const text = buffer.toString("utf8");
    return truncated
      ? `${text}\n\n[...파일이 ${info.size} bytes로 커서 앞 ${MAX_FILE_BYTES} bytes만 표시했습니다.]`
      : text;
  } finally {
    await handle.close();
  }
}

async function listFilesTool(root: string, args: JsonRecord): Promise<string> {
  const dirArg = asString(args.path) ?? asString(args.dir) ?? ".";
  const target = resolveWithinRoot(root, dirArg);
  const info = await stat(target);
  if (!info.isDirectory()) throw new ToolInputError("경로가 디렉터리가 아닙니다.");
  await assertRealpathWithinRoot(root, target);
  const entries = await readdir(target, { withFileTypes: true });
  const lines: string[] = [];
  for (const entry of entries) {
    if (lines.length >= MAX_LIST_ENTRIES) {
      lines.push(`[...항목이 많아 ${MAX_LIST_ENTRIES}개까지만 표시했습니다.]`);
      break;
    }
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    lines.push(entry.isDirectory() ? `${entry.name}/` : entry.name);
  }
  return lines.length ? lines.join("\n") : "(빈 디렉터리)";
}

async function collectFiles(root: string, dir: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_SEARCH_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_SEARCH_FILES) return;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await collectFiles(root, join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(join(dir, entry.name));
    }
  }
}

async function searchFilesTool(root: string, args: JsonRecord): Promise<string> {
  const pattern = asString(args.pattern);
  if (!pattern) throw new ToolInputError("pattern은 비어 있지 않은 문자열이어야 합니다.");
  if (pattern.length > MAX_PATTERN_LENGTH) throw new ToolInputError("pattern이 너무 깁니다.");
  const dirArg = asString(args.path) ?? asString(args.dir) ?? ".";
  const base = resolveWithinRoot(root, dirArg);
  const baseInfo = await stat(base);
  if (!baseInfo.isDirectory()) throw new ToolInputError("검색 시작 경로가 디렉터리가 아닙니다.");
  await assertRealpathWithinRoot(root, base);
  // ReDoS·과도한 스캔을 피하려고 임의 정규식이 아니라 대소문자 무시 리터럴 부분 문자열로 검색한다.
  const needle = pattern.toLowerCase();
  const files: string[] = [];
  await collectFiles(root, base, files);
  const matches: string[] = [];
  let scannedTruncated = files.length >= MAX_SEARCH_FILES;
  for (const file of files) {
    if (matches.length >= MAX_SEARCH_MATCHES) break;
    let info;
    try {
      info = await stat(file);
    } catch {
      continue;
    }
    if (info.size > MAX_SEARCH_FILE_BYTES) continue;
    let handle;
    try {
      handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch {
      continue;
    }
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_SEARCH_FILE_BYTES));
      await handle.read(buffer, 0, buffer.length, 0);
      if (looksBinary(buffer)) continue;
      const rel = relative(root, file);
      const lines = buffer.toString("utf8").split("\n");
      for (const [i, lineText] of lines.entries()) {
        if (lineText.toLowerCase().includes(needle)) {
          matches.push(`${rel}:${i + 1}: ${lineText.trim().slice(0, 200)}`);
          if (matches.length >= MAX_SEARCH_MATCHES) break;
        }
      }
    } finally {
      await handle.close();
    }
  }
  if (!matches.length) return scannedTruncated
    ? "매치 없음 (스캔 파일 수 상한에 도달해 일부만 검색했습니다)."
    : "매치 없음.";
  const header = matches.length >= MAX_SEARCH_MATCHES ? `[상위 ${MAX_SEARCH_MATCHES}개 매치만 표시]\n` : "";
  return header + matches.join("\n");
}

interface ToolSpec {
  run: (root: string, args: JsonRecord) => Promise<string>;
}

const TOOLS: Record<string, ToolSpec> = {
  read_file: { run: readFileTool },
  list_files: { run: listFilesTool },
  search_files: { run: searchFilesTool }
};

const localToolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file within the session working directory. Use a path relative to the working directory root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path relative to the working directory root." } },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List entries of a directory within the session working directory. Directories end with '/'.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path relative to root. Defaults to '.'" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Case-insensitive substring search across text files under a directory. Returns path:line: match lines.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Literal substring to search for." },
          path: { type: "string", description: "Directory to search under, relative to root. Defaults to '.'" }
        },
        required: ["pattern"]
      }
    }
  }
];

async function runLocalTool(root: string, name: string, rawArgs: string): Promise<string> {
  const spec = TOOLS[name];
  if (!spec) return `오류: 알 수 없는 도구 '${name}'.`;
  let args: JsonRecord;
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : {};
    args = typeof parsed === "object" && parsed !== null ? parsed as JsonRecord : {};
  } catch {
    return "오류: 도구 인자 JSON을 파싱할 수 없습니다.";
  }
  try {
    return await spec.run(root, args);
  } catch (error) {
    if (error instanceof ToolInputError) return `오류: ${error.message}`;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "오류: 경로를 찾을 수 없습니다.";
    if (code === "EACCES") return "오류: 접근 권한이 없습니다.";
    return "오류: 파일 도구 실행 중 문제가 발생했습니다.";
  }
}

type ChatMessage = JsonRecord;

async function callModel(messages: ChatMessage[], useTools: boolean): Promise<JsonRecord> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      ...(useTools ? { tools: localToolDefinitions } : {})
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.json() as JsonRecord;
}

async function delegate(id: unknown, params: JsonRecord): Promise<void> {
  if (!apiKey) {
    toolError(id, "Qwen 하위 작업을 실행할 수 없습니다. DASHSCOPE_API_KEY가 설정되지 않았습니다.");
    return;
  }
  const argumentsValue = params.arguments;
  const argumentsRecord = typeof argumentsValue === "object" && argumentsValue !== null
    ? argumentsValue as JsonRecord
    : {};
  const task = asString(argumentsRecord.task);
  const context = asString(argumentsRecord.context);
  if (!task) {
    toolError(id, "task는 비어 있지 않은 문자열이어야 합니다.");
    return;
  }
  if (task.length > 60_000 || (context?.length ?? 0) > 120_000) {
    toolError(id, "Qwen 하위 작업 입력이 너무 큽니다. 핵심 요청과 필요한 맥락만 전달하십시오.");
    return;
  }

  const toolsEnabled = (await resolveRoot()) !== null;
  const systemPrompt = toolsEnabled
    ? "You are a delegated analysis subagent for a bounded task. You have read-only local tools "
      + "(read_file, list_files, search_files) scoped to the session working directory; use them to "
      + "inspect the repository yourself instead of relying only on supplied context. Paths are relative "
      + "to the working directory root. When you have enough evidence, stop calling tools and return "
      + "concise findings, assumptions, and any uncertainty for the parent agent."
    : "You are a delegated analysis subagent. Complete only the requested bounded task. You cannot access "
      + "local files or external tools; rely solely on the supplied context. Return concise findings, "
      + "assumptions, and any uncertainty for the parent agent.";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: context ? `Task:\n${task}\n\nContext supplied by parent:\n${context}` : `Task:\n${task}`
    }
  ];

  try {
    let toolCallsUsed = 0;
    const seenCalls = new Set<string>();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const body = await callModel(messages, toolsEnabled);
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first = choices[0] as JsonRecord | undefined;
      const message = first && typeof first.message === "object" && first.message !== null
        ? first.message as JsonRecord
        : {};
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as JsonRecord[] : [];

      if (!toolsEnabled || toolCalls.length === 0) {
        const content = asString(message.content);
        if (!content) {
          toolError(id, "Qwen 하위 작업이 비어 있는 응답을 반환했습니다.");
          return;
        }
        result(id, { content: [{ type: "text", text: content }] });
        return;
      }

      // 모델의 tool_calls를 되먹이려면 assistant 메시지를 그대로 대화에 추가해야 한다.
      messages.push(message);
      for (const call of toolCalls) {
        const callId = asString(call.id) ?? `call_${round}_${toolCallsUsed}`;
        const fn = typeof call.function === "object" && call.function !== null
          ? call.function as JsonRecord
          : {};
        const name = asString(fn.name) ?? "";
        const rawArgs = typeof fn.arguments === "string" ? fn.arguments : "";
        let output: string;
        if (toolCallsUsed >= MAX_TOOL_CALLS_TOTAL) {
          output = "오류: 도구 호출 상한에 도달했습니다. 지금까지의 근거로 최종 답변을 작성하세요.";
        } else {
          const dedupeKey = `${name} ${rawArgs}`;
          if (seenCalls.has(dedupeKey)) {
            output = "오류: 동일한 도구 호출이 반복되었습니다. 다른 조사를 하거나 최종 답변을 작성하세요.";
          } else {
            seenCalls.add(dedupeKey);
            toolCallsUsed += 1;
            output = await runLocalTool(rootReal as string, name, rawArgs);
          }
        }
        messages.push({ role: "tool", tool_call_id: callId, content: output.slice(0, 40_000) });
      }
    }

    // 라운드 상한 도달 — 도구 없이 마지막으로 최종 답변을 강제한다.
    messages.push({
      role: "user",
      content: "도구 호출 상한에 도달했습니다. 추가 도구 없이 지금까지의 근거로 최종 답변을 작성하세요."
    });
    const finalBody = await callModel(messages, false);
    const finalChoices = Array.isArray(finalBody.choices) ? finalBody.choices : [];
    const finalMessage = finalChoices[0] && typeof (finalChoices[0] as JsonRecord).message === "object"
      ? (finalChoices[0] as JsonRecord).message as JsonRecord
      : {};
    const finalContent = asString(finalMessage.content);
    if (!finalContent) {
      toolError(id, "Qwen 하위 작업이 비어 있는 응답을 반환했습니다.");
      return;
    }
    result(id, { content: [{ type: "text", text: finalContent }] });
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith("HTTP ")
      ? ` (${error.message})`
      : "";
    toolError(id, `Qwen 하위 작업 요청이 실패했습니다${detail}.`);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  void (async () => {
    let request: JsonRecord;
    try {
      request = JSON.parse(line) as JsonRecord;
    } catch {
      return;
    }
    const id = request.id;
    if (request.method === "initialize") {
      rootReal = await resolveRoot();
      result(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1.1.0" }
      });
      return;
    }
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") {
      const toolsNote = await resolveRoot()
        ? " Qwen inspects the repository itself with read-only file tools; supply only the extra context it cannot read."
        : " Qwen has no direct local tool access; supply essential repository or document context.";
      result(id, {
        tools: [{
          name: "delegate",
          description: `Delegate a bounded analysis task to Qwen.${toolsNote}`,
          inputSchema: {
            type: "object",
            properties: {
              task: { type: "string", description: "Bounded task for Qwen." },
              context: { type: "string", description: "Essential text, code, or findings supplied by the parent." }
            },
            required: ["task"],
            additionalProperties: false
          }
        }]
      });
      return;
    }
    if (request.method === "tools/call") {
      await delegate(id, typeof request.params === "object" && request.params !== null
        ? request.params as JsonRecord
        : {});
      return;
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  })();
});
