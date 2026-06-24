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
- **P6 미착수 (일시정지)** — 라이브 `/goal` 동작을 바꾸므로 어르신 승인 후 진행.

## 미확정 / 추적

- Tier 4b가 Codex일 때 실제 Codex 하위 저가 모델 ID 확정 필요.
- b0bf81c에서 제거했던 로컬 LLM 파이프라인을 사양에 맞게 재도입하는 큰 변경임에 유의.
