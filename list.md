# Sonnet 구현 계획: agy 문맥 제어·상태 조회·작업량 명령 통합

## 구현 상태

2026-06-21 구현·검토·배포 완료.

- Phase 1 `/reset`: 완료
- Phase 2 agy 새 세션 기본 추론 강도: 완료
- Phase 3 agy 라이브 `/status`: 완료
- Phase 4 선택적 실네트워크 취소 테스트: 테스트 추가 완료, 환경 플래그 미설정으로 실제 호출은 skip
- Phase 5 `/power` 통합 및 `/effort` 호환: 완료
- Phase 6 문서·검증·LaunchAgent 재배포: 완료

## 목표

현재 agy 연동에서 남아 있는 문맥 초기화, 새 세션 기본 추론 강도, 라이브 상태 조회,
실네트워크 취소 검증을 완성하고 Claude/Codex/agy의 작업량 명령을 `/power` 하나로
통합한다.

구현은 기존 사용자 변경을 보존한 채 진행한다. 각 단계가 끝날 때 관련 단위 테스트를
추가하고, 마지막에 Node.js 22 환경에서 전체 검증과 LaunchAgent 재시작까지 수행한다.

## 현재 코드 기준선

- agy 세션별 추론 강도는 이미 구현되어 있다.
  - `SessionRecord.agyThinkingLevel`
  - SQLite `sessions.agy_thinking_level`
  - `/effort`의 agy 분기와 `agyeffort:*` 콜백
  - 브리지 `init.thinkingLevel` → `GeminiModelOptions.thinking_level`
- 그러나 새 세션 기본값인 `SessionDefaults`에는 `agyThinkingLevel`이 없어 기본값 패널에서
  agy 추론 강도를 저장하거나 새 세션에 전달하지 못한다.
- agy 브리지는 `turn`, `cancel`, `close`만 처리한다. `clear_history`와 `status` 요청/응답은
  아직 없다.
- `/stop`은 `AbortController.abort()`와 `AgyInteractiveSession.interrupt()`를 통해
  브리지의 `ChatResponse.cancel()` 및 `asyncio.Task.cancel()`까지 연결되어 있다. 단위
  프로토콜 검증은 있으나 실제 Gemini API 스트림을 중단하는 선택적 통합 테스트가 없다.
- Claude는 `/power`, Codex와 agy는 `/effort`를 사용한다. 기본값 패널은 Codex만 추론
  강도를 순환하고 agy는 아직 “모델 내장”이라고 잘못 안내한다.

## 공통 구현 원칙

1. 실행 중인 세션의 모델·추론 강도·문맥을 변경하는 명령은 거부한다. 먼저 `/stop`으로
   중단하도록 안내한다.
2. 브리지 제어 요청은 모두 요청 ID를 사용한다. 응답이 다른 요청과 섞이지 않도록
   `AgyInteractiveSession`에서 pending turn과 pending control request를 분리한다.
3. 제어 요청에는 제한 시간을 둔다. 브리지가 응답하지 않으면 무한 대기하지 말고 명확한
   오류를 반환한다.
4. `conversation_id`와 저장된 대화 DB의 일관성을 유지한다. 문맥 초기화 성공 전에는
   저장소의 ID를 먼저 지우지 않는다.
5. 기존 `/effort` 사용자를 갑자기 깨뜨리지 않는다. `/effort`는 호환 별칭으로 한 릴리스
   유지하되, 응답에서 `/power` 사용을 안내한다. 공개 명령 목록과 README의 표준 명령은
   `/power`로 통일한다.
6. 테스트와 데몬 실행은 LaunchAgent와 같은 Node.js 22 경로를 사용한다.

---

## Phase 1. `/reset`으로 같은 토픽의 대화 문맥만 초기화

### 사용자 동작

- 세션 토픽에서 `/reset`을 실행하면 토픽, 프로젝트, 제공자, 모델, 권한 모드 및 UI는
  유지하고 대화 문맥만 초기화한다.
