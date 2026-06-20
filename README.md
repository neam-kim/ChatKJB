# Telegram Claude Orchestrator

Telegram Forum Topic 하나를 AI 세션 하나에 연결하는 Mac 상주 봇이다. 한 토픽에서 **Claude(Agent SDK)** 또는 **Codex(Codex SDK)** 중 하나로 대화하며, 같은 토픽 안에서 제공자를 바꿔도 직전 맥락을 요약으로 인계해 이어 간다.

## 이 봇이 무엇인가요? (비개발자용 안내)

**한 줄 요약:** 텔레그램 채팅창에서 내 Mac에 있는 AI(클로드 또는 코덱스)에게 일을 시키고, 그 결과를 휴대폰으로 받아 보는 개인 비서 봇입니다.

평소 컴퓨터 앞에서 하던 코딩·문서·자료 정리 같은 작업을, 외출 중에도 텔레그램 메시지 한 줄로 시작하고 진행 상황을 지켜보고 승인할 수 있습니다. 봇은 본인 계정·본인 그룹에서 온 메시지만 처리하므로 다른 사람은 쓸 수 없습니다.

**무엇을 할 수 있나요?**

- **작업 지시** — "이 프로젝트에 로그인 기능 추가해줘"처럼 적으면 AI가 해당 폴더의 코드를 읽고 고칩니다.
- **AI 선택·전환** — 새 작업을 시작할 때 클로드와 코덱스 중 누구와 일할지 고르고, 작업 도중에도 `/model`로 바꿀 수 있습니다. 바꿔도 지금까지의 대화 요약이 다음 AI에게 넘어갑니다.
- **중간 개입** — 작업 도중 방향을 바꾸거나(`/steer`), 끝난 뒤 할 일을 미리 예약(`/next`)하거나, 조건이 충족될 때까지 자동 반복(`/goal`)할 수 있습니다.
- **파일 주고받기** — 사진·문서·음성 등을 토픽에 보내면 AI가 작업 폴더에서 그 파일을 읽을 수 있고, 결과 파일은 `/upload 경로`로 휴대폰에 받아볼 수 있습니다.
- **안전장치** — 위험할 수 있는 작업은 AI가 멋대로 진행하지 않고 휴대폰으로 "이거 해도 될까요?" 하고 버튼으로 승인을 받습니다.
- **사용량 확인** — 남은 구독 한도를 `/usage`로 볼 수 있습니다.

**기본 사용 흐름**

1. 텔레그램 그룹에서 `/new`를 보내고, 프로젝트(작업 폴더)를 버튼으로 고릅니다.
2. 나타나는 패널에서 제공자(클로드/코덱스)·모델·사고 강도 등 기본값을 확인하거나 바꿉니다.
3. 하고 싶은 일을 평소 말하듯 적어 보냅니다. 그러면 새 토픽이 생기고 작업이 시작됩니다.
4. AI가 일하는 과정을 메시지로 중계하고, 승인이 필요하면 버튼으로 물어봅니다.
5. 작업이 끝나면 결과를 알려 줍니다. 이어서 메시지를 더 보내면 같은 대화를 이어 갑니다.

**꼭 알아 두면 좋은 용어**

| 용어 | 쉬운 설명 |
| --- | --- |
| 토픽(Topic) | 텔레그램 그룹 안의 '주제별 탭'. 이 봇은 토픽 하나를 작업(대화) 하나로 씁니다. |
| 세션(Session) | 한 토픽에서 이어지는 AI와의 대화 묶음. 앞선 맥락을 기억합니다. |
| 제공자(Provider) | 실제로 일하는 AI 종류. **클로드(Claude)** 와 **코덱스(Codex)** 둘 다 대화·작업이 가능하며, `/new`에서 고르고 `/model`로 도중에 바꿀 수 있습니다. |
| 인계 요약(Handoff) | 제공자를 바꿀 때, 직전 AI가 만든 "지금까지의 목표·진행·수정 파일·남은 일" 요약. 새 AI의 첫 메시지에 한 번 붙어 대화가 끊기지 않게 합니다. |
| 모델(Model) | AI의 '두뇌 종류'(예: Opus, Sonnet, GPT). 똑똑할수록 보통 느리고 비쌉니다. |
| thinking · 작업량(power/effort) | AI가 얼마나 깊게 고민할지 정하는 다이얼. 높일수록 신중하지만 사용량을 더 씁니다. |
| 토큰(Token) | 구독 계정에 접속하는 열쇠. 여러 개 등록하면 한 계정의 한도가 차도 다른 계정으로 자동 전환됩니다. |
| 한도(Limit) | 구독제의 시간당·주간 사용 상한. 다 쓰면 회복 시각까지 기다렸다가 작업을 자동으로 이어 합니다. |
| MCP | AI가 외부 도구(파일 검색 등)에 연결되는 통로. 일반 사용자는 몰라도 됩니다. |

