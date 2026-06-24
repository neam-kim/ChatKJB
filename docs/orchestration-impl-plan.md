# Structure2.md 오케스트레이션 구현계획

`Structure2.md`(레포 루트, 609줄, `ChatKJB_Orchestration_section_Structure`)에 정의된
Tier 0~5 다단계 위임 오케스트레이션을 실제 코드로 구현하기 위한 계획.
2026-06-24 어르신 승인 결정 사항을 정본으로 기록한다.

## 배경 / 경위

- 2026-06-24 세션(`31b72462`)에서 `/goal`을 새 설계로 대체(결정론 게이트 + 판관 LLM)했으나,
  이는 Structure2.md **Tier 0 철학의 일부만** 반영한 것이고 전체 Tier 0~5 위임 오케스트레이션은
  구현 범위에서 빠졌다.
- 현 `/goal` = `check:` 결정론 게이트 + 독립 판관(로컬 qwen3.6 → Haiku 폴백) + 최대 25턴 자동 루프.
- 누락분: Tier 1~4 실제 위임 엔진, task_contract / review_packet / checkpoint / risk_level 라우팅,
  diff_budget 강제, cost_control.

## 런타임 Tier 매핑 (승인됨)

| Tier | 역할 | 모델 |
|---|---|---|
| Tier 0 | 결정론 근거 수집/검증 | ripgrep · tree-sitter/AST · tsc · vitest · lint · coverage · dep-graph |
| Tier 1 | clerk / 요약 / 분류 | 로컬 `gemma4:e4b-64k` |
| Tier 2 | long-context 분석 / packet 초안 | 로컬 `qwen3.6:27b-96k` |
| Tier 3 | 구현자 / 테스트 생성 / 로컬 수리 | 로컬 `qwen3-coder:30b-96k` |
| Tier 4a | 저가 클린업 / 포맷 / 보고서 정리 | 로컬 `gemma4:e4b-64k` |
| Tier 4b | 수정자 / 패치 정규화 / 버그수리 | **판관의 반대 제공자** (판관 Claude→Codex, 판관 Codex→Claude) |
| Tier 5 | 설계 · 분해 · 판관 · 최종검수 | **해당 세션이 돌고 있는 모델 그 자체** |

- 로컬 3종은 고정. 클라우드(Tier 4b/5)는 세션 제공자에 따라 동적, 4b는 판관과 교차 제공자(자기편향 회피).
- 항상 96k 핀 태그(`qwen3-coder:30b-96k`, `qwen3.6:27b-96k`) 사용. 엔드포인트 `http://localhost:11434`.

## 구축 방식 (메타 프로세스)

각 단계(P1~P6)는 다음 루프로 만든다 — 사양 철학을 자기 구축에 그대로 적용:

1. 로컬 `qwen3-coder:30b-96k`가 해당 단계 코드를 구현(구현자 = Tier 3).
2. 오케스트레이터(Opus 세션 = Tier 5)가 `vitest run` / `tsc --noEmit`로 검증.
3. 실패 시 Sonnet 4.6(Tier 4b)을 호출해 최소 diff 수정.
4. 오케스트레이터가 재검증 후 다음 단계로 진행.

## 단계 (P1~P6, 승인됨)

- **P1 — 타입·계약 토대**: `src/orchestration/types.ts` — `TaskContract`, `ReviewPacket`,
  `RiskLevel(L0~L4)`, `DiffBudget`, `Checkpoint`를 Structure2.md대로 정의 + 순수 검증 함수 + vitest. (위험 L1)
- **P2 — Tier 0 evidence 엔진**: `src/orchestration/tier0.ts` — ripgrep/tsc/vitest/lint/coverage 실행 →
  `file:Lx-Ly` evidence pointer로 정규화. (L2)
- **P3 — 로컬 Tier 1/2/3 클라이언트**: `src/orchestration/local-tiers.ts` — ollama `/api/chat`로
  gemma4(요약)·qwen3.6(packet)·qwen3-coder(구현). Forbidden / Output_Format 가드 포함. (L2)
- **P4 — 라우터·예산·체크포인트 엔진**: `src/orchestration/engine.ts` — Risk_Level별 Typical_Path,
  Escalation/Deescalation, Diff_Budget 강제, Checkpoint continue/redirect/rollback. (L3)
- **P5 — Tier 5 판관 배선**: 세션 모델이 review_packet만 받아 decision 반환. 기존 `src/judge.ts` 재사용·확장. (L2)
- **P6 — /goal 결합**: `/goal`을 이 엔진의 진입점으로 연결. 클라우드 한도 차단 시 로컬 Tier로 강등. (L3)

