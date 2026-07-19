import { describe, expect, it } from "vitest";
import {
  buildWorkflowSkillPrompt,
  bundledWorkflowSkillPath,
  workflowStateRoot
} from "../src/workflow-skills.js";

describe("ChatKJB workflow skill routing", () => {
  it("builds a session-scoped state path without traversal segments", () => {
    expect(workflowStateRoot("../../session:42", "deep-interview"))
      .toBe(".chatkjb/workflows/session-42/deep-interview");
  });

  it("points the provider at the bundled skill and preserves user text as JSON", () => {
    const prompt = buildWorkflowSkillPrompt(
      "ralplan",
      "인증 흐름을 검토해줘\n기존 API는 유지",
      "session-1"
    );

    expect(prompt).toContain(`Skill source: ${bundledWorkflowSkillPath("ralplan")}`);
    expect(prompt).toContain("State root: .chatkjb/workflows/session-1/ralplan");
    expect(prompt).toContain('"request": "인증 흐름을 검토해줘\\n기존 API는 유지"');
    expect(prompt).toContain("untrusted user input");
  });
});