- 실행 중이면 거부하고 `/stop` 후 다시 실행하도록 안내한다.
- 초기화 성공 메시지는 “다음 메시지부터 새 문맥으로 시작”임을 명시한다.
- 토픽 밖에서 실행하면 “세션 토픽 안에서 사용” 안내를 반환한다.

### 제공자별 처리

- Claude:
  - 기존 `sdkSessionId`가 있으면 Claude 세션 삭제 함수를 호출한다.
  - 성공 후 `sdkSessionId: null`, `handoffSummary: null`, `usageSnapshot: null`로 갱신한다.
- Codex:
  - 기존 `codexThreadId`가 있으면 로컬 Codex 스레드 삭제/정리 경로를 재사용하거나,
    현재 프로젝트의 기존 삭제 구현에서 제공자별 정리 로직을 공용 함수로 추출한다.
  - 성공 후 `codexThreadId: null`, `handoffSummary: null`로 갱신한다.
- agy:
  - 살아 있는 `AgyInteractiveSession`에 `clear_history` 제어 요청을 보낸다.
  - Python 브리지에서 `await agent.conversation.clear_history()`를 호출하고
    `clear_history_result`를 반환한다.
  - 브리지가 살아 있지 않거나 SDK가 해당 API를 지원하지 않으면, 기존 대화 프로세스를
    닫고 저장된 `.db`, `.db-wal`, `.db-shm`을 안전하게 삭제하는 폴백을 사용한다.
  - 성공 후 `agyConversationId: null`, `agyUsage: null`, `handoffSummary: null`로 갱신한다.

### 코드 변경

- `src/bot.ts`
  - `bot.command("reset", ...)` 추가.
  - 공통 세션 조회, 실행 중 검사, 성공/실패 메시지 처리.
- `src/session-manager.ts`
  - `resetContext(sessionId): Promise<ResetContextResult>` 추가.
  - 현재 `deleteSession()` 안에 섞여 있는 Claude/agy 대화 파일 정리 코드를 제공자별
    private helper로 추출하여 삭제와 초기화가 함께 재사용하도록 한다.
- `src/agy-interactive.ts`
  - `clearHistory(): Promise<void>` 추가.
  - control request ID, timeout, 응답 매칭 구현.
- `scripts/agy-sdk-bridge.py`
  - `clear_history` 메시지 처리 및 성공/실패 응답 추가.
- `src/index.ts`, `README.md`
  - Telegram 명령 등록과 사용 설명에 `/reset` 추가.

### 테스트

- `tests/bot.test.ts`
  - 토픽 밖 거부, 없는 세션 거부, 실행 중 거부, 성공 메시지.
- `tests/session-manager.test.ts`
  - Claude/Codex/agy별 ID와 사용량 필드 초기화.
  - 외부 정리 실패 시 ID를 보존하고 오류를 반환하는지 확인.
  - 다른 세션 설정과 토픽 정보가 변하지 않는지 확인.
- `tests/agy-interactive.test.ts`
  - `clear_history` 요청 전송, 성공 응답, 오류 응답, timeout, 프로세스 종료 처리.
- Python 브리지 테스트가 없다면 `tests/agy-sdk-bridge.test.ts`를 추가하여 가짜 SDK 또는
  테스트 모드로 메시지 프로토콜을 검증한다.

### 완료 조건

- 같은 Telegram 토픽에서 `/reset` 후 다음 메시지가 이전 대화 내용 없이 시작된다.
- 세 제공자 모두 토픽과 설정은 유지되고 재개 ID만 새로 생성된다.
- 실패 시 기존 문맥을 잃지 않는다.

---

## Phase 2. 새 세션 기본값 패널에 agy 추론 강도 추가

### 데이터 모델

- `src/types.ts`
  - `SessionDefaults`에 `agyThinkingLevel: string`을 추가한다.
- `src/store.ts`
  - 기본 시드는 `DEFAULT_AGY_THINKING_LEVEL`을 사용한다.
  - `default.agyThinkingLevel`을 `app_settings`에서 읽고 쓴다.
  - 저장값이 `minimal|low|medium|high`가 아니면 안전한 기본값으로 정규화한다.
