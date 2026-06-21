# Telegram Claude Orchestrator

**텔레그램 메시지 한 줄로, 내 Mac 속 AI에게 일을 시키고 결과를 휴대폰으로 받는 개인 비서 봇입니다.**

집 컴퓨터 앞에 앉아 하던 코딩·문서 작성·자료 정리 같은 일을, 밖에서도 카카오톡 보내듯 텔레그램으로 시켜 두고, 진행 상황을 지켜보다가 버튼 한 번으로 승인하면 됩니다. **Claude · Codex · agy** 세 가지 AI 중 원하는 것을 골라 쓰고, 대화 도중에 바꿀 수도 있습니다.

> **이 문서는 두 부분입니다.**
> - **1부 — 사용 안내:** 봇이 무엇이고 텔레그램에서 어떻게 쓰는지. **비개발자는 이 부분만 읽으면 됩니다.**
> - **2부 — 설치·운영:** 봇을 자기 Mac에 직접 설치해 돌리려는 분을 위한 기술 안내입니다.

---

# 1부. 사용 안내

> 어렵게 느껴지면 **"가장 쉽게 시작하기"** 와 **"이럴 땐 이 명령어"** 두 절만 보셔도 충분합니다. 나머지는 필요할 때 찾아보면 됩니다.

## 이 봇은 무엇인가요?

- 텔레그램 채팅창이 **AI에게 일을 시키는 리모컨**이 됩니다.
- AI는 내 Mac에 미리 등록해 둔 **폴더(프로젝트)** 안의 파일을 직접 읽고 고칩니다.
- **본인 계정·본인 그룹에서 온 메시지만** 처리합니다. 다른 사람은 이 봇을 쓸 수 없습니다.

## 이런 걸 할 수 있어요

- **일 시키기** — "이 프로젝트에 로그인 기능 추가해줘"처럼 평소 말하듯 적으면 AI가 알아서 코드를 고칩니다.
- **AI 골라 쓰기** — Claude / Codex / agy 중 누구와 일할지 고르고, 도중에 바꿔도 **지금까지 한 이야기가 다음 AI에게 요약되어 넘어가** 대화가 끊기지 않습니다.
- **중간에 끼어들기** — 방향을 바꾸거나, 끝난 뒤 할 일을 미리 예약하거나, **원하는 상태가 될 때까지 자동으로 반복**시킬 수 있습니다.
- **파일 주고받기** — 사진·문서·음성을 보내면 AI가 그 파일을 열어 보고, 결과 파일은 다시 휴대폰으로 받을 수 있습니다.
- **안전장치** — 위험할 수 있는 일은 AI가 멋대로 하지 않고, **"이거 해도 될까요?" 하고 버튼으로 물어봅니다.**

## 가장 쉽게 시작하기

> 봇은 이미 누군가 설치해 둔 상태라고 가정합니다. 설치는 2부를 보세요.

1. 텔레그램 그룹에서 **`/new`** 를 보냅니다.
2. AI가 일할 **폴더(프로젝트)** 를 버튼으로 고릅니다.
3. (선택) 화면 아래 버튼 패널에서 **어떤 AI로 일할지** 확인하거나 바꿉니다. 그냥 둬도 됩니다.
4. 하고 싶은 일을 **평소 말하듯** 적어 보냅니다. 예: `이 폴더 README를 더 쉽게 고쳐줘`
5. AI가 일하는 과정을 메시지로 보여 주고, 필요하면 버튼으로 승인을 물어봅니다.
6. 끝나면 결과를 알려 줍니다. **같은 자리(주제)에 메시지를 더 보내면 대화가 이어집니다.**

처음에는 이 6단계만 알아도 충분합니다. 아래는 더 잘 쓰고 싶을 때 보세요.

## 알아 두면 좋은 용어

| 용어 | 쉬운 설명 |
| --- | --- |
| 주제(Topic) | 텔레그램 그룹 안의 '주제별 탭'. 이 봇은 주제 하나를 작업(대화) 하나로 씁니다. |
| 세션(Session) | 한 주제에서 이어지는 AI와의 대화 묶음. 앞선 맥락을 기억합니다. |
| 제공자(Provider) | 실제로 일하는 AI 종류. **Claude · Codex · agy** 세 가지가 모두 대화·작업이 가능하며, `/new`에서 고르고 `/model`로 도중에 바꿀 수 있습니다. |
| 인계 요약(Handoff) | 제공자를 바꿀 때, 직전 AI가 만든 "지금까지의 목표·진행·수정한 파일·남은 일" 요약. 새 AI의 첫 메시지에 한 번 붙어 대화가 끊기지 않게 합니다. |
| 모델(Model) | AI의 '두뇌 종류'(예: Opus, GPT, Gemini). 똑똑할수록 보통 느리고 사용량을 더 씁니다. |
| 사고(thinking) · 작업량(power) | AI가 얼마나 깊게 고민할지 정하는 다이얼. 높일수록 신중하지만 사용량을 더 씁니다. |
| 토큰(Token) | 구독 계정에 접속하는 열쇠. 여러 개 등록하면 한 계정 한도가 차도 다른 계정으로 자동 전환됩니다. |
| 한도(Limit) | 구독제의 시간당·주간 사용 상한. 다 쓰면 회복 시각까지 기다렸다가 작업을 **자동으로 이어** 합니다. |
| 프로젝트(Project) | AI가 작업할 폴더. 미리 등록한 폴더만 고를 수 있습니다. |

## 이럴 땐 이 명령어 (자주 쓰는 것부터)

명령어는 텔레그램 채팅창에 **`/`로 시작하는 한 줄**을 보내면 됩니다. 외우지 않아도, 채팅창에 `/`만 입력하면 목록이 떠서 골라 쓸 수 있습니다.