**텔레그램 명령어 빠른 참고** (목적별)

| 하고 싶은 것 | 명령어 |
| --- | --- |
| 새 작업 시작 / 이어 말하기 | `/new`, (작업이 끝난 뒤 그냥 메시지를 보내면 같은 대화 계속) |
| 진행 중 작업 다루기 | `/steer`(방향 바꾸기), `/next`(끝난 뒤 할 일 예약), `/goal`(조건 충족까지 자동 반복), `/stop`(중단), `/fork`(현재 대화 복제) |
| 파일 | 토픽에 사진·문서·음성 등을 그냥 전송(AI가 작업 폴더에서 읽음), `/upload 경로`(결과 파일을 휴대폰으로 받기) |
| 상태·사용량 확인 | `/status`(작업 상태), `/usage`(남은 한도), `/sessions`(최근 작업들), `/projects`(등록 폴더), `/diff`(바뀐 코드 요약) |
| AI 선택·성향 조절 | `/model`(제공자 전환 + 모델 변경), `/thinking`(클로드 깊이 사고 on/off), `/power`(클로드 작업량), `/effort`(코덱스 작업량), `/lean`(최소 구현), `/mode`(승인 엄격도) |
| 정리 | `/compact`(대화 요약 압축), `/memory`(배운 점을 장기 기억에 저장) |
| 관리 | `/addp`·`/deltp`(작업 폴더 추가·삭제), `/delete`(이 토픽과 기록 삭제), `/doctor`(환경 점검) |

> 아래 설치·실행 절(1~4장)과 '개발자 안내'는 봇을 직접 띄우려는 분을 위한 기술 설명입니다. 텔레그램으로 사용만 한다면 이 안내와 명령어 설명 정도만 봐도 충분합니다.

## 구현된 기능

- `/new` 프로젝트 선택 후, 상시 기본값 패널에서 제공자(Claude/Codex)·모델·thinking(또는 Codex 추론 강도)을 고른 뒤 첫 작업 메시지로 새 토픽과 세션 생성
- 토픽의 일반 메시지를 기존 세션으로 이어 가기(Claude는 `resume`, Codex는 스레드 재개)
- `/model`로 **제공자 전환** — 직전 제공자에게 대화 인계 요약을 만들게 하고, 대상 제공자가 새 맥락에서 그 요약을 받아 이어 감(같은 명령으로 현재 제공자의 모델도 변경)
- 토픽에 보낸 사진·문서·오디오·음성·동영상·스티커 등을 작업 폴더에 저장해 AI가 참조, `/upload 경로`로 작업 폴더의 파일을 토픽에 전송
- `/addp`, `/deltp`, `/steer`, `/next`, `/goal`, `/fork`, `/stop`, `/compact`, `/memory`, `/mode`, `/model`, `/thinking`, `/power`, `/effort`, `/lean`, `/status`, `/sessions`, `/usage`, `/projects`, `/diff`, `/delete`
- 실행 중 메시지 스티어링과 현재 작업 뒤 후속 작업 예약
- `/goal` 조건 충족까지 자동으로 턴 이어가기(읽기 전용 판정 모델로 충족 여부 평가, 최대 25턴)
- 일반 MCP 60초 타임아웃 및 최대 3회 순차 재시도
- Codex MCP 30분 타임아웃 및 60초 주기 장기 실행 상태 알림
- Claude 도구 실행 승인/거부와 경로 범위 세션 허용
- `AskUserQuestion` 단일 선택, 복수 선택, 직접 입력
- 의미 있는 단계별 중간 응답을 개별 메시지로 스트리밍하고 진행 상태는 30초 heartbeat로 갱신, 긴 결과 파일 첨부
- 구독 5시간/주간 한도, 모델별(Opus/Sonnet) 주간 한도, Agent SDK(OAuth 앱) 주간 한도 사용률과 초기화 시각 표시
- 한도 초과분(overage) 크레딧이 활성화된 경우에 한해 사용 금액과 월 한도 표시
- 여러 OAuth 토큰 한도 자동 전환(`waiting_limit` 대기 후 회복 시각에 자동 재개)
- SQLite 토픽/세션/프로젝트/승인 메타데이터 저장
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