- `PendingStart`와 `pendingFieldsFromDefaults()`에 `agyThinkingLevel`을 전달한다.
- 새 agy 세션 생성 시 `SessionRecord.agyThinkingLevel`에 기본값이 실제 저장되는지 확인한다.

### UI

- agy 선택 시 기본값 패널의 네 번째 버튼을
  `💭 추론: <Minimal|Low|Medium|High>`로 표시한다.
- 해당 버튼을 누르면 agy 추론 강도를
  `minimal → low → medium → high → minimal` 순서로 순환한다.
- `defaultsSummary()`에도 agy 추론 강도를 표시한다.
- 기존 “agy는 추론 강도가 모델에 포함됩니다” 문구를 모두 제거한다.

### 테스트

- `tests/store.test.ts`
  - 기본값 시드, 저장/재로딩, 잘못된 저장값 정규화.
- `tests/bot.test.ts`
  - agy 기본값 패널 라벨, 버튼 순환, `/new`로 만든 세션에 값 적용.
- 기존 세션별 `/effort` agy 테스트는 `/power` 통합 단계에서 재사용한다.

### 완료 조건

- agy를 기본 제공자로 선택했을 때 패널에서 추론 강도를 보고 바꿀 수 있다.
- 변경값이 데몬 재시작 후에도 유지되고 새 agy 세션 첫 턴부터 적용된다.

---

## Phase 3. agy 라이브 `/status`: `is_idle`과 `turn_count`

### 프로토콜

- TS → Python:
  - `{ "type": "status", "id": "<request-id>" }`
- Python → TS 성공:
  - `{ "type": "status_result", "id": "...", "isIdle": true, "turnCount": 3,
      "conversationId": "..." }`
- Python → TS 실패:
  - `{ "type": "control_error", "id": "...", "message": "..." }`

Python 브리지에서 `agent.conversation.is_idle`과 `agent.conversation.turn_count`를 읽는다.
SDK 버전 차이로 속성이 없으면 `null`을 반환하고 전체 요청을 실패시키지 않는다.

### 코드 변경

- `src/agy-interactive.ts`
  - `AgyLiveStatus` 타입과 `getStatus(): Promise<AgyLiveStatus>` 추가.
  - turn 응답과 별도의 control pending map을 사용한다.
- `src/session-manager.ts`
  - `getAgyLiveStatus(sessionId)` 추가.
  - 살아 있는 브리지가 없을 때 `/status` 때문에 새 브리지를 무조건 시작할지 정책을
    명확히 한다. 권장 정책은 다음과 같다.
    - 기존 대화 ID가 있으면 브리지를 시작하여 상태 조회.
    - 아직 첫 턴 전이면 `isIdle: true`, `turnCount: 0`을 저장 상태 기반으로 반환.
- `src/bot.ts`
  - agy 토픽 `/status`에서 저장된 상태와 함께 라이브 필드를 출력한다.
  - 예: `agy 라이브: 유휴 · 대화 턴 3회`
  - timeout이나 조회 실패 시 `/status` 전체를 실패시키지 말고
    `agy 라이브: 조회 실패 (<짧은 원인>)`만 덧붙인다.

### 동시성 주의

- status 요청이 진행 중인 turn과 동시에 들어와도 Python 메인 루프가 제어 메시지를
  소비할 수 있어야 한다.
- 현재 브리지는 turn을 별도 task로 실행하므로 status 처리 자체는 가능하다.
- `is_idle` 값은 status 요청 처리 시점의 실제 값을 사용한다.

### 테스트

- `tests/agy-interactive.test.ts`
  - 정상 상태, null 필드, timeout, control error, turn 진행 중 상태 응답.
- `tests/session-manager.test.ts`
  - 첫 턴 전 기본 상태, 살아 있는 브리지 조회, 조회 실패 폴백.
