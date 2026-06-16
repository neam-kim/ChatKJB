# Telegram Claude Orchestrator

Telegram Forum Topic 하나를 Claude Agent SDK 세션 하나에 연결하는 Mac 상주 봇이다.

## 구현된 기능

- `/new` 프로젝트 선택 후 새 토픽과 Claude 세션 생성
- 토픽의 일반 메시지를 기존 Claude 세션으로 `resume`
- `/addp`, `/deltp`, `/steer`, `/next`, `/fork`, `/stop`, `/compact`, `/memory`, `/mode`, `/model`, `/thinking`, `/lean`, `/status`, `/sessions`, `/usage`, `/projects`, `/diff`, `/delete`
- 실행 중 메시지 스티어링과 현재 작업 뒤 후속 작업 예약
- 일반 MCP 60초 타임아웃 및 최대 3회 순차 재시도
- Codex MCP 30분 타임아웃 및 60초 주기 장기 실행 상태 알림
- Claude 도구 실행 승인/거부와 경로 범위 세션 허용
- `AskUserQuestion` 단일 선택, 복수 선택, 직접 입력
- 의미 있는 단계별 중간 응답을 개별 메시지로 스트리밍하고 진행 상태는 30초 heartbeat로 갱신, 긴 결과 파일 첨부
- 구독 5시간/주간 한도, 모델별(Opus/Sonnet) 주간 한도, Agent SDK(OAuth 앱) 주간 한도 사용률과 초기화 시각 표시
- 한도 초과분(overage) 크레딧이 활성화된 경우에 한해 사용 금액과 월 한도 표시
- SQLite 토픽/세션/프로젝트/승인 메타데이터 저장
- `/plan` 완료 기준, Codex 실행 증거, Claude 검토 판정을 SQLite에 저장
- 모든 완료 기준이 통과하고 Claude가 승인한 경우에만 `/plan`을 완료 처리
- 같은 프로젝트의 실행 직렬화
- 프로세스 재시작 시 미완료 세션을 `interrupted`로 전환

## 1. Telegram 준비

1. BotFather에서 봇을 만들고 토큰을 받는다.
2. 본인만 있는 슈퍼그룹을 만들고 Topics 기능을 켠다.
3. 봇을 관리자로 추가하고 `Manage Topics`, `Delete Messages` 권한을 준다.
4. 본인 Telegram user ID와 슈퍼그룹 chat ID를 확인한다.

봇은 `.env`의 단일 user ID와 chat ID가 모두 일치하는 업데이트만 처리한다.

## 2. 설정

Claude Pro, Max, Team 또는 Enterprise 플랜과 Codex가 포함된 ChatGPT 구독이 필요하다. 별도 Anthropic/OpenAI API 과금은 사용하지 않는다. Claude는 Keychain 로그인 대신 `claude setup-token`이 발급하는 장기 OAuth 토큰을 사용하고, Codex CLI는 `Sign in with ChatGPT`로 로그인해야 한다.

```bash
npm run auth:setup
```

이 명령은 다음 순서로 동작한다.

1. `claude setup-token`을 실행해 브라우저 OAuth 인증을 시작한다.
2. 터미널에 출력된 `sk-ant-oat01-...` 토큰을 복사한다.
3. 숨김 입력 프롬프트에 토큰을 붙여넣는다.
4. `CLAUDE_CODE_OAUTH_TOKEN`으로 `.env`에 저장하고 파일 권한을 `0600`으로 제한한다.

토큰은 일반적으로 1년 유효하며 Claude 구독으로 추론할 때만 사용된다. Remote Control 세션에는 사용할 수 없다.

Codex 구독 로그인을 준비한다.

```bash
codex
```

로그인 선택 화면에서 `Sign in with ChatGPT`를 선택한다. 오케스트레이터는 Codex 실행 전에 `~/.codex/auth.json`의 `auth_mode=chatgpt`를 확인하며 API 키 인증이면 실행을 거부한다. Codex 자식 프로세스에서도 `OPENAI_API_KEY`, `CODEX_API_KEY`, API base URL 환경 변수를 제거한다.

사용량 정책:

