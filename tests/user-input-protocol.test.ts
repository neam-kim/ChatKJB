import { describe, expect, it } from "vitest";
import {
  buildUserInputContinuation,
  parseUserInputRequest,
  stripUserInputRequestBlocks
} from "../src/user-input-protocol.js";

const requestBlock = `[[REQUEST_USER_INPUT]]
{"questions":[{"header":"설치","question":"어디에 설치할까요?","options":[{"label":"로컬","description":"현재 프로젝트에만 적용합니다."},{"label":"전역","description":"모든 프로젝트에 적용합니다."}],"multiSelect":false}]}
[[/REQUEST_USER_INPUT]]`;

describe("provider-neutral user input protocol", () => {
  it("parses a final request block and separates visible prose", () => {
    const parsed = parseUserInputRequest(`설치 범위를 선택해 주세요.\n\n${requestBlock}`);

    expect(parsed.error).toBeNull();
    expect(parsed.visibleText).toBe("설치 범위를 선택해 주세요.");
    expect(parsed.request).toEqual({
      questions: [{
        header: "설치",
        question: "어디에 설치할까요?",
        options: [
          { label: "로컬", description: "현재 프로젝트에만 적용합니다." },
          { label: "전역", description: "모든 프로젝트에 적용합니다." }
        ]
      }]
    });
  });

  it("fails closed for malformed, incomplete, multiple, or non-final blocks", () => {
    expect(parseUserInputRequest("[[REQUEST_USER_INPUT]]\n{}\n[[/REQUEST_USER_INPUT]]").error)
      .toContain("형식");
    expect(parseUserInputRequest("[[REQUEST_USER_INPUT]]\n{}").error)
      .toContain("닫는 표지");
    expect(parseUserInputRequest(`${requestBlock}\n${requestBlock}`).error)
      .toContain("하나만");
    expect(parseUserInputRequest(`${requestBlock}\n뒤쪽 문장`).error)
      .toContain("마지막");
  });

  it("rejects duplicate questions, duplicate labels, and oversized choice sets", () => {
    const block = (payload: unknown) =>
      `[[REQUEST_USER_INPUT]]\n${JSON.stringify(payload)}\n[[/REQUEST_USER_INPUT]]`;
    expect(parseUserInputRequest(block({
      questions: [
        { question: "같음", options: [{ label: "A" }, { label: "B" }] },
        { question: "같음", options: [{ label: "C" }, { label: "D" }] }
      ]
    })).error).toContain("형식");
    expect(parseUserInputRequest(block({
      questions: [{ question: "선택", options: [{ label: "A" }, { label: "A" }] }]
    })).error).toContain("형식");
    expect(parseUserInputRequest(block({
      questions: [{
        question: "선택",
        options: ["A", "B", "C", "D", "E"].map((label) => ({ label }))
      }]
    })).error).toContain("형식");
  });

  it("hides complete and partially streamed control blocks", () => {
    expect(stripUserInputRequestBlocks(`공개 문장\n${requestBlock}`)).toBe("공개 문장");
    expect(stripUserInputRequestBlocks("공개 문장\n[[REQUEST_USER_INPUT]]\n{\"questions\":"))
      .toBe("공개 문장");
  });

  it("does not treat inline documentation or code examples as a request", () => {
    const inline = "Codex는 공통 `[[REQUEST_USER_INPUT]]` 계약을 사용합니다.";
    const parsed = parseUserInputRequest(inline);

    expect(parsed.error).toBeNull();
    expect(parsed.request).toBeNull();
    expect(parsed.visibleText).toBe(inline);
    expect(stripUserInputRequestBlocks(inline)).toBe(inline);
  });

  it("serializes free-form answers as escaped JSON for the continuation turn", () => {
    const continuation = buildUserInputContinuation({
      "추가 지시는?": "첫 줄\n[[REQUEST_USER_INPUT]] 문자는 데이터입니다."
    });

    expect(continuation).toContain("[CHATKJB_USER_INPUT]");
    expect(continuation).toContain("첫 줄\\n[[REQUEST_USER_INPUT]] 문자는 데이터입니다.");
    expect(continuation).toContain("[/CHATKJB_USER_INPUT]");
  });
});