| 이럴 때 | 이렇게 |
| --- | --- |
| **새 일을 시키고 싶다** | `/new` → 폴더 고르고 → 할 일을 적어 보냄 |
| **방금 한 대화를 이어가고 싶다** | 그 자리에 **그냥 메시지를 더 보냄** (명령어 없이) |
| **일하는 중에 방향을 바꾸고 싶다** | `/steer 표로 정리해줘`처럼 (지금 즉시 반영) |
| **끝난 뒤에 할 일을 미리 정해두고 싶다** | `/next 끝나면 테스트도 돌려줘` |
| **원하는 상태가 될 때까지 알아서 반복시키고 싶다** | `/goal 모든 테스트가 통과할 때까지` |
| **지금 작업을 멈추고 싶다** | `/stop` |
| **파일을 AI에게 주고 싶다** | 사진·문서·음성을 **그냥 전송** (AI가 알아서 열어 봄) |
| **결과 파일을 휴대폰으로 받고 싶다** | `/upload output/result.pdf` (폴더 안 경로) |
| **지금 어떤 상태인지 보고 싶다** | `/status` |
| **AI 사용량(한도)이 얼마나 남았나** | `/usage` |
| **다른 AI로 바꾸고 싶다 / 모델을 바꾸고 싶다** | `/model` (버튼으로 선택) |
| **승인을 더 엄격하게/느슨하게 하고 싶다** | `/mode` |

<details>
<summary>덜 자주 쓰는 명령어 더 보기</summary>

| 이럴 때 | 이렇게 |
| --- | --- |
| 현재 대화를 복제해 다른 갈래로 실험 | `/fork` |
| AI가 더 깊게 고민하게 (Claude) | `/thinking` |
| AI가 더 많이/적게 일하게 | `/power` |
| 군더더기 없이 최소한으로만 만들게 | `/lean` |
| 대화 맥락만 비우고 다시 시작 | `/reset` |
| 길어진 대화를 요약해 가볍게 | `/compact` |
| 이번에 배운 점을 오래 기억시키기 | `/memory` |
| 최근 작업 목록 보기 | `/sessions` |
| 등록된 폴더 목록 보기 | `/projects` |
| 바뀐 코드 요약 보기 | `/diff` |
| 작업 폴더 추가·삭제 | `/addp`, `/deltp` |
| 이 주제와 기록 삭제 | `/delete` |
| 환경에 문제 없는지 점검 | `/doctor` |

</details>

여기까지가 봇을 **쓰기만** 할 때 알아야 할 전부입니다. 아래 2부는 봇을 직접 설치해 돌리려는 분을 위한 기술 안내입니다.

---

# 2부. 설치·운영 (직접 띄우려는 분)

> 여기부터는 **봇을 직접 설치해 돌리려는 분**을 위한 기술 안내입니다. 봇을 쓰기만 한다면 읽지 않아도 됩니다. 터미널(명령어 입력 창)·Node.js 사용에 익숙하다는 전제로 설명합니다.

이 봇은 내 Mac에 상주하며, 텔레그램 Forum Topic 하나를 AI 세션 하나에 연결한다. 한 토픽에서 **Claude(Agent SDK)**, **Codex(Codex SDK)**, **agy(Antigravity SDK + Gemini API)** 중 하나로 대화하며, 같은 토픽 안에서 제공자를 바꿔도 직전 맥락을 요약으로 인계해 이어 간다.

## 구현된 기능 요약

- `/new` 프로젝트 선택 후, 상시 기본값 패널에서 제공자(Claude/Codex/agy)·모델·사고(thinking 또는 추론 강도)를 고른 뒤 첫 작업 메시지로 새 토픽과 세션 생성
- 토픽의 일반 메시지를 기존 세션으로 이어 가기(Claude는 `resume`, Codex는 스레드 재개, agy는 대화 재개)
- `/model`로 **제공자 전환** — 직전 제공자가 대화 인계 요약을 만들고, 대상 제공자가 그 요약을 받아 이어 감(같은 명령으로 현재 제공자의 모델도 변경)
- 사진·문서·오디오·음성·동영상·원형 동영상·애니메이션(GIF)·스티커를 수신함에 저장하고 그 경로를 AI에게 전달, `/upload 경로`로 작업 폴더(또는 절대경로)의 파일을 토픽에 전송
- 명령: `/new`, `/addp`, `/deltp`, `/steer`, `/next`, `/goal`, `/fork`, `/stop`, `/reset`, `/compact`, `/memory`, `/mode`, `/model`, `/thinking`, `/power`, `/lean`, `/status`, `/sessions`, `/usage`, `/projects`, `/diff`, `/upload`, `/delete`, `/doctor` (`/effort`는 `/power` 호환 별칭)
- 실행 중 메시지 스티어링(`/steer`)과 현재 작업 뒤 후속 작업 예약(`/next`)
- `/goal` 조건 충족까지 자동으로 턴 이어가기(읽기 전용 판정 모델 Claude Haiku로 충족 여부 평가, 최대 25턴) — 세 제공자 모두 동작
- 일반 MCP 60초 타임아웃 및 최대 3회 순차 재시도, 장기 실행 MCP 30분 타임아웃 및 주기적 진행 알림
- 데스크톱 앱과 같은 커넥터(MCP)·스킬·플러그인을 세 제공자가 공유
- Claude 도구 실행 승인/거부와 경로 범위 세션 허용, `AskUserQuestion`(단일/복수 선택, 직접 입력)
- 의미 있는 단계별 중간 응답을 개별 메시지로 스트리밍, 진행 상태는 30초 heartbeat로 갱신, 긴 결과는 파일로 첨부
- 구독 한도(5시간/주간/모델별/Agent SDK 주간) 사용률·초기화 시각 표시, overage 크레딧이 켜진 경우 사용 금액·월 한도 표시
- 여러 Claude OAuth 토큰 한도 자동 전환(`waiting_limit` 대기 후 회복 시각에 자동 재개)
- SQLite에 토픽/세션/프로젝트/승인 메타데이터 저장, 같은 프로젝트의 실행 직렬화, 프로세스 재시작 시 미완료 세션을 `interrupted`로 전환