- Anthropic은 2026년 5월에 Agent SDK·`claude -p`·third-party 앱 사용량을 구독 한도와 분리해 별도 월간 크레딧으로 옮기겠다고 6월 15일 시행으로 예고했으나, **2026년 6월 16일 공식 이메일로 "이 변경을 시행하지 않는다"며 보류했다.** 현재 Agent SDK·`claude -p`·third-party 앱 사용량은 예전과 동일하게 구독의 5시간·주간 한도에서 차감되며, 별도로 청구·적립되는 크레딧은 없다. Anthropic은 추후 변경 시 사전 고지하겠다고 밝혔다.
- 따라서 봇은 특정 과금 정책을 가정하지 않고, SDK 사용량 엔드포인트의 `rate_limits`가 실제로 반환하는 창만 고정 순서로 표시한다: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`(OAuth 앱 주간), 그리고 `extra_usage`(overage, usage credits를 켠 경우)가 활성화됐을 때 사용 금액·월 한도.
- 존재하지 않는 필드를 추정하거나 날짜로 한도 창을 강등시키지 않는다. 서버가 주는 창은 항상 동일한 순서로 보여 표시가 회전하지 않는다. 정책이 다시 바뀌어도 서버가 반환하는 창을 그대로 따른다.

이어서 Telegram 설정 파일을 준비한다. `.env`가 이미 만들어졌다면 기존 파일을 수정한다.

```bash
test -f .env || cp .env.example .env
```

`.env`에 Telegram 값을 넣는다. OAuth 토큰은 `npm run auth:setup`이 기록한다.

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
TELEGRAM_CHAT_ID=-100...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
```

토큰 파일 권한을 제한한다.

```bash
chmod 600 .env
```

예시 파일을 복사한 뒤 `projects.json`에 Telegram에서 선택할 프로젝트를 등록한다. 실제 프로젝트 경로가 담긴 `projects.json`은 git에서 제외된다.

```bash
cp projects.example.json projects.json
```

```json
[
  {
    "name": "normal-work",
    "cwd": "/absolute/project/path",
    "defaultMode": "auto"
  }
]
```

Telegram에서 `/addp /절대/프로젝트/경로`를 입력해 재시작 없이 프로젝트를 추가할 수도 있다. `/addp`만 먼저 입력한 뒤 다음 메시지로 경로를 보내는 방식도 지원한다. 실제로 존재하고 읽기·쓰기가 가능한 디렉터리만 등록하며, 폴더명을 프로젝트 이름으로 사용한다. 같은 경로는 중복 등록하지 않는다.

`/deltp 이름`(또는 별칭)으로 등록 프로젝트를 삭제할 수 있다. `/deltp`만 입력하면 등록된 프로젝트 목록에서 선택하며, 확인 버튼을 눌러야 실제로 삭제된다. 삭제는 `projects.json` 등록과 메모리·저장소 항목에서만 제거하고 폴더의 실제 파일은 건드리지 않는다. 마지막 한 개 프로젝트는 삭제할 수 없으며, 해당 프로젝트로 만든 기존 세션 기록은 그대로 유지된다.

Claude Agent SDK에는 `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`을 명시적으로 전달한다. 실행 환경에 `ANTHROPIC_API_KEY`나 `ANTHROPIC_AUTH_TOKEN`이 있더라도 Claude 자식 프로세스에서는 제거하여 OAuth 인증이 우선되게 한다. Keychain 자격증명은 사용하지 않는다.

기본 Claude Agent SDK 모델은 `claude-opus-4-8`이며, 토픽에서 `/model`로 세션별 변경할 수 있다(Opus 4.8 / Sonnet 4.6 / Fable 5). 일반 대화와 세션 재개뿐 아니라 `/plan`의 계획·검토 단계도 선택한 세션 모델을 따르며 adaptive thinking은 공통 적용된다.

Codex 실행 모델은 `gpt-5.5`, reasoning effort는 `high`로 코드에서 명시 강제한다. `~/.codex/config.toml`의 기본값이나 Codex 자동 모델 선택에 의존하지 않는다. Telegram `/status`의 `thinking: 자동 (Adaptive)` 표시는 Claude thinking 설정이며 Codex 모델 설정과는 별개다.

기본 장기 메모리 경로는 `~/.claude/memory`다. 다른 위치를 사용하려면 `.env`의 `CLAUDE_MEMORY_DIR`을 변경한다.

## 3. 실행

```bash
npm install
npm run build
npm start
```

개발 중에는 다음 명령을 사용한다.

```bash
npm run dev
```

Telegram의 `/usage`는 가장 최근 SDK 사용량 스냅샷을 표시한다. 실행 중 상태 메시지와 완료 메시지에도 같은 한도 정보가 포함된다. `total_cost_usd`는 실제 구독 차감액이 아닌 클라이언트 추정치이므로 사용자 화면과 SQLite에 비용으로 저장하지 않는다.