- `tests/bot.test.ts`
  - agy `/status` 표시와 조회 실패 시 기존 상태 정보 보존.

### 완료 조건

- agy 세션의 `/status`에서 실제 SDK 대화의 유휴 여부와 턴 수를 확인할 수 있다.
- 브리지 장애가 일반 `/status` 응답까지 막지 않는다.

---

## Phase 4. `/stop`의 agy 실네트워크 취소 검증

### 테스트 방식

- 기본 `npm test`에서는 네트워크를 사용하지 않는다.
- 별도 opt-in 통합 테스트를 추가한다.
  - 예: `npm run test:agy-live`
  - `GEMINI_API_KEY`가 없으면 명시적으로 skip.
  - 실제 파일 수정 도구를 쓰지 않는 긴 텍스트 생성 프롬프트를 사용한다.
- 테스트 순서:
  1. agy 브리지를 실제 SDK와 시작한다.
  2. 충분히 긴 응답을 요청한다.
  3. 첫 `text_delta` 수신 직후 `interrupt()`를 호출한다.
  4. 제한 시간 안에 turn promise가 aborted 오류로 종료되는지 확인한다.
  5. 같은 브리지에서 짧은 두 번째 turn을 실행한다.
  6. 두 번째 turn이 성공하면 cancel 후 프로세스와 대화가 재사용 가능함을 증명한다.

### 관측 정보

- 테스트 실패 시 다음을 출력한다.
  - 첫 delta까지 걸린 시간
  - cancel 전송 시각
  - error/done 수신 시각
  - SIGTERM 폴백 사용 여부
  - child process 생존 여부
- 필요하면 `AgyInteractiveSession`에 테스트용 이벤트 훅을 추가하되 운영 로그에 API 키나
  프롬프트 전문을 남기지 않는다.

### 완료 조건

- 실제 네트워크 스트림이 `/stop` 후 제한 시간 안에 중단된다.
- 정상 경로에서는 3초 SIGTERM 폴백 없이 취소된다.
- 취소 후 같은 브리지로 다음 turn을 성공적으로 실행할 수 있다.
- API 키가 없는 CI와 일반 `npm test`는 영향을 받지 않는다.

---

## Phase 5. `/power`로 Claude·Codex·agy 작업량 명령 통합

### 사용자 계약

- `/power`가 현재 세션 제공자를 확인하고 해당 제공자의 작업량 설정을 표시·변경한다.
- Claude:
  - 허용값은 모델 카탈로그의 Claude effort 옵션.
  - 기존 `claudeEffort` 저장 경로를 그대로 사용한다.
- Codex:
  - 허용값은 모델 카탈로그의 reasoning effort 옵션.
  - 기존 `codexReasoning` 저장 경로를 그대로 사용한다.
- agy:
  - 허용값은 `minimal|low|medium|high`.
  - 기존 `agyThinkingLevel` 저장 경로를 그대로 사용한다.
  - `reset|default` 입력 시 API 기본값으로 초기화하는 기존 기능은 유지한다.
- 인자 없이 실행하면 제공자별 현재값과 인라인 키보드를 표시한다.
- 실행 중 변경은 세 제공자 모두 동일하게 거부한다.

### 리팩터링

- `src/bot.ts`
  - 현재 `/power`와 `/effort`의 중복 세션 조회·검사·응답 로직을
    `handlePowerCommand(ctx, { legacyAlias?: boolean })` 형태의 공용 함수로 추출한다.
  - 콜백 이름은 충돌 없는 공통 형식으로 정리한다.
    - 권장: `power:claude:<id>`, `power:codex:<id>`, `power:agy:<id>`
  - 기존 콜백(`power:*`, `effort:*`, `agyeffort:*`)은 이미 발송된 Telegram 버튼의
    호환성을 위해 한동안 수신만 유지해 새 공용 처리기로 전달한다.
  - `/effort`는 같은 처리기를 호출하고 응답 끝에
    `이 명령은 /power로 통합되었습니다.`를 덧붙인다.