## 1. Telegram 준비

1. BotFather에서 봇을 만들고 토큰을 받는다.
2. 본인만 있는 슈퍼그룹을 만들고 Topics 기능을 켠다.
3. 봇을 관리자로 추가하고 `Manage Topics`, `Delete Messages` 권한을 준다.
4. 본인 Telegram user ID와 슈퍼그룹 chat ID를 확인한다.

봇은 `.env`의 단일 user ID와 chat ID가 **모두 일치하는** 업데이트만 처리한다.

## 2. 설정

### 제공자별 인증

세 제공자는 각자의 구독 인증을 따른다. **셋을 모두 쓸 필요는 없다.** 쓰려는 제공자만 준비하면 되고, Claude 인증만 갖춰도 봇은 동작한다.

**Claude (필수에 가까움)** — Claude Pro/Max/Team/Enterprise 플랜이 필요하다. Keychain 로그인 대신 `claude setup-token`이 발급하는 장기 OAuth 토큰을 사용한다.

```bash
npm run auth:setup
```

이 명령은 ① `claude setup-token`으로 브라우저 OAuth 인증을 시작하고, ② 터미널에 출력된 `sk-ant-oat01-...` 토큰을 복사해, ③ 숨김 입력 프롬프트에 붙여넣으면, ④ `CLAUDE_CODE_OAUTH_TOKEN`으로 `.env`에 저장하고 파일 권한을 `0600`으로 제한한다. 토큰은 보통 1년 유효하며 Claude 구독으로 추론할 때만 쓰인다(Remote Control 용도가 아니다).

**Codex (선택)** — Codex가 포함된 ChatGPT 구독이 필요하다.

```bash
codex
```

로그인 화면에서 `Sign in with ChatGPT`를 선택한다. 오케스트레이터는 Codex 실행 전에 `~/.codex/auth.json`의 `auth_mode=chatgpt`를 확인하며, API 키 인증이면 실행을 거부한다. Codex 자식 프로세스에서는 `OPENAI_API_KEY`, `CODEX_API_KEY`, API base URL 환경 변수를 제거한다.

**agy (선택)** — Google AI Studio에서 발급한 Gemini API 키가 필요하다. agy는 `google-antigravity` Python SDK의 영속 `Agent` 세션으로 실행하며, 기본 SDK 환경은 `~/.local/share/telegram-claude-orchestrator/agy-sdk`다. 다른 Python 환경을 쓰려면 `.env`의 `AGY_SDK_PYTHON`으로 지정한다.

Claude와 Codex는 구독 인증을 사용한다. agy는 Gemini Developer API의 별도 무료/유료 쿼터를 사용하며 Google AI Pro/Ultra의 Antigravity 구독 한도와는 분리된다.

### 사용량 정책

- Anthropic은 2026년 5월에 Agent SDK·`claude -p`·third-party 앱 사용량을 구독 한도와 분리하려 했으나, **2026년 6월 16일 공식 이메일로 시행을 보류했다.** 현재 해당 사용량은 예전처럼 구독의 5시간·주간 한도에서 차감되며 별도 청구 크레딧은 없다.
- 따라서 봇은 특정 과금 정책을 가정하지 않고, SDK 사용량 엔드포인트의 `rate_limits`가 실제 반환하는 창만 고정 순서로 표시한다: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`, 그리고 overage(usage credits를 켠 경우)일 때 사용 금액·월 한도.
- 존재하지 않는 필드를 추정하거나 날짜로 창을 강등시키지 않으며, 서버가 주는 창을 항상 같은 순서로 보여 회전하지 않는다.

### Telegram·프로젝트 설정 파일

`.env`를 준비한다(이미 있으면 기존 파일을 수정).

```bash
test -f .env || cp .env.example .env
```

`.env`에 Telegram 값을 넣는다. OAuth 토큰은 `npm run auth:setup`이 기록한다.

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
TELEGRAM_CHAT_ID=-100...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
GEMINI_API_KEY=...
```

토큰 파일 권한을 제한한다.

```bash
chmod 600 .env
```

작업 폴더 목록을 등록한다. 실제 경로가 담긴 `projects.json`은 git에서 제외된다.

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

텔레그램에서 `/addp /절대/프로젝트/경로`로 재시작 없이 프로젝트를 추가할 수도 있다(`/addp`만 보낸 뒤 다음 메시지로 경로를 보내도 된다). 실제로 존재하고 읽기·쓰기가 가능한 디렉터리만 등록하며, 폴더명을 프로젝트 이름으로 쓰고 같은 경로는 중복 등록하지 않는다. `/deltp 이름`(또는 별칭)으로 삭제하며, `/deltp`만 입력하면 목록에서 골라 확인 버튼을 눌러야 삭제된다. 삭제는 등록과 메타데이터에서만 제거하고 실제 파일은 건드리지 않으며, 마지막 한 개 프로젝트는 삭제할 수 없다.

Claude Agent SDK에는 `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`을 명시적으로 전달한다. 실행 환경에 `ANTHROPIC_API_KEY`나 `ANTHROPIC_AUTH_TOKEN`이 있어도 Claude 자식 프로세스에서는 제거해 OAuth 인증이 우선되게 하며, Keychain 자격증명은 쓰지 않는다.

### 제공자 선택과 전환