Telegram의 `/status`는 명령에 응답하는 것으로 오케스트레이터 프로세스가 살아 있음을 확인하고, 세션 토픽 안에서는 해당 작업이 실제로 현재 프로세스에서 실행 중인지 표시한다. 실행 중 진행 메시지는 새 도구 호출이 없어도 30초마다 경과시간을 갱신한다.

Telegram의 `/plan 요청`은 Claude가 실행 계획과 `[ACCEPTANCE_CRITERIA]` 완료 기준을 작성하고 사용자의 승인을 받은 뒤 Codex가 구현하는 파이프라인이다. Codex가 실행한 명령, 종료 코드, 파일 변경, MCP 호출, 최종 응답과 git 상태·diff를 SQLite 증거 원장에 기록한다. 저장 전 계획, 검증 기준, 검토문, 명령 출력의 토큰·API 키·비밀번호 패턴을 자동 마스킹한다. 마지막 Claude 검토는 각 기준을 `pass`, `fail`, `blocked`로 판정하며 모든 기준이 `pass`이고 최종 판정이 `APPROVE`일 때만 세션을 `done`으로 바꾼다. 검토에 실패하면 같은 Codex 스레드에서 차단 문제를 수정하고 재검증하되 최대 3회로 제한한다. 3회 뒤에도 승인되지 않으면 `verification_failed`로 종료해 완료 오판과 무한 반복을 막는다.