### 제공자 선택과 전환

새 세션은 상시 기본값 패널(텔레그램 하단 reply 키보드)에서 제공자를 고른다. 패널 버튼은 `🤖 제공자`(Claude ↔ Codex 토글), `🧠 모델`(현재 제공자의 모델 선택), `💭`(Claude면 thinking on/off, Codex면 추론 강도 순환)으로 구성되며, 여기서 정한 값이 **다음에 만드는 새 세션의 기본값**으로 저장된다. `/new` 직후 이 패널과 함께 현재 기본값 요약이 표시된다.

세션을 진행하다가 토픽 안에서 `/model`을 인자 없이 부르면 제공자 전환 버튼(Claude/Codex)과 현재 제공자의 모델 선택 버튼이 함께 나온다. 다른 제공자를 누르면 **직전 제공자가 지금까지의 대화·작업을 한국어로 요약**하고, 그 인계 요약이 다음 사용자 턴의 프롬프트 앞에 한 번 붙어 새 제공자가 맥락을 이어받는다. 전체 대화 원문이 복사되는 것이 아니라 요약으로 인계되며, 한 번도 실행되지 않은 세션은 인계할 맥락이 없어 요약 없이 전환된다. 전환은 유휴 상태에서만 가능하고 실행 중에는 거부된다.

### 모델

- **Claude**: 기본 모델은 `claude-opus-4-8`이며 `/model`로 세션별 변경할 수 있다(Opus 4.8 / Sonnet 4.6 / Fable 5). 일반 대화와 세션 재개에 선택한 모델을 따른다.
- **Codex**: 실행 모델은 `gpt-5.5`로 코드에서 명시 강제하며 `~/.codex/config.toml`의 기본값이나 Codex 자동 모델 선택에 의존하지 않는다.

모델·thinking·추론 선택지는 시작 시 제공자 카탈로그(Claude=SDK `supportedModels`, Codex=번들 바이너리 `debug models`)를 동적으로 읽어 채운다. 조회에 실패하면 정적 fallback 목록을 사용한다.

### 사고·작업량 다이얼

Claude에는 서로 독립인 두 개의 추론 노브가 있고, 명령도 분리되어 있다.

- `/thinking` — 확장적 사고(extended thinking)를 켜고 끈다. `adaptive`(기본, Claude가 필요할 때 스스로 사고)와 `off` 중 선택한다.
- `/power` — 작업량(effort, "더 빠름 ↔ 더 스마트함")을 정한다. `low`, `medium`, `high`(기본), `xhigh`, `max`. 값이 높을수록 더 깊게 사고하고 토큰을 더 쓴다. Claude 데스크톱/Code의 "작업량" 슬라이더와 같은 파라미터다.

각각 인자 없이 부르면 현재 값과 인라인 버튼을 보여 주고, `/thinking off`·`/power high`처럼 인자를 주면 다음 실행부터 적용한다. 실행 중에는 둘 다 바꿀 수 없다. 두 값은 Claude 일반 대화·세션 재개에 적용되며 `/status`에 `thinking`과 `Claude 작업량`으로 표시된다.

Codex의 reasoning effort는 기본 `high`이고, 토픽에서 `/effort`로 세션별로 바꿀 수 있다(`minimal`, `low`, `medium`, `high`, `xhigh`). `/effort`만 입력하면 현재 값과 선택 버튼을 보여 주고, `/effort medium`처럼 인자를 주면 다음 Codex 실행부터 그 작업량을 사용한다. 선택한 값은 `/status`의 `Codex: ... · reasoning ...` 줄에 반영된다. `/effort`는 Codex 전용이며 Claude의 작업량은 `/power`가 담당한다.

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

### 사용량과 토큰 자동 전환

Telegram의 `/usage`는 먼저 Claude SDK의 사용량 API를 새로 호출해 현재 서버 응답을 확인한다. OAuth 토큰을 여러 개 등록했다면 토큰 #1, 토큰 #2처럼 각 토큰을 따로 조회해 보여 준다. 모든 토큰의 실시간 조회가 실패한 경우에만 최근 작업 세션에 저장된 마지막 스냅샷을 대신 표시한다. 실행 중 상태 메시지와 완료 메시지에도 같은 한도 정보가 포함된다. `total_cost_usd`는 실제 구독 차감액이 아닌 클라이언트 추정치이므로 사용자 화면과 SQLite에 비용으로 저장하지 않는다.