새 세션의 제공자는 상시 기본값 패널(텔레그램 하단 reply 키보드)에서 고른다. 패널은 `🤖 제공자`(Claude → Codex → agy 순환), `🧠 모델`(현재 제공자의 모델 선택), `💭`(Claude면 thinking on/off, Codex와 agy면 추론 강도 순환)로 구성되며, 여기서 정한 값이 **다음에 만드는 새 세션의 기본값**으로 저장된다. `/new` 직후 이 패널과 함께 현재 기본값 요약이 표시된다.

세션 도중 토픽에서 `/model`을 인자 없이 부르면 제공자 전환 버튼(Claude/Codex/agy)과 현재 제공자의 모델 선택 버튼이 함께 나온다. 다른 제공자를 누르면 **직전 제공자가 지금까지의 대화·작업을 한국어로 요약**하고, 그 인계 요약이 다음 사용자 턴의 프롬프트 앞에 한 번 붙어 새 제공자가 맥락을 이어받는다. 전체 원문이 복사되는 것이 아니라 요약으로 인계되며, 한 번도 실행되지 않은 세션은 인계할 맥락이 없어 요약 없이 전환된다. 전환은 유휴 상태에서만 가능하고 실행 중에는 거부된다.

### 모델

- **Claude**: 기본 `claude-opus-4-8`. `/model`로 세션별 변경(Opus 4.8 / Sonnet 4.6 / Fable 5).
- **Codex**: 실행 모델 `gpt-5.5`를 코드에서 명시 강제한다(`~/.codex/config.toml` 기본값이나 Codex 자동 선택에 의존하지 않음).
- **agy**: 기본 `gemini-3.1-pro-preview`. Gemini API가 제공하는 모델 중 `/model`로 세션별 변경한다.

모델·thinking·추론 선택지는 시작 시 제공자 카탈로그(Claude=SDK `supportedModels`, Codex=번들 바이너리 `debug models`, agy=Gemini API `models.list`)를 동적으로 읽어 채운다. 조회에 실패하면 정적 fallback 목록을 쓴다.

### 사고·작업량 다이얼

Claude에는 독립적인 두 노브가 있다.

- `/thinking` — 확장적 사고(extended thinking) on/off. `adaptive`(기본, 필요할 때 스스로 사고)와 `off` 중 선택.
- `/power` — 현재 제공자의 작업량 또는 추론 강도를 조절한다.
  - Claude: `low`, `medium`, `high`(기본), `xhigh`, `max`
  - Codex: `minimal`, `low`, `medium`, `high`(기본), `xhigh`
  - agy: `minimal`, `low`, `medium`, `high`; `reset`으로 API 기본값 복원

각각 인자 없이 부르면 현재 값과 버튼을, 인자를 주면(`/thinking off`, `/power high`) 다음 실행부터 적용한다. 실행 중에는 바꿀 수 없고, `/status`에 `thinking`과 `Claude 작업량`으로 표시된다.

`/effort`는 기존 사용자를 위한 `/power` 호환 별칭이다. 새 명령과 Telegram 공개 명령 목록은 `/power`로 통일한다. agy의 새 세션 기본 추론 강도도 하단 기본값 패널에서 별도로 선택할 수 있다.

`/reset`은 현재 토픽·프로젝트·제공자·모델·권한 설정을 유지한 채 제공자의 대화 재개 문맥만 초기화한다. 실행 중에는 사용할 수 없으며 `/stop` 후 다시 실행해야 한다. agy 토픽의 `/status`에는 저장 상태와 함께 SDK의 라이브 유휴 여부와 대화 턴 수도 표시된다.

`/mode`는 세 제공자에서 같은 의도로 작동한다. Claude는 텔레그램 승인 브로커에 직접 연결되고, Codex는 `plan=read-only`, `default/acceptEdits=workspace-write`, `dontAsk/auto=danger-full-access` 샌드박스로 매핑된다. agy는 `plan`에서 읽기·검색 도구만, 그 외 모드에서 Antigravity SDK의 작업 도구를 프로젝트 workspace 범위로 제공한다.

장기 메모리 경로는 기본 `~/.claude/memory`다. 바꾸려면 `.env`의 `CLAUDE_MEMORY_DIR`을 수정한다.

## 3. 실행

```bash
npm install
npm run build
npm start
```

개발 중에는:

```bash
npm run dev
```

### 사용량과 토큰 자동 전환

`/usage`는 먼저 Claude SDK 사용량 API를 새로 호출해 현재 서버 응답을 확인한다. OAuth 토큰을 여러 개 등록했다면 토큰별로 조회해 보여 주고, 모든 토큰의 실시간 조회가 실패한 경우에만 최근 세션에 저장된 마지막 스냅샷을 대신 표시한다. 실행 중·완료 메시지에도 같은 한도 정보가 포함된다. `total_cost_usd`는 실제 차감액이 아닌 추정치이므로 화면·SQLite에 비용으로 저장하지 않는다.

여러 토큰을 등록하면 한도에 대응해 자동 전환한다. `.env`에 `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3` …를 추가한다(각 계정에서 `claude setup-token`으로 생성). 앞선 "살아있는" 토큰을 우선 쓰고, 실행 중 한 토큰이 한도(사용률 100% 또는 rate-limit 오류)에 도달하면 그 토큰을 초기화 시각까지 봉인한 뒤 다른 살아있는 토큰으로 같은 작업을 즉시 재실행한다(맥락은 `resume`으로 잇는다). 봉인된 토큰이 회복되면 다시 1순위로 돌아온다. 모든 토큰이 동시에 한도에 도달하면 에러로 끝내지 않고 `waiting_limit` 상태로 두었다가, 가장 먼저 회복되는 토큰의 초기화 시각(여유 10초)에 맞춰 자동으로 이어 실행한다. 그 전에 사용자가 새 지시를 보내거나 `/stop`을 누르면 예약은 취소된다. 데몬이 재시작되면 메모리상의 예약 타이머가 사라지므로 해당 세션은 `interrupted`로 복구되고 후속 지시로 재개할 수 있다. (이 전환은 Claude 제공자에 적용된다. Codex·agy는 각자 구독 인증을 따른다.)

