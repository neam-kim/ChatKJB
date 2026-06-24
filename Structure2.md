ChatKJB_Orchestration_section_Structure:

  Core_Principles:
    - "Frontier model은 일꾼이 아니라 판관으로 사용한다."
    - "Local model은 설계자가 아니라 계약 이행자로 사용한다."
    - "Deterministic tools가 확인할 수 있는 사실은 LLM에게 추측시키지 않는다."
    - "긴 컨텍스트는 raw dump가 아니라 review packet / task packet 형태로 압축해 전달한다."
    - "모든 모델 호출은 allowed scope, forbidden changes, expected output을 포함해야 한다."
    - "상위 모델은 decomposition, contract, risk, checkpoint, final review에 집중한다."
    - "반복 구현, 테스트 실행, 로그 요약, diff 정리는 로컬/저가 모델에 위임한다."

  Tier_0_Deterministic_Tools:
    Role: "ground truth extraction / validation"
    Tools:
      - ripgrep
      - tree-sitter / AST parser
      - type checker
      - test runner
      - formatter
      - linter
      - coverage
      - dependency graph
    Responsibilities:
      - "관련 파일 후보 추출"
      - "symbol / function / class 위치 파악"
      - "dependency 관계 파악"
      - "type error 수집"
      - "test failure 수집"
      - "lint / formatting issue 수집"
      - "coverage gap 확인"
      - "변경 전후 diff 검증"
    Rules:
      - "LLM 작업 전 반드시 관련 근거를 수집한다."
      - "테스트, 타입체크, 린트 결과는 모델 판단보다 우선한다."
      - "모델에게 raw repo 전체를 주기 전에 deterministic evidence를 먼저 만든다."

  Tier_1_Low_Cost_Local_Model:
    Model: "gemma4:e4b-64k"
    Role: "assistant clerk / summarizer / classifier"
    Responsibilities:
      - log_summary
      - diff_summary
      - progress_report
      - retrieval_ranking
      - failure_clustering
      - changed_file_inventory
    Allowed:
      - "테스트 실패 로그 요약"
      - "diff 변경 파일 목록 정리"
      - "변경 라인/파일 수 집계"
      - "retrieval candidate 순위 초안 생성"
      - "진척 보고서 초안 작성"
      - "반복 로그 압축"
    Forbidden:
      - "root cause 최종 판단"
      - "architecture recommendation"
      - "public API 변경 제안"
      - "test failure 해결 전략 최종 결정"
      - "task contract 수정"
      - "risk level 상향/하향 최종 결정"
    Output_Format:
      - "요약"
      - "근거 파일/라인 포인터"
      - "불확실성 표시"
      - "원문 로그 위치"

  Tier_2_Long_Context_Analyst:
    Model: "qwen3.6-27b-96k"
    Role: "long-context analyst / requirement digester / documentation writer"
    Responsibilities:
      - long_context_reading
      - requirement_digestion
      - large_file_summary
      - documentation
      - bilingual_explanation
      - review_packet_drafting
    Allowed:
      - "긴 문서와 대형 파일 요약"
      - "요구사항 정리"
      - "한국어/영어 설명 작성"
      - "작업 배경 정리"
      - "Opus/GPT-5.5용 review packet 초안 작성"
      - "qwen3-coder용 task context 정리"
    Forbidden:
      - "최종 아키텍처 결정"
      - "위험도 최종 판정"
      - "checkpoint 승인"
      - "task contract 임의 변경"
      - "허용 파일 범위 확장"
    Notes:
      - "의미 이해와 문맥 압축에 사용한다."
      - "반복적인 로그/포맷 정리는 Tier 1 또는 deterministic tools에 우선 위임한다."

  Tier_3_Local_Coding_Worker:
    Model: "qwen3-coder:30b-96k"
    Role: "implementation worker / test generator / local repair agent"
    Responsibilities:
      - implementation
      - test_generation
      - local_refactor
      - CLI_driven_repair
    Allowed:
      - "명시된 파일 내 구현"
      - "테스트 작성"
      - "소규모 리팩터링"
      - "타입 오류 수정"
      - "테스트 실패 로그 기반 수정"
      - "CLI 도구 결과에 따른 반복 수리"
    Forbidden:
      - "아키텍처 재설계"
      - "public API 변경"
      - "dependency 추가"
      - "database schema 변경"
      - "허용되지 않은 파일 수정"
      - "관련 없는 리팩터링"
      - "task contract 재해석"
    Required_Input:
      - task_contract
      - allowed_files
      - forbidden_changes
      - relevant_context
      - expected_tests
      - diff_budget
    Required_Output:
      - changed_files
      - summary_of_changes
      - tests_added_or_updated
      - commands_run
      - remaining_blockers
      - diff
    Guardrails:
      - "허용 파일 외 수정 금지"
      - "문제 해결이 허용 범위를 벗어나면 중단하고 blocker 보고"
      - "최소 diff 원칙 준수"
      - "테스트 없이 완료 선언 금지"

  Tier_4a_Cheap_Cleanup_Model:
    Models:
      - "GPT-4o mini"
      - "other cheap cleanup model"
    Role: "low-cost cleanup / formatting / report polish"
    Responsibilities:
      - style_normalization
      - formatting
      - simple_cleanup
      - changelog_draft
      - progress_report_polish
      - simple_doc_rewrite
    Allowed:
      - "표현 정리"
      - "문서 포맷 정리"
      - "간단한 코드 스타일 정리"
      - "진척 보고서 정리"
      - "changelog 초안 작성"
    Forbidden:
      - "bug fix"
      - "test failure repair"
      - "아키텍처 변경"
      - "public API 변경"
      - "로직 변경"
      - "task contract 변경"

  Tier_4b_Strong_Maintainer:
    Models:
      - "Sonnet"
      - "GPT-5.4 mini"
    Role: "senior maintainer / patch normalizer / repair agent"
    Responsibilities:
      - bug_fix
      - test_repair
      - minimal_diff_rewrite
      - regression_repair
      - patch_normalization
      - style_normalization_when_contextual
    Allowed:
      - "테스트 실패 수리"
      - "bug fix"
      - "과도한 diff 축소"
      - "edge case 보완"
      - "로컬 모델 patch 정리"
      - "style과 implementation consistency 조정"
    Forbidden:
      - "아키텍처 재설계"
      - "task contract 변경"
      - "public API 변경"
      - "dependency graph 변경"
      - "허용 범위 외 파일 수정"
      - "요구사항 재해석"
      - "새 abstraction 도입"
    Required_Input:
      - original_task_contract
      - local_model_diff
      - test_result_summary
      - allowed_files
      - forbidden_changes
      - diff_budget
    Required_Output:
      - normalized_patch
      - reasoning_summary
      - tests_to_rerun
      - remaining_risks
    Rules:
      - "설계자가 아니라 수정자로 동작한다."
      - "Opus/GPT-5.5의 task contract 안에서만 수정한다."
      - "가능한 한 작은 diff로 수리한다."

  Tier_5_Frontier_Architect_Reviewer:
    Models:
      - "Opus4.8"
      - "GPT-5.5"
    Role: "architect / planner / judge"
    Responsibilities:
      - decomposition
      - task_contract
      - risk_classification
      - checkpoint_review
      - final_architecture_review
    Allowed:
      - "전체 목표 분석"
      - "작업 DAG 생성"
      - "작업 단위 분해"
      - "task contract 작성"
      - "risk level 판정"
      - "checkpoint 승인/반려"
      - "아키텍처 일관성 검토"
      - "최종 merge 가능성 판단"
    Forbidden:
      - "반복 구현 루프 직접 수행"
      - "단순 로그 요약"
      - "단순 포맷 정리"
      - "매번 raw 96k context 직접 처리"
    Required_Input:
      - frontier_review_packet
    Required_Output:
      - decision
      - approved_or_rejected
      - required_changes
      - risk_level
      - next_task_contracts
      - architectural_notes
    Rules:
      - "raw context 대신 압축된 review packet을 받는다."
      - "구현자가 아니라 판관으로 사용한다."
      - "모든 checkpoint에서 continue / redirect / rollback 중 하나를 결정한다."

  Checkpoints:
    0_Plan_Approval:
      Owner: "Tier 5"
      Purpose:
        - "작업 분해 승인"
        - "task contract 검토"
        - "risk classification"
        - "allowed_files / forbidden_changes 확정"
        - "local model에 위임 가능한 크기인지 확인"
      Required_Artifacts:
        - original_goal
        - proposed_task_DAG
        - task_contracts
        - risk_level
        - allowed_files
        - forbidden_changes
        - expected_tests

    1_First_Vertical_Slice:
      Owner: "Tier 5"
      Purpose:
        - "핵심 경로 하나가 end-to-end로 동작하는지 확인"
        - "추상화 방향 검증"
        - "초기 설계 오류 조기 탐지"
      Required_Artifacts:
        - vertical_slice_diff
        - test_result_summary
        - implementation_summary
        - blockers
        - review_questions
      Rules:
        - "이 checkpoint는 생략하지 않는다."
        - "비용을 줄여야 한다면 midpoint보다 이 checkpoint를 우선한다."

    2_Midpoint_Integration:
      Owner: "Tier 5 or Tier 4b depending on risk"
      Purpose:
        - "모듈 간 연결 검증"
        - "기존 API 보존 확인"
        - "local model이 범위를 넘지 않았는지 확인"
        - "테스트 전략 적절성 확인"
      Required_Artifacts:
        - diff_summary
        - changed_file_inventory
        - test_result_summary
        - integration_risks
        - remaining_tasks

    3_Test_Hardening:
      Owner: "Tier 4b, escalated to Tier 5 if high-risk"
      Purpose:
        - "edge case 보완"
        - "regression test 추가"
        - "flaky test 가능성 확인"
        - "coverage gap 확인"
      Required_Artifacts:
        - failing_tests
        - passing_tests
        - coverage_summary
        - edge_case_list
        - test_diff

    4_Final_Review:
      Owner: "Tier 5"
      Purpose:
        - "최종 아키텍처 검토"
        - "최소 diff 검토"
        - "테스트/타입체크/린트 통과 확인"
        - "문서화 상태 확인"
        - "merge 또는 rollback 판단"
      Required_Artifacts:
        - final_diff_summary
        - full_test_summary
        - typecheck_summary
        - lint_summary
        - coverage_summary
        - documentation_summary
        - remaining_risks

  Risk_Levels:
    L0_Trivial:
      Description: "문서/포맷/명백한 단순 수정"
      Frontier_Review: "optional"
      Max_Frontier_Packet: "10k tokens"
      Typical_Path:
        - Tier_0
        - Tier_1
        - Tier_4a

    L1_Low:
      Description: "단일 파일, 낮은 회귀 위험"
      Frontier_Review: "final optional"
      Max_Frontier_Packet: "10k tokens"
      Typical_Path:
        - Tier_0
        - Tier_2
        - Tier_3
        - Tier_4a_or_4b

    L2_Normal:
      Description: "복수 파일, 일반 기능 구현"
      Frontier_Review: "plan + final"
      Max_Frontier_Packet: "20k tokens"
      Typical_Path:
        - Tier_0
        - Tier_5_Plan
        - Tier_2
        - Tier_3
        - Tier_4b
        - Tier_5_Final

    L3_High:
      Description: "multi-file integration, 중요한 기능, 회귀 위험 높음"
      Frontier_Review: "plan + vertical slice + midpoint + final"
      Max_Frontier_Packet: "40k tokens"
      Typical_Path:
        - Tier_0
        - Tier_5_Plan
        - Tier_2
        - Tier_3
        - Tier_4b
        - Tier_5_Vertical_Slice
        - Tier_3
        - Tier_4b
        - Tier_5_Midpoint
        - Tier_4b_Test_Hardening
        - Tier_5_Final

    L4_Critical:
      Description: "security, data migration, public API, architecture migration, multi-service refactor"
      Frontier_Review: "every checkpoint mandatory"
      Max_Frontier_Packet: "80k tokens"
      Requires:
        - "explicit justification for 80k+"
        - "human approval before merge"
        - "rollback plan"
        - "stricter diff budget"
      Typical_Path:
        - Tier_0
        - Tier_5_Plan
        - Tier_2
        - Tier_3
        - Tier_4b
        - Tier_5_Vertical_Slice
        - Tier_3
        - Tier_4b
        - Tier_5_Midpoint
        - Tier_4b_Test_Hardening
        - Tier_5_Test_Hardening_Review
        - Tier_5_Final
        - Human_Approval

  Frontier_Review_Packet_Budget:
    Low_Risk: "10k tokens"
    Normal: "20k tokens"
    High_Risk: "40k tokens"
    Critical: "80k tokens"
    Beyond_80k:
      Allowed_Only_When:
        - "architecture migration"
        - "security-critical change"
        - "multi-service refactor"
        - "large public API change"
      Requires:
        - "explicit justification"
        - "raw context index"
        - "summary-first structure"

  Frontier_Review_Packet_Template:
    Required_Sections:
      - original_goal
      - current_task_contract
      - risk_level
      - allowed_files
      - forbidden_changes
      - architecture_notes
      - changed_file_inventory
      - diff_summary
      - test_result_summary
      - typecheck_summary
      - lint_summary
      - coverage_summary
      - unresolved_blockers
      - exact_review_questions
      - raw_evidence_pointers
    Rules:
      - "raw logs는 직접 붙이지 않고 요약 + 파일/라인 포인터로 제공한다."
      - "diff는 전체가 아니라 핵심 hunk와 summary 중심으로 제공한다."
      - "판단에 필요한 원문 위치는 반드시 보존한다."
      - "Tier 5가 답해야 할 질문을 명시한다."

  Task_Contract_Template:
    Required_Sections:
      Goal:
        - "무엇을 완성해야 하는가"
      Scope:
        Allowed_Files:
          - "수정 허용 파일 목록"
        Forbidden_Files:
          - "수정 금지 파일 목록"
        Forbidden_Changes:
          - "public API 변경 금지"
          - "schema 변경 금지"
          - "dependency 추가 금지"
          - "unrelated refactor 금지"
      Inputs:
        - "관련 요구사항"
        - "관련 파일 요약"
        - "관련 symbol/function"
        - "테스트 실패 로그 요약"
      Expected_Output:
        - "구현 diff"
        - "테스트 diff"
        - "변경 요약"
        - "실행한 명령"
        - "남은 blocker"
      Acceptance_Criteria:
        - "통과해야 할 테스트"
        - "typecheck 통과"
        - "lint 통과"
        - "coverage 조건"
        - "기존 behavior 유지"
      Diff_Budget:
        Max_Changed_Files: "task-specific"
        Max_Added_LOC: "task-specific"
        Max_Deleted_LOC: "task-specific"
      Stop_Conditions:
        - "허용 파일 외 수정이 필요할 때"
        - "public API 변경이 필요할 때"
        - "dependency 추가가 필요할 때"
        - "요구사항이 모호할 때"
        - "테스트 결과가 task contract와 충돌할 때"

  Model_Routing:
    Default_Flow:
      - "Tier 0: evidence collection"
      - "Tier 1: evidence summarization"
      - "Tier 2: requirement/context digestion"
      - "Tier 5: plan approval if L2+"
      - "Tier 3: implementation"
      - "Tier 0: test/typecheck/lint"
      - "Tier 1: result summarization"
      - "Tier 4b: repair/normalization if needed"
      - "Tier 5: checkpoint review according to risk"
      - "Tier 4a: final cleanup if low-risk"
      - "Tier 5: final review if L2+"

    Escalation_Rules:
      To_Tier_4b:
        - "local model patch is too large"
        - "tests fail after local repair"
        - "minimal-diff rewrite needed"
        - "subtle bug suspected"
      To_Tier_5:
        - "architecture boundary unclear"
        - "public API impact possible"
        - "dependency graph change proposed"
        - "schema or migration impact possible"
        - "security or data integrity risk"
        - "checkpoint decision required"
      To_Human:
        - "L4 critical change"
        - "rollback risk high"
        - "security-sensitive decision"
        - "ambiguous product requirement"
        - "irreversible migration"

    Deescalation_Rules:
      To_Tier_1_or_4a:
        - "formatting only"
        - "documentation polish only"
        - "simple progress report"
        - "non-semantic cleanup"
      To_Local_Only:
        - "single-file low-risk change"
        - "test-only addition"
        - "clear type error fix"

  Diff_Budget_Defaults:
    L0_Trivial:
      Max_Changed_Files: 2
      Max_Added_LOC: 80
      Max_Deleted_LOC: 80
    L1_Low:
      Max_Changed_Files: 3
      Max_Added_LOC: 200
      Max_Deleted_LOC: 120
    L2_Normal:
      Max_Changed_Files: 8
      Max_Added_LOC: 600
      Max_Deleted_LOC: 300
    L3_High:
      Max_Changed_Files: 15
      Max_Added_LOC: 1200
      Max_Deleted_LOC: 800
    L4_Critical:
      Max_Changed_Files: "explicitly approved"
      Max_Added_LOC: "explicitly approved"
      Max_Deleted_LOC: "explicitly approved"

  Required_Evidence_Pointers:
    Format:
      - "file_path:Lx-Ly"
      - "test_log_path:Lx-Ly"
      - "diff_hunk_id"
      - "symbol_name"
      - "command_output_path"
    Rules:
      - "요약만 제공하지 않는다."
      - "최소한 핵심 판단 근거의 원문 위치를 남긴다."
      - "Tier 5 review packet에는 raw evidence pointer가 반드시 포함된다."

  Standard_Review_Questions:
    Contract_Compliance:
      - "Does the implementation violate the task contract?"
      - "Did any model modify files outside the allowed scope?"
      - "Were any forbidden changes introduced?"
    Architecture:
      - "Is the abstraction boundary still correct?"
      - "Does this introduce unnecessary coupling?"
      - "Does this preserve public API expectations?"
    Testing:
      - "Are the tests sufficient for the risk level?"
      - "Are there missing edge cases?"
      - "Are tests overly coupled to implementation details?"
    Diff_Quality:
      - "Is the diff minimal?"
      - "Are there unrelated refactors?"
      - "Can the patch be split into smaller commits?"
    Decision:
      - "continue"
      - "redirect"
      - "rollback"
      - "escalate_to_human"

  Cost_Control:
    Rules:
      - "Frontier 모델에는 raw 96k context를 반복 투입하지 않는다."
      - "Frontier 호출 전 Tier 1/Tier 2로 review packet을 압축한다."
      - "단순 formatting/reporting은 Tier 4a 또는 Tier 1로 처리한다."
      - "반복 구현과 테스트 수리는 가능한 Tier 3에서 처리한다."
      - "Tier 5는 checkpoint와 final judgment에만 사용한다."
    Expected_Savings:
      Small_Tasks: "70-95% vs frontier-only"
      Medium_Tasks: "60-85% vs frontier-only"
      Large_Repo_Tasks: "50-80% vs frontier-only"
    Failure_Mode:
      - "Frontier에 매번 96k raw context를 보내면 절감 폭이 크게 감소한다."
      - "잘못된 task contract는 재작업 비용을 증가시킨다."
      - "Tier 4b가 설계를 바꾸면 Tier 5 계획과 충돌한다."
      - "Tier 1 요약이 과도하면 정보 손실로 잘못된 판단이 발생한다."

  Operating_Rules:
    - "모든 작업은 task contract에서 시작한다."
    - "모든 구현은 allowed_files 안에서만 수행한다."
    - "모든 변경은 test/typecheck/lint 결과로 검증한다."
    - "모든 checkpoint는 continue / redirect / rollback / escalate 중 하나로 끝난다."
    - "Tier 1은 요약자이며 판단자가 아니다."
    - "Tier 2는 문맥 이해자이며 최종 설계자가 아니다."
    - "Tier 3는 구현자이며 설계자가 아니다."
    - "Tier 4는 수정자이며 설계자가 아니다."
    - "Tier 5는 판관이며 반복 작업자가 아니다."
    - "정보 압축 시 원문 포인터를 보존한다."
    - "모델 간 전달물은 자유서술보다 구조화된 packet을 우선한다."
    - "허용 범위를 벗어나는 순간 중단하고 escalate한다."