OAuth 토큰을 여러 개 등록하면 한도에 대응해 자동 전환한다. `.env`에 `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3` …를 추가하면 된다(각 계정에서 `claude setup-token`으로 생성). 등록 순서상 앞선 "살아있는" 토큰을 우선 쓰고, 실행 중 한 토큰이 한도(사용률 100% 또는 rate-limit 오류)에 도달하면 그 토큰을 초기화 시각까지 봉인한 뒤 살아있는 다른 토큰으로 같은 작업을 즉시 자동 재실행한다(대화 맥락은 `resume`으로 잇는다). 봉인된 토큰이 회복되면 다시 1순위로 돌아오므로 전환은 양방향이다. 모든 토큰이 동시에 한도에 도달하면 작업을 에러로 끝내지 않고 `waiting_limit` 상태로 두었다가, 가장 먼저 회복되는 토큰의 초기화 시각(여유 10초)에 맞춰 같은 작업을 자동으로 이어서 실행한다. 그 전에 사용자가 새 지시를 보내거나 `/stop`을 누르면 예약은 취소된다. 데몬이 재시작되면 메모리상의 예약 타이머는 사라지므로 해당 세션은 `interrupted`로 복구되고 후속 지시로 재개할 수 있다. (이 토큰 전환은 Claude 제공자에 적용된다. Codex는 ChatGPT 구독 인증을 따른다.)

### 상태 확인

Telegram의 `/status`는 명령에 응답하는 것으로 오케스트레이터 프로세스가 살아 있음을 확인하고, 세션 토픽 안에서는 해당 작업이 실제로 현재 프로세스에서 실행 중인지 표시한다. 현재 제공자·모델·thinking·작업량·모드·목표 상태를 함께 보여 준다. 실행 중 진행 메시지는 새 도구 호출이 없어도 30초마다 경과시간을 갱신한다.

### 목표 자동 진행 (`/goal`)

Telegram의 `/goal 조건`은 조건이 충족될 때까지 작업을 자동으로 이어 가게 한다(클로드 코드 본가의 `/goal`과 같은 개념). 한 턴이 정상 종료될 때마다 빠른 모델(Haiku)로 "조건이 이미 충족됐는지"를 읽기 전용으로 판정하고, 미충족이면 사용자가 다시 시키지 않아도 같은 목표를 향한 다음 턴을 자동으로 예약한다. 충족되면 목표를 해제하고 알리며, 폭주 방지를 위해 최대 25턴까지만 자동 진행한다. `/goal`만 입력하면 현재 목표를, `/goal clear`는 목표를 해제한다. 유휴 상태에서 목표를 걸면 즉시 작업을 시작하고, 실행 중에 걸면 현재 턴이 끝난 뒤부터 평가한다. `/stop`이나 `/goal clear`로 언제든 멈출 수 있다. 자동 진행 턴도 일반 실행과 같은 경로를 타므로 **토큰 한도 자동 전환과 `waiting_limit` 대기·자동 재개가 그대로 적용**된다. 목표가 걸린 세션은 `/status`에 `목표(자동 진행)` 줄로 표시된다. (목표 진행은 사용량을 빠르게 소모할 수 있으니 `/usage`로 한도를 함께 확인하는 것이 좋다.)

### 최소 구현 원칙 (`/lean`)