### 상태 확인

`/status`는 명령에 응답하는 것으로 오케스트레이터 프로세스가 살아 있음을 확인하고, 세션 토픽 안에서는 해당 작업이 실제로 현재 프로세스에서 실행 중인지 표시한다. 현재 제공자·모델·thinking·작업량·권한 모드·lean·목표 상태를 함께 보여 준다. 실행 중 진행 메시지는 새 도구 호출이 없어도 30초마다 경과시간을 갱신한다.

### 목표 자동 진행 (`/goal`)

`/goal 조건`은 조건이 충족될 때까지 작업을 자동으로 이어 가게 한다. **Claude·Codex·agy 세 제공자 모두에서 동작한다** — 작업 턴은 그 세션의 제공자로 실행하고, 한 턴이 정상 종료될 때마다 작업 제공자와 무관하게 빠른 모델(Claude Haiku)로 "조건이 이미 충족됐는지"를 읽기 전용으로 판정한다(저장소 상태만 확인하므로 제공자 독립적). 미충족이면 같은 목표를 향한 다음 턴을 자동 예약한다(Codex는 직전 스레드, agy는 직전 대화를 재개). 충족되면 목표를 해제하고 알리며, 폭주 방지를 위해 최대 25턴까지만 진행한다. `/goal`만 입력하면 현재 목표를, `/goal clear`는 목표를 해제한다. 유휴 상태에서 걸면 즉시 시작하고, 실행 중에 걸면 현재 턴이 끝난 뒤부터 평가한다. `/stop`이나 `/goal clear`로 언제든 멈출 수 있다. 자동 진행 턴도 일반 실행과 같은 경로를 타므로 Claude 세션에는 토큰 한도 자동 전환과 `waiting_limit` 대기·자동 재개가 그대로 적용된다(Codex·agy는 각자 구독 인증). 목표가 걸린 세션은 `/status`에 `목표(자동 진행)` 줄로 표시된다. (사용량을 빠르게 소모할 수 있으니 `/usage`로 한도를 함께 확인하는 것이 좋다.)

### 최소 구현 원칙 (`/lean`)

새 세션은 기본적으로 `lean on`이다. 불필요한 구현 생략 → 표준 라이브러리 → 플랫폼 기본 기능 → 기존 의존성 → 최소 코드 순서로 해법을 고른다. 세 제공자 모두에 적용되며, 보안·입력 검증·데이터 손실 방지·접근성·명시 요구사항과 실행 가능한 검증은 축소하지 않는다. `/lean off`로 다음 실행부터 끄고 `/lean on`으로 다시 켤 수 있으며 실행 중에는 변경할 수 없다.

### 진행 스트리밍

- **Claude**: 중요한 단계의 짧은 진행 요약을 텍스트 블록 완성 즉시 개별 메시지로 보낸다. 내부 thinking 원문과 토큰 단위 delta는 보내지 않으며, 스트림 뒤 도착하는 완성 메시지와 같은 내용은 중복 전송하지 않는다.
- **Codex**: 도구·파일 변경 등 단계별 진행 요약과 답변 텍스트 델타(`item.updated`)를 흘려보낸다.
- **agy**: Antigravity SDK의 영속 `Agent.chat()` 응답 토큰을 스트리밍하며, 같은 Python 프로세스와 conversation ID로 다음 턴을 이어 간다.

세 제공자 모두 실행 중 답변 본문이 자라는 모습을 `[RUNNING]` 상태 메시지에 끝부분 미리보기(약 1200자)로 디바운스 갱신하고, 완료 시 완성본 전체를 정식 메시지로 보낸다(미리보기와 중복 전송하지 않음).

### 컨텍스트 압축 (`/compact`)과 메모리 (`/memory`)

Claude Code는 컨텍스트 한도에 가까워지면 자동 압축한다. 토픽 작업이 끝난 상태에서 `/compact`를 실행하면 즉시 수동 압축하며, `/compact 인증 변경과 남은 테스트 중심`처럼 보존 초점을 지정할 수 있다. Codex·agy에서는 현재 대화를 인계 요약으로 압축한 뒤 기존 스레드/대화 핸들을 비우고, 다음 턴을 새 대화에서 그 요약으로 이어 간다.

토픽 작업이 끝난 상태에서 `/memory`를 실행하면 해당 세션에서 장기적으로 유효한 사용자 선호·결정·반복 사용 가능한 프로젝트 지식만 선별해 전역 메모리에 기록한다. `/memory 승인 정책 중심`처럼 초점을 지정할 수 있다. 명령 실행 자체를 저장 승인으로 보며, 기존 메모리를 먼저 읽어 중복을 피하고 일시적 상태·추측·비밀정보는 저장하지 않는다. `/compact`·`/memory` 모두 실행 중인 작업과 동시에 수행하지 않는다.

### 실행 중·후속 메시지

- `/steer 지금 결과를 표로 바꿔줘`: 현재 실행 중인 작업에 `priority: now`로 전달.
- `/next 끝나면 테스트도 실행해줘`: 현재 작업 뒤에 `priority: next`로 예약.
- 작업이 끝난 뒤 일반 메시지를 보내면 기존 세션을 이어 간다(Claude는 `resume`, Codex는 직전 스레드, agy는 직전 대화 재개).
- `/fork`는 현재 세션을 새 토픽으로 복제해 같은 맥락에서 분기 작업을 시작한다. Claude는 네이티브 세션 fork를 사용하고, Codex·agy는 현재 대화를 인계 요약으로 복제해 새 스레드/대화에서 시작한다.
- `/delete`를 실행하고 확인하면 Telegram 토픽과 SQLite 세션·승인 기록을 삭제하고 실행·대기 작업도 취소한다. Claude 세션에 한해서 로컬 Claude 대화 원본도 함께 삭제한다.