새 세션은 기본적으로 `lean on`이다. [Ponytail](https://github.com/DietrichGebert/ponytail)의 최소 구현 원칙에서 착안해, 불필요한 구현 생략 → 표준 라이브러리 → 플랫폼 기본 기능 → 기존 의존성 → 최소 코드 순서로 해법을 고른다. 이 정책은 Claude 일반 작업, `/plan` 계획 작성, Codex 구현에 함께 적용되며 보안, 입력 검증, 데이터 손실 방지, 접근성, 명시 요구사항과 실행 가능한 검증은 축소하지 않는다. 토픽에서 `/lean off`로 다음 실행부터 끄고 `/lean on`으로 다시 켤 수 있으며 실행 중에는 변경할 수 없다.

Claude가 중요한 단계에서 출력하는 짧은 진행 요약은 텍스트 블록이 완성되는 즉시 개별 Telegram 메시지로 보낸다. 내부 thinking 원문과 토큰 단위 delta는 보내지 않으며, 스트림 뒤에 도착하는 완성 메시지와 동일한 내용은 중복 전송하지 않는다.

Claude Code는 컨텍스트 한도에 가까워지면 자동 압축한다. 토픽의 작업이 끝난 상태에서 `/compact`를 실행하면 즉시 수동 압축하며, `/compact 인증 변경 사항과 남은 테스트 중심`처럼 뒤에 보존 초점을 지정할 수 있다. 실행 중인 작업과 동시에 압축하지 않는다.

토픽의 작업이 끝난 상태에서 `/memory`를 실행하면 해당 Claude 세션에서 장기적으로 유효한 사용자 선호, 결정, 반복 사용 가능한 프로젝트 지식만 선별해 전역 메모리에 기록한다. `/memory 승인 정책과 메모리 규칙 중심`처럼 저장 초점을 지정할 수 있다. 명령 실행 자체를 명시적 저장 승인으로 간주하며, 기존 메모리를 먼저 읽어 중복을 피하고 일시적 상태·추측·비밀정보는 저장하지 않는다. 실행 중인 작업과 동시에 기록하지 않는다.

실행 중 메시지는 명령으로 구분한다.

- `/steer 지금 결과 형식을 표로 바꿔줘`: 현재 실행 중인 작업에 `priority: now`로 전달한다.
- `/next 이 작업이 끝나면 테스트도 실행해줘`: 현재 작업 뒤에 `priority: next`로 예약한다.
- 작업이 끝난 뒤 일반 메시지를 보내면 기존 Claude 세션을 `resume`한다.
- 토픽 안에서 `/delete`를 실행하고 확인하면 Telegram 토픽, SQLite 세션·승인 기록, 로컬 Claude 대화 원본을 함께 삭제한다. 실행 중이거나 대기 중인 작업도 취소한다.

MCP 정책은 `.env`에서 조정할 수 있다.

```dotenv
MCP_TOOL_TIMEOUT_SECONDS=60
MCP_MAX_ATTEMPTS=3
CODEX_MCP_TIMEOUT_MINUTES=30
CODEX_MCP_HEARTBEAT_SECONDS=60
```

일반 MCP가 timeout, connection closed, transport 오류를 반환하면 동일 입력을 병렬화하지 않고 최대 3회 순차 재시도한다. 세 번 모두 실패하면 토픽에 별도 실패 알림을 보낸다. Codex MCP는 정상 작업이 1분을 넘을 수 있으므로 60초 타임아웃을 적용하지 않고, 30분 하드 타임아웃까지 기다리면서 60초마다 진행 중 알림을 보낸다.

Codex MCP만 장기 작업 안정성을 위해 세션 시작 시 `alwaysLoad`로 연결한다. 다른 stdio/HTTP/SSE MCP는 지연 로딩을 유지해 시작 지연과 프롬프트 비대화를 피한다.

## 4. Mac 자동 시작

먼저 OAuth·Telegram `.env` 설정과 빌드를 완료한다. 설치 스크립트는 현재 Node 실행 파일과 프로젝트 절대경로를 사용해 사용자별 plist를 `~/Library/LaunchAgents`에 생성한다. 토큰은 plist에 기록하지 않는다.

Node 버전을 바꾸거나 프로젝트 폴더를 이동한 경우 설치 명령을 다시 실행한다.

```bash
npm run launchd:install
```

재시작:

```bash
npm run launchd:restart
```

재시작에는 서비스 등록을 유지하는 위 명령을 사용한다. 아래 `bootout`은 재시작이 아니라 서비스를 등록 해제하고 완전히 중지하므로, 실행 중인 봇 자체에서 호출하면 후속 시작 명령을 수행할 수 없다.

중지:

```bash
launchctl bootout gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

로그는 `data/stdout.log`와 `data/stderr.log`에 기록된다.

## 권한 정책

- 기본 프로젝트 모드는 `auto`다. Claude의 권한 분류기가 일반적인 파일 편집과 명령 실행을 자동 판단하고, 위험하거나 불확실한 작업만 Telegram 승인을 요청한다.
- 토픽에서 `/mode default`로 보수적 승인 방식, `/mode acceptEdits`로 파일 편집 자동 허용, `/mode auto`로 자동 판단 방식으로 바꿀 수 있다.
- 토픽에서 `/model`로 현재 모델과 선택 버튼을 확인하거나 `/model opus`, `/model sonnet`, `/model fable`로 다음 실행부터 사용할 모델을 바꿀 수 있다. 실행 중에는 변경할 수 없다.
- 토픽에서 `/lean`으로 최소 구현 원칙 상태를 확인하고 `/lean on`, `/lean off`로 다음 실행의 적용 여부를 바꿀 수 있다.

## 안전 정책

- 읽기 도구 `Read`, `Glob`, `Grep`, `WebSearch`만 기본 자동 허용한다. `WebFetch`는 URL별 승인을 거친다.
- 사용자·프로젝트·로컬 Claude 설정의 사전 승인 규칙은 로드하지 않는다.
- 루트 `CLAUDE.md`와 `AGENTS.md`는 지침으로만 읽으며 도구 권한을 부여하지 않는다.
- `auto` 모드에서 권한 분류기가 승인하지 않은 파일 변경과 명령 실행은 Telegram 승인을 거친다.
- `Bash`에는 세션 단위 항상 허용 버튼을 제공하지 않는다. 다른 도구도 SDK가 경로 등 범위를 포함한 규칙을 제안할 때만 해당 범위로 허용한다.
- `bypassPermissions`는 지원 모드에서 제외했다.
- 봇 토큰이 담긴 `.env`와 SQLite 데이터는 git에서 제외한다.
- 실제 프로젝트 절대경로가 담긴 `projects.json`은 git에서 제외한다.
- OAuth 토큰은 로그, SQLite, launchd plist에 저장하지 않는다.
- `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`은 Claude 자식 프로세스에서 제거한다.

## 현재 제한

- Telegram Bot API는 Telegram 앱에서 사용자가 직접 삭제한 토픽에 대한 삭제 이벤트를 제공하지 않는다. 로컬 세션까지 확실히 지우려면 토픽 메뉴의 일반 삭제 대신 토픽 안에서 `/delete`를 사용해야 한다.
- 승인 대기 중 프로세스가 재시작되면 해당 SDK 호출은 복원하지 않고 세션을 `interrupted`로 표시한다. 기존 토픽에 후속 지시를 보내 세션 문맥을 재개할 수 있다.
- 프로젝트별 큐는 충돌 방지를 위해 읽기 전용 작업도 포함해 한 번에 하나씩 실행한다.
- 실제 Telegram 연결 검증에는 유효한 봇 토큰, user ID, forum supergroup ID가 필요하다.
- `setup-token` OAuth는 Remote Control 용도가 아니라 Agent SDK 추론 전용이다.
- 단일 슈퍼그룹만 지원하며 다중 슈퍼그룹은 지원하지 않는다.