- `src/index.ts`
  - Telegram 공개 명령에서 `/effort`를 제거하고 `/power` 설명을
    “현재 AI 작업량/추론 강도 확인 또는 변경”으로 변경한다.
- `README.md`
  - 명령표, 사용 예시, 제공자별 설명을 `/power` 기준으로 통일한다.
  - `/effort`는 호환 별칭이라고 한 줄만 남긴다.

### 기본값 패널과의 일관성

- 기본값 패널의 네 번째 버튼과 세션 내 `/power`가 같은 라벨 함수와 옵션 정의를
  사용하도록 한다.
- 새 세션 기본값과 현재 세션 설정은 별개임을 메시지에 명확히 표시한다.
  - 패널: “새 세션 기본 …”
  - `/power`: “현재 세션의 다음 실행부터 …”

### 테스트

- `tests/bot.test.ts`
  - Claude/Codex/agy 각각 `/power` 조회, 유효값 변경, 잘못된 값, 실행 중 거부.
  - agy `reset`, Codex 모델별 옵션, Claude 모델별 옵션.
  - `/effort` 호환 별칭이 같은 저장 결과를 만들고 마이그레이션 안내를 표시.
  - 신규 공통 콜백과 기존 콜백 호환 처리.
- `tests/model-catalog.test.ts`
  - 공통 UI가 사용하는 제공자별 옵션과 라벨 회귀 테스트.

### 완료 조건

- 사용자는 제공자와 관계없이 `/power` 하나만 기억하면 된다.
- 세 제공자의 기존 저장 필드와 SDK 전달값은 정확히 유지된다.
- 기존 `/effort` 텍스트 명령과 이미 발송된 버튼도 깨지지 않는다.

---

## Phase 6. 문서·검증·배포

### 문서 갱신

- `README.md`
  - `/reset`, 통합 `/power`, agy 기본 추론 강도, agy 라이브 상태 설명.
  - 명령 목록과 구현 구조 표의 실제 코드 상태를 일치시킨다.
- 필요하면 `.env.example`에 live test용 플래그를 추가하되 API 키 값은 절대 기록하지 않는다.
- 작업 완료 내역을 프로젝트의 기존 이력 문서가 있으면 그 형식에 맞춰 기록한다.

### 검증 명령

아래 명령은 반드시 Node.js 22 환경에서 순서대로 실행한다.

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
npm run typecheck
npm test
npm run build
npm run launchd:restart
launchctl print "gui/$(id -u)/com.neam.telegram-claude-orchestrator"
```

선택적 실네트워크 검증:

```bash
export PATH="$HOME/.nvm/versions/node/v22.18.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
npm run test:agy-live
```

### 최종 확인

- LaunchAgent가 `state = running`, `last exit code = 0`인지 확인한다.
- stdout에 시작 메시지가 새로 기록되는지 확인한다.
- stderr에 새 ABI 오류나 브리지 fatal 오류가 추가되지 않았는지 확인한다.
- Telegram에서 다음 수동 smoke test를 수행한다.
  1. agy 기본값 패널에서 추론 강도 변경 후 `/new`.
  2. agy 첫 턴 실행 후 `/status`에서 `is_idle`, `turn_count` 확인.
  3. 긴 agy 턴 중 `/stop`, 이후 같은 토픽에서 후속 턴 성공 확인.
  4. `/reset` 후 이전 문맥을 묻고 기억하지 못하는지 확인.
  5. Claude/Codex/agy 세션 각각 `/power` 조회 및 변경 확인.

## Sonnet 작업 종료 보고 형식

완료 보고에는 다음을 반드시 포함한다.

1. 변경 파일 목록과 각 파일의 핵심 변경.
2. Phase별 완료/미완료 여부.
3. 테스트 수와 결과.
4. 선택적 실네트워크 테스트를 실행했는지, 미실행이면 정확한 이유.
5. LaunchAgent PID, 상태, 마지막 종료 코드.
6. 남은 위험 또는 수동 확인이 필요한 항목.