### 파일 주고받기

토픽에 사진·문서·오디오·음성·동영상·원형 동영상·애니메이션(GIF)·스티커를 보내면 봇이 파일을 **수신함 폴더**(기본 `~/.claude/channels/telegram/inbox`, `.env`의 `FILE_INBOX_DIR`로 변경)에 내려받고, 종류·파일명·**저장 경로**(캡션이 있으면 캡션도)를 메시지로 만들어 AI에게 전달한다. AI는 그 절대경로로 파일을 열어 본다. 파일을 보낸 상황에 따라 새 세션 시작, 실행 중 세션에 전달(`/steer`처럼), 또는 끝난 세션 이어가기로 처리된다. 반대로 `/upload 경로`는 작업 폴더(또는 절대경로)의 파일을 토픽으로 전송한다. 예: `/upload output/result.pdf`. (Telegram Bot API 제한상 20MB를 넘는 파일은 받을 수 없다.)

### MCP 정책

```dotenv
MCP_TOOL_TIMEOUT_SECONDS=60
MCP_MAX_ATTEMPTS=3
CODEX_MCP_TIMEOUT_MINUTES=30
CODEX_MCP_HEARTBEAT_SECONDS=60
LONG_RUNNING_MCP_SERVERS=codex,obsidian
TURN_IDLE_TIMEOUT_MINUTES=35
```

일반 MCP가 timeout, connection closed, transport 오류를 반환하면 동일 입력을 병렬화하지 않고 최대 3회 순차 재시도한다(세 번 모두 실패하면 토픽에 실패 알림). `LONG_RUNNING_MCP_SERVERS`에 등록한 장기 실행 MCP(예: codex, obsidian)는 60초 컷 대신 `CODEX_MCP_TIMEOUT_MINUTES` 하드 타임아웃을 적용하고 `CODEX_MCP_HEARTBEAT_SECONDS`마다 진행 알림을 보낸다. `TURN_IDLE_TIMEOUT_MINUTES`는 스트림이 완전히 침묵할 때 턴을 중단하는 워치독으로, codex·승인 타임아웃보다 항상 5분 이상 크도록 자동 클램프된다.

### 공통 지침·메모리·스킬·커넥터·플러그인 기능

`src/resource-sync.ts`가 Claude·Codex·agy 앞에 하나의 공통 자원 계층을 만든다. 봇 시작 시 한 번 동기화하고(시작 로그에 통합된 스킬·커넥터 수를 출력) Codex·agy 실행 직전에 다시 동기화한다. 생성물은 `~/.claude/shared-resources/`(`RESOURCE.md`, `SKILLS.md`, `MEMORY-BRIDGE.md`, `connectors.json`)에 모인다.

- **전역 지침** — `~/.claude/CLAUDE.md`와 `~/.codex/AGENTS.md`, 프로젝트의 `CLAUDE.md`·`AGENTS.md`를 세 제공자 모두에게 같은 우선순위로 주입한다.
- **전역·자동 메모리** — 명시적으로 선별한 전역 메모리(`~/.claude/memory`), Claude 저장소별 자동 메모리(`~/.claude/projects/<project>/memory`), Codex 자동 메모리(`~/.codex/memories`)를 모두 활성화한다. 인덱스와 자동 메모리 루트를 심볼릭 링크로 연결하고 `MEMORY-BRIDGE.md`를 세 제공자 첫 턴에 주입하여 함께 검색한다. `/memory`로 승인한 사실은 전역 선별 저장소에 기록하고, Claude·Codex의 자동 학습과 요약은 각 네이티브 형식으로 계속 생성된다.
- **스킬·플러그인 워크플로** — Claude/Codex/agy 및 Codex 플러그인 캐시의 모든 `SKILL.md`를 중복 제거해 `~/.claude/shared-resources/SKILLS.md`에 통합한다. 세 제공자의 스킬 디렉터리에는 같은 `shared-skill-router`를 연결하여 작업과 맞는 스킬 원문을 동일하게 읽는다. 플러그인이 제공하는 스킬도 이 카탈로그에 포함된다.
- **커넥터·MCP 도구** — `~/.claude.json`과 `~/.codex/config.toml`의 MCP 서버를 병합한다(같은 이름이면 `~/.claude.json`이 우선). Claude에는 SDK 설정으로 직접 전달하고, Codex는 자기 `config.toml`을 네이티브로 읽으며, agy는 권한 600의 `~/.claude/shared-resources/connectors.json`을 Antigravity SDK의 `mcp_servers`로 직접 로드한다.
- **도구** — 세 제공자는 동일한 MCP 이름과 공통 스킬 지침을 사용하며, 파일·셸·웹·편집 도구는 각 실행기의 네이티브 구현을 `/mode` 권한 경계 안에서 사용한다. 특정 데스크톱 UI에 종속된 플러그인은 공통 스킬과 MCP 기능을 우선 사용한다.

공통 자원 안내서는 `~/.claude/shared-resources/RESOURCE.md`이며 모든 제공자의 첫 턴 지침에 자동 포함된다. Claude의 `settingSources: ['user']`는 사용자 스킬·플러그인을 추가로 발견하되 사전 승인 권한 규칙이 든 `settings.local.json`은 읽지 않으므로 도구 승인 경계는 유지된다.

## 4. Mac 자동 시작

먼저 OAuth·Telegram `.env` 설정과 빌드를 완료한다. 설치 스크립트는 현재 Node 실행 파일과 프로젝트 절대경로로 사용자별 plist를 `~/Library/LaunchAgents`에 생성한다(토큰은 plist에 기록하지 않는다). Node 버전을 바꾸거나 프로젝트 폴더를 옮긴 경우 설치 명령을 다시 실행한다.