## 진행 상황 (2026-06-24)

- **P1 완료** — `src/orchestration/types.ts` (+ test). tsc 0.
- **P2 완료** — `src/orchestration/tier0.ts` (ripgrep/tsc/vitest 파서+러너) (+ test).
- **P3 완료** — `src/orchestration/local-tiers.ts` (ollama gemma/qwen 클라이언트+프롬프트빌더+코드블록파서) (+ test).
  라이브 gemma4 Tier1 실동작 스모크 확인.
- **P4 완료** — `src/orchestration/engine.ts` (classifyRisk·checkpointsForRisk·frontierPacketBudget·escalationTarget·tierPath) (+ test).
- **P5 완료** — `src/orchestration/frontier-review.ts` (ReviewPacket→판정 프롬프트/파서) (+ test).
- 누계: tsc 0건, 전체 테스트 347 passed / 1 skipped.
- **P6 완료** — `/goal` 로컬 판관 폴백 결합. goal-checks에 `parseGoalVerdict` 추출,
  session-manager에 `tryLocalGoalVerdict`(Claude 전원 한도 시 결정론 목표를 로컬 Tier2로 사실기반 판정)
  추가, `maybeContinueGoal`의 한도 분기·rate-limit catch에 폴백 연결. 자유형 목표는 null→기존 회복대기(무퇴행).
  커밋 a33fc1b, Node v22.18.0 빌드·배포(launchd:install), 데몬 재기동(pid 81846, runs=1, 무에러).

- **P6.1 완료 (2026-06-24, 판관 교체 + 턴 상한 재설계)** — 정상 경로의 옛 잔재(고정 Haiku 평가·고정 25턴)를
  Structure2 설계로 교체:
  - **판관 = Tier 5 = 세션 모델.** `GOAL_EVAL_MODEL = "claude-haiku-4-5"` 고정 평가 폐지.
    `evaluateGoal`은 결정론 게이트 통과 후 (a) 로컬 Tier 2(qwen3.6) local-first 판정을 먼저 시도하고,
    (b) 로컬 판정 불가(자유서술형)일 때만 `runReadOnlyClaude`를 modelOverride 없이 호출해 **session.model**
    (Tier 5)로 판정한다. 이후 `/synth` 판관은 Claude Opus 4.8 high → Codex 5.5 high 폴백으로 교체되었다.
  - **턴 상한 = Risk_Level별 동적.** 고정 `MAX_GOAL_ROUNDS=25`(폭주 안전 상한으로만 잔존) 대신
    `estimateGoalRisk(condition)`(goal-checks.ts, 순수 함수)로 목표 위험도를 추정해
    `GOAL_ROUNDS_BY_RISK`(L0:3·L1:6·L2:12·L3:20·L4:30)를 적용. 위험 키워드(보안/스키마/마이그레이션/
    아키텍처/public API/통합)와 check: 게이트 수를 신호로 engine.ts `classifyRisk`에 위임.
  - 위험도 추정 정규식의 `\b` 단어경계가 한글에 작동하지 않던 버그를 영문/한글 매칭 분리로 수정
    (테스트가 검출). 신규 `tests/goal-risk.test.ts` 7건(로컬 qwen3-coder 위임·오케스트레이터 검수).
  - tsc 0건, 전체 361 passed / 1 skipped. 빌드(Node v22.18.0) 완료. **데몬 재기동은 어르신 지시로 보류**
    (현 데몬은 구버전 유지, 차기 `launchd:restart` 시 반영).

## 잔여 (후속 epic)

- **작업 턴 전면 위임 미구현**: 현재 work turn은 여전히 세션의 클라우드 모델이 수행한다.
  Tier 3(qwen3-coder)가 실제 repo 작업 턴을 도구접근과 함께 구동하는 전면 DAG 위임
  (사양의 Model_Routing Default_Flow 전체)은 세션 실행경로 대수술이라 별도 epic으로 남김.
  엔진 모듈(engine/tier0/local-tiers/frontier-review)은 이미 갖춰져 있어 이를 바탕으로 진행 가능.

## 미확정 / 추적

## 미확정 / 추적

- Tier 4b가 Codex일 때 실제 Codex 하위 저가 모델 ID 확정 필요.
- b0bf81c에서 제거했던 로컬 LLM 파이프라인을 사양에 맞게 재도입하는 큰 변경임에 유의.
