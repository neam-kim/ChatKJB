# 인계: General 패널 — cline 토큰 자리에 Plan/Act 토글 버튼

> 작성: LLM-Wiki 세션(읽기 전용 조사). 코드 무수정. 실제 구현은 이 ChatKJB 저장소의 코딩 허용 세션(Act 모드)에서 수행할 것.
> 지시(어르신): "claude와 codex만 토큰이 여러 개니까, cline은 (남는) 토큰 자리에 Plan/Act 버튼을 넣으면 된다."
>
> ✅ 2026-07-21 구현 완료. 결정: 토글 대상은 '새 세션 기본 모드'(SessionDefaults.defaultPermissionMode, plan↔auto).
> 수정: types.ts / store.ts / bot/keyboards.ts / bot/handlers/messages.ts / bot/pending-keys.ts / session-manager.ts / bot.ts.
> 검증: typecheck·build 통과, 전체 vitest 862 통과, bot-cline-ui.test.ts 신규 4건. 웹 fallback은 provider 분기 불가라 미변경(서버 미러링이 소스).

## 목표

General 패널(3×2 인라인 키보드)에서 **현재 provider가 cline일 때** "🔑 토큰" 셀 자리에
**Plan ↔ Act 토글 버튼**을 표시한다. claude·codex일 때는 기존 "🔑 토큰" 버튼을 그대로 둔다.

## 핵심 발견 (조사 완료 — 재조사 불필요)

1. **Plan/Act 기능은 이미 존재한다. 새로 만들 필요 없음.**
   - `src/session/executors/cline.ts`가 `session.permissionMode`를 읽어 cline SDK에 전달한다:
     - `cline.ts:202` — `if (session.permissionMode === "plan" || readOnly || ... "dontAsk")`
     - `cline.ts:269-272` — `permissionMode: readOnly ? "plan" : session.permissionMode`, `mode: readOnly ? "plan" : "act"`
   - 즉 **`session.permissionMode`를 `"plan"` / `"auto"`(=act) 로 토글**하는 버튼만 붙이면 된다.
   - 이 세션 값을 세션에 저장/전환하는 경로가 이미 있는지 `src/session-manager.ts` / `src/store.ts`에서 permissionMode 세터를 확인해 재사용할 것.

2. **패널의 진짜 소스는 웹이 아니라 텔레그램 키보드다.**
   - 웹 `src/gui/web/app.js`의 `GENERAL_PANEL_FALLBACK_ROWS`(3×2)는 **fallback일 뿐**이다.
   - `/api/general-panel`(`src/gui/server.ts:1225`)은 `client.findGeneralReplyPanel()`로
     **텔레그램 인라인 키보드를 읽어 미러링**한다.
   - 따라서 **실제 버튼 생성은 `src/bot/keyboards.ts`**에서 고쳐야 한다. 웹 fallback만 고치면 봇에 반영 안 됨.

3. **cline은 토큰이 단수 → "🔑 토큰" 셀이 실질적으로 남는다.**
   - `src/bot/keyboards.ts:36` — `selectedClaudeTokenIndex`, `selectedCodexAccountIndex` (claude·codex만 다중 계정/토큰).
   - `src/bot/keyboards.ts:74` — `RESERVED_SLOT_LABEL = "➖"` (예약 슬롯 개념 이미 존재).
   - cline provider 판별: `clineProviderOption(catalog, providerId)` 등 `keyboards.ts`에 유틸 존재.

## 수정 지점

| 파일 | 할 일 |
|------|------|
| `src/bot/keyboards.ts` | General 패널 행 구성부에서 provider===cline이면 "🔑 토큰" 버튼을 Plan/Act 토글 버튼(callbackData 새로 정의)으로 교체. 라벨은 현재 `session.permissionMode`에 따라 `🧭 Plan` / `▶️ Act` 형태로 토글 표시 |
| `src/bot/handlers/config-commands.ts` 또는 `run-control.ts` | 새 callbackData 핸들러 추가 → `session.permissionMode`를 plan↔auto로 전환하고 패널 갱신. 기존 permissionMode 전환 로직이 있으면 재사용 |
| `src/gui/web/app.js` `GENERAL_PANEL_FALLBACK_ROWS` (선택) | fallback 배열도 정합 맞추기(웹 단독 fallback 상황 대비). 단 provider 조건 분기는 서버/봇이 소유하므로 여기선 라벨만 |

## 확인 필요 (구현 세션에서 먼저 결정)

- Plan/Act 토글의 **callbackData 네이밍 규약** — 기존 pending-keys.ts / bot-commands.ts의 명령 키 컨벤션을 따를 것.
- `permissionMode`의 act 상태가 `"auto"`인지 다른 값인지 — `src/types.ts`의 permissionMode 유니온 타입을 먼저 확인(plan/auto/dontAsk 외 값 존재 가능).
- 토글이 **새 세션 기본값**을 바꾸는지, **현재 세션**을 바꾸는지 — General 패널(topicId=1)은 "새 세션 기본값" 패널이므로 기본값 저장 경로여야 함.

## 검증

- 구현 후: cline provider 선택 상태에서 General 패널에 Plan/Act 버튼 노출 확인, 토글 시 라벨 변경·`permissionMode` 반영 확인.
- claude·codex provider에서는 "🔑 토큰" 버튼이 그대로인지 회귀 확인.
- `tests/gui-web.test.ts`, `tests/gui-server.test.ts` 통과 + 패널 스냅샷 테스트 갱신.