```bash
npm run launchd:install
```

재시작(서비스 등록 유지):

```bash
npm run launchd:restart
```

중지(서비스 등록 해제 후 완전 중지):

```bash
launchctl bootout gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

> `bootout`은 재시작이 아니라 서비스를 등록 해제하고 멈추므로, 실행 중인 봇 자신에서 호출하면 후속 시작 명령을 수행할 수 없다. 재시작에는 위 `launchd:restart`를 쓴다.

로그는 `data/stdout.log`와 `data/stderr.log`에 기록된다.

## 권한 정책

- 기본 프로젝트 모드는 `auto`다. Claude의 권한 분류기가 일반적인 파일 편집·명령 실행을 자동 판단하고, 위험하거나 불확실한 작업만 Telegram 승인을 요청한다.
- 토픽에서 `/mode`로 권한 모드를 확인·변경한다.
  - `auto` — (기본) 분류기가 자동 판단하고 위험·불확실한 것만 승인 요청.
  - `default` — 보수적 승인. 도구 실행마다 승인을 묻는다.
  - `acceptEdits` — 파일 편집은 자동 허용, 그 외는 승인.
  - `plan` — 읽기 위주 계획 모드. 모델이 도구로 변경을 시도하면 턴을 종료한다.
  - `dontAsk` — 최소 프롬프트. (`bypassPermissions`는 지원에서 제외했다.)
- `/model`로 제공자·모델을, `/thinking`으로 Claude 사고를, `/power`로 현재 제공자의 작업량·추론 강도를, `/lean`으로 최소 구현 원칙을 세션별로 확인·변경한다(실행 중에는 변경 불가).

## 안전 정책

- 읽기 도구 `Read`, `Glob`, `Grep`, `WebSearch`만 기본 자동 허용한다. `WebFetch`는 URL별 승인을 거친다.
- Claude는 스킬·플러그인·전역 지침 발견을 위해 `settingSources: ['user']`(=`~/.claude/settings.json`)만 읽는다. 사전 승인 권한 규칙이 든 `settings.local.json`(`local` 소스)·프로젝트 설정·로컬 설정은 로드하지 않으므로 모든 도구는 그대로 승인 브로커를 거친다.
- 루트 `CLAUDE.md`와 `AGENTS.md`는 지침으로만 읽으며 도구 권한을 부여하지 않는다.
- `auto` 모드에서 분류기가 승인하지 않은 파일 변경·명령 실행은 Telegram 승인을 거친다.
- `Bash`에는 세션 단위 항상 허용 버튼을 제공하지 않는다. 다른 도구도 SDK가 경로 등 범위를 포함한 규칙을 제안할 때만 그 범위로 허용한다.
- Codex·agy는 비대화식 실행이므로 개별 도구별 텔레그램 승인 대신 `/mode`에 따른 샌드박스와 공통 안전 지침을 적용한다.
- 봇 토큰이 담긴 `.env`, SQLite 데이터, 실제 절대경로가 담긴 `projects.json`은 git에서 제외한다.
- OAuth 토큰은 로그·SQLite·launchd plist에 저장하지 않으며, 로그·전송 전에 토큰·API 키·비밀번호 패턴을 마스킹한다(`src/redaction.ts`).
- `ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`은 Claude 자식 프로세스에서, `OPENAI_API_KEY`·`CODEX_API_KEY`·API base URL은 Codex 자식 프로세스에서 제거한다.

## 현재 제한

- Telegram Bot API는 사용자가 앱에서 직접 삭제한 토픽의 삭제 이벤트를 제공하지 않는다. 로컬 세션까지 지우려면 토픽 안에서 `/delete`를 써야 한다.
- 승인 대기 중 프로세스가 재시작되면 해당 SDK 호출은 복원하지 않고 세션을 `interrupted`로 표시한다(기존 토픽에 후속 지시로 재개 가능).
- 프로젝트별 큐는 충돌 방지를 위해 읽기 전용 작업도 포함해 한 번에 하나씩 실행한다.
- 실제 Telegram 연결 검증에는 유효한 봇 토큰, user ID, forum supergroup ID가 필요하다.
- `setup-token` OAuth는 Remote Control 용도가 아니라 Agent SDK 추론 전용이다.
- 단일 슈퍼그룹만 지원한다.
- 토큰 한도 자동 전환·`waiting_limit` 재개는 Claude 제공자에만 적용된다.

## 개발자 안내

이 절은 코드베이스를 처음 보는 개발자가 구조를 파악하고 기능을 추가할 수 있도록 정리한 것이다.

### 기술 스택

- TypeScript(ESM, `"type": "module"`) + Node.js 22 이상. 빌드는 `tsc`, 테스트는 `vitest`.
- Telegram 봇은 [grammy](https://grammy.dev), Claude 실행은 `@anthropic-ai/claude-agent-sdk`, Codex 실행은 `@openai/codex-sdk`, agy는 Python `google-antigravity` SDK 브리지의 영속 Agent 세션.
- 영속 상태는 `better-sqlite3`(동기 SQLite), 설정 검증은 `zod`, `.env` 로딩은 `dotenv`.

### 소스 구조 (`src/`)

| 파일 | 역할 |
| --- | --- |
| `index.ts` | 진입점. 설정·저장소·모델 카탈로그 로딩, `setMyCommands`로 명령 메뉴 등록 후 봇 시작. 새 슬래시 명령을 메뉴에 노출하려면 여기 목록에도 추가한다. |
| `config.ts` | `.env`·`projects.json`을 읽어 `AppConfig` 생성. `/addp`·`/deltp` 프로젝트 추가·삭제, Claude 실행 파일과 agy SDK Python 경로 해석. |
| `bot.ts` | grammy 봇 본체. 슬래시 명령 핸들러(`bot.command`), 인라인 버튼 콜백(`bot.callbackQuery`), 상시 기본값 패널(`bot.hears`), 미디어 입력(`bot.on("message:*")`), `/status` 포매팅(`formatSessionStatus`). 명령 추가 시 가장 먼저 손대는 파일. |
| `session-manager.ts` | 세션 수명주기·실행 큐. 세 제공자 실행, 스티어링·후속 예약, 제공자 전환 인계 요약(`switchProvider`/`summarizeForHandoff`), 토큰 한도 자동 전환·`waiting_limit` 재개, `/goal` 자동 진행. |
| `agy-interactive.ts` | Python Antigravity SDK 브리지를 영속 프로세스로 관리하고 턴 스트리밍·중단·conversation ID 재개를 처리. |
| `store.ts` | SQLite 스키마·마이그레이션·CRUD. 컬럼 추가 시 기존 DB를 위해 `ALTER TABLE` 마이그레이션을 더한다. |
| `types.ts` | `SessionRecord`, `ProviderKind`, `SessionDefaults` 등 공유 타입. |
| `model-catalog.ts` | 시작 시 세 제공자 카탈로그를 동적으로 읽어 모델·thinking·reasoning 선택지 생성. 실패 시 `FALLBACK_*` 정적 목록. 기본 모델 상수(`DEFAULT_CLAUDE_MODEL`/`DEFAULT_CODEX_MODEL`/`DEFAULT_AGY_MODEL`)도 여기. |
| `permission-broker.ts` | Claude 도구 승인/거부, 경로 범위 세션 허용, `AskUserQuestion` 처리. |
| `token-pool.ts` | 여러 OAuth 토큰 로테이션, 한도/과부하 시 전환·회복 시각 추적. |
| `mcp-policy.ts` | MCP 서버 파싱·타임아웃 적용·재시도 판정(장기 실행 서버만 `alwaysLoad`). |
| `connectors.ts` | `~/.claude.json` + `~/.codex/config.toml`의 MCP 병합, Claude용 설정 생성, Codex·agy용 공통 래퍼 설정 동기화. |
| `resource-sync.ts` | 세 제공자의 전역 지침·메모리·스킬 카탈로그·플러그인 워크플로·커넥터 레지스트리를 하나의 공통 자원 계층으로 생성. |
| `redaction.ts` | 저장·전송 전 토큰·API 키·비밀번호 패턴 마스킹. |
| `usage.ts` | SDK 사용량 응답을 사용자용 문자열로 포매팅. |
| `stream-renderer.ts` | Claude 스트리밍 출력을 Telegram 메시지 단위로 렌더링. |
| `telegram-transport.ts` | Telegram 전송 헬퍼(토픽 생성, 파일 전송)와 오류 메시지 안전 처리(`safeErrorMessage`). |
| `doctor.ts` | `/doctor` 실행 환경 진단. |

`scripts/`는 OAuth/API 키 셋업, LaunchAgent 설치·재시작, Antigravity SDK JSONL 브리지(`agy-sdk-bridge.py`), 공통 커넥터 실행 래퍼(`run-shared-mcp.mjs`)를 포함한다. `tests/`는 vitest 테스트, `launchd/`는 plist 템플릿, `data/`는 런타임 SQLite와 로그(git 제외)다.

### 한 요청이 흐르는 경로

1. `index.ts`가 봇을 시작하고, 허용된 user ID·chat ID에서 온 업데이트만 통과시킨다.
2. 일반 메시지·미디어·슬래시 명령이 `bot.ts` 핸들러로 들어온다.
3. 핸들러가 `store`에서 토픽에 매핑된 세션을 찾아, 작업이면 `SessionManager`에 넘긴다.
4. `SessionManager`가 세션의 제공자에 따라 Claude Agent SDK / Codex SDK / Antigravity SDK를 실행하고, 중간 출력은 `stream-renderer`·`telegram-transport`로 토픽에 보낸다.
5. 세션 상태·승인·기본값은 `store`(SQLite)에 기록된다.

### 슬래시 명령을 추가하는 법

세션별 설정 토글(`/power`, `/lean`, `/thinking`이 같은 패턴)을 예로 든 최소 절차:

1. 새 컬럼이 필요하면 `types.ts`의 `SessionRecord`에 필드를 추가하고, `store.ts`에 `ALTER TABLE` 마이그레이션·`insert`/`update`/`row` 매핑을 더한다.
2. `bot.ts`에 `bot.command("이름", ...)` 핸들러를 추가한다. 인자 없이 부르면 현재 값과 버튼을, 인자가 있으면 검증 후 `store.updateSession`으로 저장한다. 버튼을 쓰면 `bot.callbackQuery(/^prefix:/, ...)` 콜백도 짝으로 추가한다.
3. 값이 실행에 반영돼야 하면 `session-manager.ts`의 해당 실행 경로에서 세션 필드를 읽어 SDK 옵션으로 넘긴다.
4. `/status` 표시가 필요하면 `bot.ts`의 `formatSessionStatus`에 줄을 더한다.
5. 명령 메뉴 노출을 위해 `index.ts`의 `setMyCommands` 목록과 위 README 명령 목록에 추가한다.
6. `tests/`에 동작 테스트를 추가한다.

### 개발 워크플로

```bash
npm install
npm run dev        # tsx watch 핫 리로드
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # dist/로 컴파일 (npm start가 사용)
```

변경을 머지하기 전에 `npm run typecheck`, `npm test`, `npm run build`가 모두 통과해야 한다. 봇 핸들러를 바꿨다면 `tests/bot.test.ts`처럼 grammy 핸들러를 직접 호출하는 테스트로 회귀를 막는다.