새 세션은 기본적으로 `lean on`이다. [Ponytail](https://github.com/DietrichGebert/ponytail)의 최소 구현 원칙에서 착안해, 불필요한 구현 생략 → 표준 라이브러리 → 플랫폼 기본 기능 → 기존 의존성 → 최소 코드 순서로 해법을 고른다. 이 정책은 Claude 작업과 Codex 구현에 함께 적용되며 보안, 입력 검증, 데이터 손실 방지, 접근성, 명시 요구사항과 실행 가능한 검증은 축소하지 않는다. 토픽에서 `/lean off`로 다음 실행부터 끄고 `/lean on`으로 다시 켤 수 있으며 실행 중에는 변경할 수 없다.

### 진행 스트리밍

Claude가 중요한 단계에서 출력하는 짧은 진행 요약은 텍스트 블록이 완성되는 즉시 개별 Telegram 메시지로 보낸다. 내부 thinking 원문과 토큰 단위 delta는 보내지 않으며, 스트림 뒤에 도착하는 완성 메시지와 동일한 내용은 중복 전송하지 않는다.

### 컨텍스트 압축 (`/compact`)과 메모리 (`/memory`)

Claude Code는 컨텍스트 한도에 가까워지면 자동 압축한다. 토픽의 작업이 끝난 상태에서 `/compact`를 실행하면 즉시 수동 압축하며, `/compact 인증 변경 사항과 남은 테스트 중심`처럼 뒤에 보존 초점을 지정할 수 있다. 실행 중인 작업과 동시에 압축하지 않는다.

토픽의 작업이 끝난 상태에서 `/memory`를 실행하면 해당 세션에서 장기적으로 유효한 사용자 선호, 결정, 반복 사용 가능한 프로젝트 지식만 선별해 전역 메모리에 기록한다. `/memory 승인 정책과 메모리 규칙 중심`처럼 저장 초점을 지정할 수 있다. 명령 실행 자체를 명시적 저장 승인으로 간주하며, 기존 메모리를 먼저 읽어 중복을 피하고 일시적 상태·추측·비밀정보는 저장하지 않는다. 실행 중인 작업과 동시에 기록하지 않는다.

### 실행 중·후속 메시지

- `/steer 지금 결과 형식을 표로 바꿔줘`: 현재 실행 중인 작업에 `priority: now`로 전달한다.
- `/next 이 작업이 끝나면 테스트도 실행해줘`: 현재 작업 뒤에 `priority: next`로 예약한다.
- 작업이 끝난 뒤 일반 메시지를 보내면 기존 세션을 이어 간다(Claude는 `resume`, Codex는 직전 스레드 재개).
- `/fork`는 현재 세션을 새 토픽으로 복제해 같은 맥락에서 분기 작업을 시작한다.
- 토픽 안에서 `/delete`를 실행하고 확인하면 Telegram 토픽, SQLite 세션·승인 기록, 로컬 Claude 대화 원본을 함께 삭제한다. 실행 중이거나 대기 중인 작업도 취소한다.

### 파일 주고받기

토픽에 사진·문서·오디오·음성·동영상·원형 동영상·애니메이션(GIF)·스티커를 보내면 봇이 해당 파일을 세션 작업 폴더에 내려받아 AI가 참조할 수 있게 한다(캡션이 있으면 함께 전달). 반대로 `/upload 경로`는 작업 폴더(또는 절대경로)의 파일을 토픽으로 전송한다. 예: `/upload output/result.pdf`.

### MCP 정책

MCP 정책은 `.env`에서 조정할 수 있다.

```dotenv
MCP_TOOL_TIMEOUT_SECONDS=60
MCP_MAX_ATTEMPTS=3
CODEX_MCP_TIMEOUT_MINUTES=30
CODEX_MCP_HEARTBEAT_SECONDS=60
LONG_RUNNING_MCP_SERVERS=codex,obsidian
TURN_IDLE_TIMEOUT_MINUTES=35
```

일반 MCP가 timeout, connection closed, transport 오류를 반환하면 동일 입력을 병렬화하지 않고 최대 3회 순차 재시도한다. 세 번 모두 실패하면 토픽에 별도 실패 알림을 보낸다. `LONG_RUNNING_MCP_SERVERS`에 등록한 장기 실행 MCP(예: codex, obsidian)는 60초 컷 대신 `CODEX_MCP_TIMEOUT_MINUTES` 하드 타임아웃을 적용하고 `CODEX_MCP_HEARTBEAT_SECONDS`마다 진행 중 알림을 보낸다. `TURN_IDLE_TIMEOUT_MINUTES`는 스트림이 완전히 침묵할 때 턴을 중단하는 워치독으로, codex·승인 타임아웃보다 항상 5분 이상 크도록 자동 클램프된다.

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
- 토픽에서 `/mode`로 권한 모드를 확인·변경한다. 사용 가능한 모드는 다음 다섯 가지다.
  - `auto` — (기본) 권한 분류기가 자동 판단하고 위험·불확실한 것만 승인 요청.
  - `default` — 보수적 승인. 도구 실행마다 승인을 묻는다.
  - `acceptEdits` — 파일 편집은 자동 허용, 그 외는 승인.
  - `plan` — 읽기 위주 계획 모드. 모델이 도구로 변경을 시도하면 턴을 종료한다.
  - `dontAsk` — 최소 프롬프트. (`bypassPermissions`는 지원에서 제외했다.)
- 토픽에서 `/model`로 제공자(Claude/Codex)와 현재 제공자의 모델을 확인·변경한다. 실행 중에는 변경할 수 없다.
- 토픽에서 `/thinking`으로 Claude 확장적 사고 on/off를, `/power`로 Claude 작업량(effort)을, `/effort`로 Codex reasoning 작업량을, `/lean`으로 최소 구현 원칙을 세션별로 확인하고 바꿀 수 있다.

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
- `ANTHROPIC_API_KEY`와 `ANTHROPIC_AUTH_TOKEN`은 Claude 자식 프로세스에서, `OPENAI_API_KEY`·`CODEX_API_KEY`·API base URL은 Codex 자식 프로세스에서 제거한다.

## 현재 제한

- Telegram Bot API는 Telegram 앱에서 사용자가 직접 삭제한 토픽에 대한 삭제 이벤트를 제공하지 않는다. 로컬 세션까지 확실히 지우려면 토픽 메뉴의 일반 삭제 대신 토픽 안에서 `/delete`를 사용해야 한다.
- 승인 대기 중 프로세스가 재시작되면 해당 SDK 호출은 복원하지 않고 세션을 `interrupted`로 표시한다. 기존 토픽에 후속 지시를 보내 세션 문맥을 재개할 수 있다.
- 프로젝트별 큐는 충돌 방지를 위해 읽기 전용 작업도 포함해 한 번에 하나씩 실행한다.
- 실제 Telegram 연결 검증에는 유효한 봇 토큰, user ID, forum supergroup ID가 필요하다.
- `setup-token` OAuth는 Remote Control 용도가 아니라 Agent SDK 추론 전용이다.
- 단일 슈퍼그룹만 지원하며 다중 슈퍼그룹은 지원하지 않는다.

## 개발자 안내

이 절은 코드베이스를 처음 보는 개발자가 구조를 파악하고 기능을 추가할 수 있도록 정리한 것이다.

### 기술 스택

- TypeScript(ESM, `"type": "module"`) + Node.js 22 이상. 빌드는 `tsc`, 테스트는 `vitest`로 한다.
- Telegram 봇 프레임워크는 [grammy](https://grammy.dev), Claude 실행은 `@anthropic-ai/claude-agent-sdk`, Codex 실행은 `@openai/codex-sdk`를 쓴다.
- 영속 상태는 `better-sqlite3`(동기 SQLite), 설정 검증은 `zod`, `.env` 로딩은 `dotenv`를 쓴다.

### 소스 구조 (`src/`)

| 파일 | 역할 |
| --- | --- |
| `index.ts` | 진입점. 설정·저장소·모델 카탈로그를 로딩하고 `setMyCommands`로 Telegram 명령 메뉴를 등록한 뒤 봇을 시작한다. 새 슬래시 명령을 메뉴에 노출하려면 여기 목록에도 추가해야 한다. |
| `config.ts` | `.env`와 `projects.json`을 읽어 `AppConfig`를 만든다. `/addp`, `/deltp`의 프로젝트 추가·삭제 로직도 여기 있다. |
| `bot.ts` | grammy 봇 본체. 모든 슬래시 명령 핸들러(`bot.command(...)`), 인라인 버튼 콜백(`bot.callbackQuery(...)`), 상시 기본값 패널(`bot.hears(...)`), 미디어 입력 핸들러(`bot.on("message:*")`), `/status` 출력 포매팅(`formatSessionStatus`)이 있다. 명령을 추가할 때 가장 먼저 손대는 파일이다. |
| `session-manager.ts` | 세션 수명주기와 실행 큐. Claude(Agent SDK)와 Codex(Codex SDK) 두 제공자의 실행, 메시지 스티어링·후속 예약, 제공자 전환 시 인계 요약 생성(`switchProvider`/`summarizeForHandoff`), 토큰 한도 자동 전환과 `waiting_limit` 자동 재개, `/goal` 자동 진행을 담당한다. |
| `store.ts` | SQLite 스키마, 마이그레이션, 세션·프로젝트·승인·세션 기본값 CRUD. 컬럼을 추가할 때는 `CREATE TABLE`이 아니라 기존 DB를 위해 `ALTER TABLE` 마이그레이션을 추가한다. (`plan_runs`/`plan_criteria`/`plan_evidence` 테이블은 과거 `/plan` 파이프라인의 잔존 스키마로, 현재 명령에서는 사용하지 않는다.) |
| `types.ts` | `SessionRecord`, `ProviderKind`, `SessionDefaults` 등 공유 타입. |
| `model-catalog.ts` | 시작 시 Claude(SDK `supportedModels`)와 Codex(번들 바이너리 `debug models`) 카탈로그를 동적으로 읽어 모델·thinking·reasoning 선택지를 만든다. 조회 실패 시 `FALLBACK_*` 정적 목록을 쓴다. |
| `permission-broker.ts` | Claude 도구 실행 승인/거부 흐름과 경로 범위 세션 허용, `AskUserQuestion` 처리. |
| `token-pool.ts` | 여러 OAuth 토큰 로테이션과 한도/과부하 시 토큰 전환·회복 시각 추적. |
| `mcp-policy.ts` | MCP 서버 로딩 정책(장기 실행 서버만 `alwaysLoad`, 나머지는 지연 로딩). |
| `redaction.ts` | 저장·전송 전 토큰·API 키·비밀번호 패턴 마스킹. |
| `usage.ts` | SDK 사용량 응답을 사용자용 문자열로 포매팅. |
| `stream-renderer.ts` | Claude 스트리밍 출력을 Telegram 메시지 단위로 렌더링. |
| `telegram-transport.ts` | Telegram 전송 헬퍼(토픽 생성, 파일 전송)와 오류 메시지 안전 처리(`safeErrorMessage`). |
| `doctor.ts` | `/doctor` 실행 환경 진단. |

`scripts/`는 OAuth 셋업과 LaunchAgent 설치·재시작 스크립트, `tests/`는 vitest 테스트, `launchd/`는 plist 템플릿, `data/`는 런타임 SQLite와 로그(git 제외)다.

### 한 요청이 흐르는 경로

1. `index.ts`가 봇을 시작하고, 허용된 user ID·chat ID에서 온 업데이트만 통과시킨다.
2. 토픽의 일반 메시지·미디어·슬래시 명령이 `bot.ts` 핸들러로 들어온다.
3. 핸들러는 `store`에서 토픽에 매핑된 세션을 찾고, 작업이면 `SessionManager`에 넘긴다.
4. `SessionManager`가 세션의 제공자에 따라 Claude Agent SDK 또는 Codex SDK를 실행하고, 중간 출력은 `stream-renderer`·`telegram-transport`로 토픽에 보낸다.
5. 세션 상태·승인·기본값은 `store`(SQLite)에 기록된다.

### 슬래시 명령을 추가하는 법

세션별 설정 토글(`/effort`, `/lean`, `/thinking`이 같은 패턴)을 예로 든 최소 절차:

1. 새 컬럼이 필요하면 `types.ts`의 `SessionRecord`에 필드를 추가하고, `store.ts`에 `ALTER TABLE` 마이그레이션·`insert`/`update`/`row` 매핑을 더한다.
2. `bot.ts`에 `bot.command("이름", ...)` 핸들러를 추가한다. 인자 없이 부르면 현재 값과 인라인 버튼을 보여 주고, 인자가 있으면 검증 후 `store.updateSession`으로 저장한다. 버튼을 쓰면 `bot.callbackQuery(/^prefix:/, ...)` 콜백도 짝으로 추가한다.
3. 값이 실행에 반영돼야 하면 `session-manager.ts`의 해당 실행 경로에서 세션 필드를 읽어 SDK 옵션으로 넘긴다.
4. `/status` 표시가 필요하면 `bot.ts`의 `formatSessionStatus`에 줄을 더한다.
5. 명령 메뉴 노출을 위해 `index.ts`의 `setMyCommands` 목록과 README 명령 목록에 추가한다.
6. `tests/`에 동작 테스트를 추가한다.

### 개발 워크플로

```bash
npm install
npm run dev        # tsx watch로 핫 리로드 실행
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # dist/로 컴파일 (npm start가 사용)
```

변경을 머지하기 전에 `npm run typecheck`, `npm test`, `npm run build`가 모두 통과해야 한다. 봇 핸들러를 바꿨다면 `tests/bot.test.ts`처럼 grammy 핸들러를 직접 호출하는 테스트로 회귀를 막는다.
