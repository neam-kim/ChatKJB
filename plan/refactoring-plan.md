# ChatKJB 리팩토링 계획 (초안 — 감사 결과 취합 중)

작성일: 2026-07-17
상태: 초안. 보안·유지보수성·이식성/최적화 3축 정밀 감사 결과를 취합하여 확정한다.

## 0. 목표

봇 기능 향상, 관리 용이성, 보안, 이식성, 최적화 다섯 축을 개선하되,
동작 변경 없는 구조 개선(리팩토링)과 동작이 바뀌는 개선(기능/보안 강화)을 단계로 분리한다.

## 1. 현재 기준선 (2026-07-17 실측)

- Node v26.4.0, TypeScript ESM, grammY, better-sqlite3, vitest.
- `npm run typecheck` 통과.
- `npm test`: 테스트 파일 50개 중 49개 통과, 519개 중 1개 실패.
  - 실패: `tests/bot.test.ts > /compile command > deploys the configured KJB Wiki public graph before reporting completion`
  - 원인 확정: flaky 아님. `src/bot/handlers/advisory.ts:28`의 모듈 전역 `let wikiCompileRunning`이
    같은 파일의 앞선 `/compile` 테스트 이후 true로 남아, 뒤 테스트의 `/compile`이 "이미 실행 중"으로
    거절됨. 단독 실행 5/5 통과, 파일 전체 실행 3/3 동일 실패로 순서 의존 오염 확인.
- 코드 규모: src 약 19,500줄. 최대 파일 `src/session-manager.ts` 2,073줄,
  `src/bot/handlers/config-commands.ts` 1,011줄, `src/model-catalog.ts` 847줄,
  `src/store.ts`·`src/bot.ts` 각 785줄.
- 아키텍처 의도(README 3부): SessionManager는 공통 조정만, provider별 실행은
  `src/session/executors/{claude,codex,agy,grok}.ts`가 독립 담당, `shared.ts` 최소 호스트 계약.

## 2. 즉시 수정 (Phase 0 — 리팩토링 전 기준선 안정화)

- [ ] P0-1. `wikiCompileRunning`/`transcriptDumpRunning` 모듈 전역 상태를 BotDeps 주입 상태로
  이동하거나 테스트에서 리셋 가능하게 만들어, 전체 테스트 519/519 결정적 통과를 회복한다.
  검증: `npx vitest run tests/bot.test.ts` 3회 연속 전체 통과.
- [ ] P0-2. 미커밋 작업분(KJB Wiki post-compile 배포 연동) 커밋 정리 후 리팩토링 브랜치 분기.

## 3. 감사 결과 (취합 예정)

### 3.1 보안 감사
(서브에이전트 보고 대기)

### 3.2 유지보수성/아키텍처 감사
(서브에이전트 보고 대기)

### 3.3 이식성/최적화 감사
(서브에이전트 보고 대기)

## 4. 단계별 실행 계획
(감사 취합 후 확정: 각 단계는 범위, 변경 파일, 검증 명령, 롤백 기준을 명시한다)

## 5. 검증 게이트 (모든 단계 공통)

- `npm run typecheck`
- `npm test` (결정적 전체 통과)
- `npm run build`
- `npm run audit:portability`
- launchd 재시작 후 Telegram `/doctor` 정상
