import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;

const serverName = "chatkjb_qwen_subagent";
const apiKey = process.env.DASHSCOPE_API_KEY?.trim();
const baseUrl = (process.env.DASHSCOPE_BASE_URL?.trim()
  || "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
const model = process.env.CHATKJB_QWEN_SUBAGENT_MODEL?.trim() || "qwen3.8-max";

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
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: "You are a delegated analysis subagent. Complete only the requested bounded task. You cannot access local files or external tools; rely solely on the supplied context. Return concise findings, assumptions, and any uncertainty for the parent agent."
          },
          {
            role: "user",
            content: context ? `Task:\n${task}\n\nContext supplied by parent:\n${context}` : `Task:\n${task}`
          }
        ]
      })
    });
    if (!response.ok) {
      toolError(id, `Qwen 하위 작업 요청이 실패했습니다 (HTTP ${response.status}).`);
      return;
    }
    const body = await response.json() as JsonRecord;
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0] as JsonRecord | undefined;
    const message = first && typeof first.message === "object" && first.message !== null
      ? first.message as JsonRecord
      : {};
    const content = asString(message.content);
    if (!content) {
      toolError(id, "Qwen 하위 작업이 비어 있는 응답을 반환했습니다.");
      return;
    }
    result(id, { content: [{ type: "text", text: content }] });
  } catch {
    toolError(id, "Qwen 하위 작업 서버에 연결할 수 없습니다.");
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
      result(id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: "1.0.0" }
      });
      return;
    }
    if (request.method === "notifications/initialized") return;
    if (request.method === "tools/list") {
      result(id, {
        tools: [{
          name: "delegate",
          description: "Delegate a bounded analysis task to Qwen. Supply essential repository or document context because Qwen has no direct local tool access.",
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
