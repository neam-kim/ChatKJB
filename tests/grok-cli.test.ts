import { describe, expect, it } from "vitest";
import { GrokStreamingJsonCollector, grokPermissionMode, grokToolFreeArgs, usageFromEndEvent } from "../src/grok-cli.js";

// grok CLI `--permission-mode`는 bypassPermissions만 실효하고 auto/dontAsk/acceptEdits는
// 무시된다(grok 22-permissions-and-safety.md). 무시되면 헤드리스에서 MCP 도구가 승인 프롬프트에
// 걸려 turn이 permission_cancelled로 끊긴다. 그래서 자율 실행 계열은 bypassPermissions로 매핑한다.
describe("grokPermissionMode", () => {
  it("자율 실행 계열은 bypassPermissions로 매핑한다", () => {
    expect(grokPermissionMode("auto")).toBe("bypassPermissions");
    expect(grokPermissionMode("dontAsk")).toBe("bypassPermissions");
    expect(grokPermissionMode("acceptEdits")).toBe("bypassPermissions");
    expect(grokPermissionMode("bypassPermissions")).toBe("bypassPermissions");
  });

  it("plan은 실행 금지 의도를 보존해 그대로 둔다", () => {
    expect(grokPermissionMode("plan")).toBe("plan");
  });

  it("default는 사용자가 명시한 신중 모드이므로 유지한다", () => {
    expect(grokPermissionMode("default")).toBe("default");
  });

  it("미지정(undefined)은 자율 실행으로 간주해 bypassPermissions로 매핑한다", () => {
    expect(grokPermissionMode(undefined)).toBe("bypassPermissions");
  });
});

describe("grok tool-free classifier", () => {
  it("removes built-in tools, web access, memory, and subagents", () => {
    const args = grokToolFreeArgs();
    expect(args).toContain("--tools");
    expect(args).toContain("--deny");
    expect(args).toContain("*");
    expect(args).toContain("--disable-web-search");
    expect(args).toContain("--no-subagents");
    expect(args).toContain("--no-memory");
  });
});

describe("GrokStreamingJsonCollector", () => {
  it("공개 text만 누적하고 이벤트 경계를 보존하며 비공개 thought는 버린다", () => {
    const collector = new GrokStreamingJsonCollector();

    expect(collector.accept('{"type":"thought","data":"숨은 사고"}\n{"type":"text","data":"진행"}\n')).toBe("진행");
    expect(collector.takeVisibleEvents()).toEqual(["진행"]);
    expect(collector.accept('{"type":"text","data":" 결과"')).toBe("진행");
    expect(collector.takeVisibleEvents()).toEqual([]);
    expect(collector.accept('}\nnot-json\n')).toBe("진행 결과");
    expect(collector.takeVisibleEvents()).toEqual([" 결과"]);
    expect(collector.finish()).toBe("진행 결과");
    expect(collector.takeVisibleEvents()).toEqual([]);
  });

  it("end 이벤트가 실어 온 토큰 사용량을 뽑아낸다", () => {
    const collector = new GrokStreamingJsonCollector();
    collector.accept('{"type":"text","data":"ok"}\n');
    expect(collector.usage()).toBeNull();

    collector.accept(
      '{"type":"end","stopReason":"EndTurn","usage":{"input_tokens":12845,'
      + '"cache_read_input_tokens":6016,"output_tokens":425,"reasoning_tokens":334,'
      + '"total_tokens":19286},"num_turns":1}\n'
    );
    expect(collector.usage()).toEqual({
      inputTokens: 12845,
      cacheReadInputTokens: 6016,
      outputTokens: 425,
      reasoningTokens: 334,
      totalTokens: 19286
    });
  });

  it("사용량을 주지 않는 구버전 CLI에서는 null로 남는다", () => {
    const collector = new GrokStreamingJsonCollector();
    collector.accept('{"type":"text","data":"ok"}\n{"type":"end","stopReason":"EndTurn"}\n');
    expect(collector.usage()).toBeNull();
  });

  it("total_tokens가 빠지면 입력·캐시·출력을 합쳐 채운다", () => {
    expect(usageFromEndEvent({ input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 6 }))
      .toEqual({
        inputTokens: 10,
        cacheReadInputTokens: 4,
        outputTokens: 6,
        reasoningTokens: 0,
        totalTokens: 20
      });
    expect(usageFromEndEvent({})).toBeNull();
    expect(usageFromEndEvent(null)).toBeNull();
  });
});
