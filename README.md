# Telegram Claude Orchestrator

Mac에 켜 두고 Telegram으로 조작하는 개인용 AI 작업 도우미입니다.

Telegram에 “이 프로젝트 README를 고쳐줘”, “방금 만든 기능 테스트해줘”, “이 PDF를 읽고 핵심만 정리해줘”처럼 평소 말하듯 요청하면, Mac에서 실행 중인 Claude Agent SDK가 지정된 프로젝트 폴더를 읽고 필요한 작업을 수행합니다. 작업이 오래 걸리면 Telegram으로 진행 상황을 알려 주고, 위험하거나 판단이 필요한 파일 수정·명령 실행은 버튼으로 승인받습니다.

이 저장소는 여러 사람이 함께 쓰는 공개 챗봇이 아니라, 한 명의 사용자가 자신의 Mac, 자신의 Telegram 비공개 그룹, 자신의 Claude/ChatGPT 구독을 연결해 쓰는 도구입니다.

## 한 문장으로 이해하기

이 프로그램은 “Telegram을 리모컨으로 쓰는 Claude 작업 관리자”입니다.

- Mac에는 이 프로그램이 계속 실행됩니다.
- 사용자는 Telegram 그룹에서 명령을 보냅니다.
- Telegram의 토픽 하나가 Claude 작업 대화 하나가 됩니다.
- Claude는 사용자가 등록한 프로젝트 폴더 안에서 파일을 읽고, 고치고, 테스트를 실행합니다.
- 큰 작업은 `/plan`으로 계획, 승인, Codex 실행, Claude 검토를 분리해서 처리합니다.
- 실행 기록, 세션 상태, 승인 기록, `/plan` 증거는 로컬 SQLite 데이터베이스에 저장됩니다.

## 누가 쓰면 좋은가요?

이 도구는 다음 상황을 위해 만들었습니다.

- Mac에 있는 여러 프로젝트를 밖에서도 Telegram으로 관리하고 싶을 때
- Claude에게 코드 수정, 문서 정리, 파일 분석, 테스트 실행을 맡기고 싶을 때
- 작업 중간 진행 상황을 계속 받고 싶을 때
- AI가 파일을 바꾸거나 명령을 실행하기 전에 Telegram에서 승인하고 싶을 때
- 긴 작업을 “계획 작성 → 내가 승인 → Codex 구현 → Claude 검토” 흐름으로 안전하게 처리하고 싶을 때
- 작업별 대화가 Telegram 토픽으로 나뉘어 남기를 원할 때

개발 지식이 많지 않아도 사용할 수 있도록 Telegram 명령 중심으로 설계했습니다. 다만 설치에는 Mac 터미널, Telegram 봇 생성, Claude/ChatGPT 로그인 준비가 필요합니다.

## 전체 그림

```text
사용자
  ↓ Telegram 메시지
비공개 Telegram 슈퍼그룹
  ↓ Bot API
Mac에서 실행 중인 오케스트레이터
  ↓ Claude Agent SDK
Claude가 프로젝트 폴더에서 작업
  ↓ 필요 시
Codex가 /plan 구현 단계 수행
  ↓
결과, 질문, 승인 요청, 진행 상황을 Telegram으로 전송
```

중요한 점은 모든 프로젝트 파일과 작업 기록이 기본적으로 내 Mac 안에 있다는 것입니다. `.env`, `projects.json`, `data/`는 Git에 올리지 않도록 제외되어 있습니다.

## 주요 기능

- Telegram `/new`로 새 작업 토픽 생성
- 기존 토픽에서 일반 메시지를 보내 Claude 세션 이어가기
- `/plan`으로 계획, 사용자 승인, Codex 구현, Claude 검토를 분리한 파이프라인 실행
- `/steer`로 실행 중인 작업에 즉시 방향 전환 지시
- `/next`로 현재 작업 뒤에 이어서 할 일 예약
- `/stop`으로 실행 중인 작업 중단
- `/fork`로 현재 대화를 바탕으로 새 방향의 작업 분기
- `/compact`로 긴 Claude 대화 압축
- `/memory`로 장기적으로 유효한 사용자 선호와 프로젝트 지식 저장
- `/model`, `/thinking`, `/lean`, `/mode`로 세션별 실행 방식 조정
- Claude 모델 목록은 시작 시 Anthropic Models API에서 읽고, 모델별 thinking/effort 지원 단계만 버튼으로 표시
- Codex 모델 목록은 `codex debug models` 카탈로그에서 읽고, 모델별 reasoning 지원 단계만 버튼으로 표시
- Telegram 파일 수신: 사진, 문서, 오디오, 음성, 동영상, GIF, 스티커 등
- `/upload`로 Claude가 만든 파일을 Telegram으로 전송
- `/usage`로 Claude 구독 한도 사용량 확인
- `/status`로 현재 실행 상태 확인
- `/doctor`로 설정, 인증, Telegram 연결, 저장소 상태 진단
- 같은 프로젝트 작업은 충돌 방지를 위해 직렬 실행
- MCP 오류는 같은 입력을 순서대로 최대 3회 재시도
- Codex MCP 같은 장기 작업은 긴 타임아웃과 주기적 진행 알림 적용
- Claude OAuth 토큰을 최대 3개까지 등록해 한도 도달 시 다음 토큰으로 자동 전환

## 처음 보는 용어

| 용어 | 뜻 |
| --- | --- |
| Telegram 봇 | Telegram 안에서 메시지를 받고 답장하는 계정입니다. BotFather로 만듭니다. |
| 슈퍼그룹 | Telegram의 고급 그룹 형태입니다. 토픽 기능을 켤 수 있습니다. |
| 토픽 | Telegram 슈퍼그룹 안의 작은 게시판/대화방입니다. 이 프로그램은 작업 하나를 토픽 하나로 관리합니다. |
| 프로젝트 | Claude가 작업할 수 있는 Mac의 폴더입니다. 예: 웹사이트 폴더, 노트 폴더, 코드 저장소. |
| Claude Agent SDK | Claude가 로컬 폴더에서 파일 읽기, 수정, 명령 실행을 할 수 있게 해 주는 도구입니다. |
| Codex | `/plan`에서 승인된 계획을 실제로 구현하고 검증하는 실행 담당입니다. |
| SQLite | 별도 서버 없이 파일 하나로 동작하는 로컬 데이터베이스입니다. 세션 상태와 작업 증거를 저장합니다. |
| `.env` | Telegram 토큰, Claude OAuth 토큰 같은 비밀 설정을 저장하는 파일입니다. 절대 공개하면 안 됩니다. |
| `projects.json` | Claude에게 작업을 맡길 프로젝트 폴더 목록입니다. 개인 경로가 들어가므로 Git에 올리지 않습니다. |

## 설치 전 준비물

다음이 필요합니다.

- macOS
- Node.js 22 이상
- Telegram 계정
- 본인만 쓰는 비공개 Telegram 슈퍼그룹
- BotFather로 만든 Telegram 봇
- Claude Pro, Max, Team 또는 Enterprise 등 Agent SDK를 사용할 수 있는 Claude 구독
- `/plan`을 쓸 경우 Codex가 포함된 ChatGPT 구독
- 로컬 터미널에서 `claude setup-token`을 실행할 수 있는 Claude CLI 환경
- 로컬 터미널에서 `codex`를 실행할 수 있는 Codex CLI 환경

설치가 어렵게 느껴진다면, 큰 흐름은 다음 5단계라고 보면 됩니다.

1. Telegram 봇과 비공개 그룹을 만든다.
2. 이 저장소를 Mac에 내려받고 의존성을 설치한다.
3. `.env`에 Telegram과 Claude 인증 정보를 넣는다.
4. `projects.json`에 Claude가 작업할 폴더를 등록한다.
5. 프로그램을 실행하고 Telegram에서 `/status`로 확인한다.

## 설치

### 1. 저장소 내려받기

```bash
git clone https://github.com/neam-kim/telegram-claude_SDK.git
cd telegram-claude_SDK
npm install
```

`npm install`은 이 프로그램이 쓰는 부품을 내려받는 단계입니다. 처음 한 번 필요하고, 의존성이 바뀌었을 때 다시 실행합니다.

### 2. Telegram 봇 만들기

1. Telegram에서 `@BotFather`를 엽니다.
2. `/newbot`으로 새 봇을 만듭니다.
3. BotFather가 알려 주는 봇 토큰을 복사합니다.
4. 본인만 있는 비공개 슈퍼그룹을 만듭니다.
5. 그룹 설정에서 Topics 기능을 켭니다.
6. 만든 봇을 그룹 관리자로 추가합니다.
7. 봇에게 `Manage Topics`, `Delete Messages` 권한을 줍니다.
8. 본인의 Telegram user ID와 슈퍼그룹 chat ID를 확인합니다.

이 프로그램은 `.env`에 적힌 사용자 ID와 그룹 ID가 모두 일치하는 메시지만 처리합니다. 다른 사람이 봇에게 메시지를 보내거나, 다른 그룹에서 호출해도 무시합니다.

### 3. Claude OAuth 토큰 준비

Claude Agent SDK는 일반 API 키 대신 `claude setup-token`으로 만든 OAuth 토큰을 사용합니다.

```bash
npm run auth:setup
```

이 명령은 다음 순서로 진행됩니다.

1. 브라우저에서 Claude 로그인을 엽니다.
2. 터미널에 `sk-ant-oat01-...` 형태의 토큰이 표시됩니다.
3. 그 토큰을 복사합니다.
4. 숨김 입력 프롬프트에 붙여넣습니다.
5. `.env`의 `CLAUDE_CODE_OAUTH_TOKEN`에 저장합니다.
6. `.env` 파일 권한을 `0600`으로 맞춥니다.

토큰은 비밀번호처럼 다뤄야 합니다. README, 이슈, 채팅, 로그, Git 커밋에 넣지 마세요.

추가 Claude 계정 토큰이 있다면 `.env`에 `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3`으로 넣을 수 있습니다. 한 토큰이 사용량 한도에 도달하면 다음 새 세션부터 사용 가능한 토큰을 고릅니다. 한도 회복 시각이 있으면 그때까지 해당 토큰을 쉬게 하고, 없으면 기본 1시간 동안 다시 시도하지 않습니다.

### 4. Codex 로그인 준비

`/plan`의 구현 단계는 Codex CLI의 ChatGPT 구독 로그인을 사용합니다. OpenAI API 키 과금으로 우회하지 않습니다.

```bash
codex
```

로그인 화면에서 `Sign in with ChatGPT`를 선택합니다. 이 프로그램은 Codex 실행 전에 `~/.codex/auth.json`의 `auth_mode=chatgpt`를 확인합니다. API 키 인증이면 실행을 거부합니다. Codex 자식 프로세스에서도 `OPENAI_API_KEY`, `CODEX_API_KEY`, API base URL 환경 변수를 제거합니다.

Codex 모델 목록은 실행 시점에 다음 명령이 반환하는 카탈로그를 읽어 구성합니다.

```bash
codex debug models
```

따라서 Codex CLI가 새 모델이나 새 reasoning 단계를 제공하면, 코드에 모델명을 추가하지 않아도 다음 실행부터 Telegram 선택 버튼에 반영됩니다. 이 명령이 실패하면 안전한 기본 후보로 내려갑니다.

### 5. `.env` 만들기

`.env`가 없다면 예시 파일을 복사합니다.

```bash
test -f .env || cp .env.example .env
```

`.env`에 Telegram 값과 Claude OAuth 토큰을 넣습니다.

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_CHAT_ID=-1001234567890
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-replace-me

# 선택: 추가 Claude 계정 토큰
# CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-replace-me
# CLAUDE_CODE_OAUTH_TOKEN_3=sk-ant-oat01-replace-me
```

파일 권한을 다시 확인합니다.

```bash
chmod 600 .env
```

권한이 `0600`이 아니면 프로그램이 시작을 거부합니다. 이는 다른 사용자가 토큰을 읽지 못하게 하기 위한 안전장치입니다.

### 6. 작업할 프로젝트 등록

예시 파일을 복사합니다.

```bash
cp projects.example.json projects.json
```

`projects.json`에 Claude가 작업할 폴더를 등록합니다.

```json
[
  {
    "name": "website",
    "aliases": ["web", "site"],
    "cwd": "/Users/me/work/website",
    "defaultMode": "auto"
  }
]
```

각 항목의 뜻은 다음과 같습니다.

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `name` | 예 | Telegram에서 보일 프로젝트 이름입니다. |
| `aliases` | 아니요 | `/new web`처럼 짧게 부를 별칭입니다. |
| `cwd` | 예 | 실제 프로젝트 폴더의 절대경로입니다. |
| `defaultMode` | 아니요 | 새 세션의 기본 승인 방식입니다. 권장값은 `auto`입니다. |

`cwd`는 반드시 실제로 존재하고 읽기·쓰기가 가능한 폴더여야 합니다. 상대경로가 아니라 `/Users/...`처럼 시작하는 절대경로를 넣어야 합니다.

프로그램 실행 후 Telegram에서 프로젝트를 추가할 수도 있습니다.

```text
/addp /Users/me/work/new-project
```

프로젝트 삭제는 다음처럼 합니다.

```text
/deltp website
```

삭제는 `projects.json`의 등록만 제거합니다. 실제 폴더와 파일은 지우지 않습니다. 마지막 프로젝트 하나는 삭제할 수 없습니다.

### 7. 빌드와 실행

```bash
npm run build
npm start
```

Telegram 그룹에서 다음을 입력해 봅니다.

```text
/status
```

응답이 오면 봇이 살아 있는 것입니다. 이어서 다음 명령으로 전체 설정을 점검합니다.

```text
/doctor
```

개발 중에는 파일 변경을 감지해 다시 실행하는 명령을 쓸 수 있습니다.

```bash
npm run dev
```

## Mac 로그인 시 자동 실행

매번 터미널에서 `npm start`를 실행하지 않으려면 LaunchAgent를 설치합니다.

```bash
npm run launchd:install
```

이 명령은 현재 Node 실행 파일과 현재 프로젝트 경로를 사용해 `~/Library/LaunchAgents`에 사용자용 자동 실행 설정을 만듭니다. `.env`의 토큰은 plist에 기록하지 않습니다.

프로그램을 재시작해야 할 때는 다음 명령을 씁니다.

```bash
npm run launchd:restart
```

중지하려면 다음을 사용합니다.

```bash
launchctl bootout gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

주의: `bootout`은 재시작이 아니라 등록 해제에 가까운 중지입니다. 일반적인 재시작은 `npm run launchd:restart`를 사용하세요.

로그는 다음 파일에 남습니다.

```text
data/stdout.log
data/stderr.log
```

Node 버전을 바꾸거나 프로젝트 폴더를 옮겼다면 `npm run launchd:install`을 다시 실행해야 합니다. LaunchAgent가 이전 Node 경로나 이전 프로젝트 경로를 기억하고 있을 수 있기 때문입니다.

## Telegram에서 쓰는 기본 흐름

### 새 작업 시작

그룹의 기본 대화방에서 입력합니다.

```text
/new
```

그러면 버튼이 순서대로 나옵니다.

1. 프로젝트 선택
2. Claude 모델 선택
3. 선택한 Claude 모델이 지원하는 thinking/effort 수준 선택
4. 작업 내용 입력

예를 들어 이렇게 요청할 수 있습니다.

```text
README를 처음 설치하는 사람도 이해할 수 있게 다시 써줘.
```

작업이 시작되면 새 Telegram 토픽이 만들어지고, 이후 진행 상황과 결과는 그 토픽 안에서 이어집니다.

프로젝트 이름을 알고 있다면 바로 지정할 수 있습니다.

```text
/new website
```

### 기존 작업 이어가기

이미 만들어진 작업 토픽 안에서 일반 메시지를 보내면 됩니다.

```text
방금 수정한 부분에 테스트도 추가해줘.
```

이 메시지는 기존 Claude 세션을 이어서 실행합니다. 앞서 주고받은 문맥과 작업 내용이 유지됩니다.

### 실행 중인 작업에 방향 전환하기

작업이 아직 실행 중일 때 지금 바로 반영할 지시는 `/steer`를 씁니다.

```text
/steer 코드 수정 전에 원인 분석을 먼저 정리해줘.
```

현재 작업이 끝난 뒤 처리할 내용은 `/next`를 씁니다.

```text
/next 작업이 끝나면 테스트를 실행하고 변경 내용을 요약해줘.
```

일반 메시지와 구분하는 이유는 간단합니다. 일반 메시지는 보통 “이전 작업이 끝난 뒤 이어서 새 요청”이고, `/steer`는 “지금 실행 중인 작업에 즉시 반영”, `/next`는 “현재 작업 뒤에 예약”이라는 의미를 명확히 하기 위해서입니다.

### 작업 중단

```text
/stop
```

실행 중인 Claude 작업에 중단 요청을 보냅니다. 중단한 뒤 같은 토픽에 새 메시지를 보내면 기존 문맥을 바탕으로 다시 이어갈 수 있습니다.

### 다른 방향으로 분기

```text
/fork
```

완료된 세션을 바탕으로 새 작업 토픽을 만듭니다. 기존 토픽은 그대로 두고, 같은 문맥에서 다른 접근을 시도할 때 사용합니다.

## `/plan` 파이프라인

일반 메시지는 Claude가 바로 작업합니다. `/plan`은 더 조심스럽게 처리해야 하는 작업을 위한 절차입니다.

```text
/plan 로그인 방식을 JWT에서 세션 쿠키 방식으로 바꿔줘.
```

흐름은 다음과 같습니다.

1. Claude가 먼저 코드를 읽고 실행 계획을 씁니다.
2. Claude가 완료 기준을 `[ACCEPTANCE_CRITERIA]`로 정리합니다.
3. Telegram에 계획이 표시되고 사용자가 승인하거나 거절합니다.
4. 승인되면 Codex가 구현과 검증을 수행합니다.
5. Codex의 명령, 종료 코드, 변경 파일, MCP 호출, 최종 응답, `git status`, `git diff`가 SQLite 증거 원장에 저장됩니다.
6. Claude가 증거를 보고 각 완료 기준을 `pass`, `fail`, `blocked`로 판정합니다.
7. 모든 기준이 `pass`이고 최종 판정이 `APPROVE`일 때만 작업을 완료 처리합니다.

검토가 실패하면 같은 Codex 스레드에서 차단 문제를 수정하고 다시 검증합니다. 최대 3회까지만 반복합니다. 3회 뒤에도 승인되지 않으면 `verification_failed`로 끝냅니다.

`/plan`은 다음 같은 작업에 적합합니다.

- 여러 파일을 고치는 기능 추가
- 회귀 테스트가 필요한 버그 수정
- 공개 배포 전 검증이 중요한 변경
- 사용자 승인 없이 바로 구현하면 위험한 작업
- 완료 여부를 증거로 확인해야 하는 작업

## 모델, thinking, reasoning, lean 모드

### Claude 모델

새 작업을 시작할 때 Claude 모델을 고릅니다. 작업 토픽 안에서 나중에 바꿀 수도 있습니다.

프로그램은 시작할 때 Anthropic Models API를 호출해 현재 계정에서 확인 가능한 Claude 모델 목록과 각 모델의 기능 정보를 읽습니다. 모델 API가 실패하면 `Opus`, `Sonnet`, `Fable` 계열의 안전한 기본 목록을 사용합니다.

```text
/model
/model opus
/model sonnet
/model fable
```

`/model`을 인자 없이 입력하면 현재 모델과 선택 가능한 모델 버튼이 표시됩니다. 버튼은 고정된 3개 목록이 아니라 시작 시점에 로딩된 모델 카탈로그를 기준으로 만들어집니다. 모델을 바꾸면 기존 thinking 값이 새 모델에서 지원되는지 확인하고, 지원되지 않으면 가장 가까운 기본값으로 자동 보정합니다.

변경은 다음 실행부터 적용됩니다. 이미 실행 중인 작업에는 적용되지 않습니다.

### Claude thinking/effort 수준

Thinking은 Claude가 답하기 전에 얼마나 깊게 검토할지 정하는 설정입니다. 최신 Claude 모델은 adaptive thinking과 별도의 effort 수준을 지원할 수 있으므로, 이 프로그램은 선택한 모델이 지원하는 단계만 보여 줍니다.

```text
/thinking
/thinking adaptive
/thinking low
/thinking medium
/thinking high
/thinking xhigh
/thinking max
/thinking off
```

- `adaptive`: Claude가 작업 난이도에 맞춰 자동 조절
- `low`: 빠른 응답을 우선하는 낮은 effort
- `medium`: 속도와 검토 깊이의 균형
- `high`: 복잡한 작업을 위한 높은 effort
- `xhigh`: 더 깊은 검토가 필요한 작업용
- `max`: 해당 모델이 지원하는 최대 effort
- `off`: 확장 thinking을 끄고 빠르게 처리

모든 모델이 모든 단계를 지원하는 것은 아닙니다. 예를 들어 어떤 모델은 `max`를 지원하지 않을 수 있습니다. 그런 경우 버튼에 나타나지 않고, 직접 입력해도 거부됩니다.

### Codex 모델과 reasoning 수준

`/plan`을 시작하면 Claude가 계획을 작성하기 전에 Codex 모델을 고릅니다. Codex 모델 목록은 `codex debug models`의 실제 카탈로그에서 읽어 오며, 각 모델이 지원하는 reasoning 단계도 함께 가져옵니다.

흐름은 다음과 같습니다.

1. 작업 토픽에서 `/plan 작업 내용`을 입력합니다.
2. Telegram에 현재 Codex CLI가 제공하는 모델 버튼이 표시됩니다.
3. 모델을 고르면 그 모델이 지원하는 reasoning 단계 버튼이 표시됩니다.
4. reasoning 단계를 고르면 Claude 계획, 사용자 승인, Codex 실행, Claude 검토 파이프라인이 시작됩니다.

Codex reasoning은 다음 계열을 사용할 수 있습니다. 실제 버튼은 선택한 모델의 카탈로그에 따라 달라집니다.

```text
minimal
low
medium
high
xhigh
```

이 구조 때문에 새 Codex 모델이 추가되거나 reasoning 단계가 바뀌어도, Codex CLI 카탈로그가 갱신되어 있으면 코드 수정 없이 선택 목록이 바뀝니다.

### Lean 모드

새 세션은 기본적으로 `lean on`입니다.

```text
/lean
/lean on
/lean off
```

Lean 모드는 [Ponytail](https://github.com/DietrichGebert/ponytail)의 최소 구현 원칙에서 착안했습니다. Claude와 Codex가 문제를 풀 때 다음 순서를 우선합니다.

1. 불필요한 구현은 하지 않는다.
2. 표준 라이브러리로 해결할 수 있으면 먼저 쓴다.
3. 플랫폼 기본 기능을 활용한다.
4. 이미 있는 의존성을 활용한다.
5. 그래도 필요할 때만 최소한의 새 코드를 작성한다.

단, 보안, 입력 검증, 데이터 손실 방지, 접근성, 사용자가 명시한 요구사항, 실행 가능한 검증은 줄이지 않습니다.

## 권한 모드

세션 토픽에서 `/mode`로 현재 승인 방식을 확인하거나 변경할 수 있습니다.

```text
/mode
/mode auto
/mode default
/mode acceptEdits
/mode plan
/mode dontAsk
```

| 모드 | 설명 |
| --- | --- |
| `auto` | 기본 권장값입니다. 일반적인 작업은 자동 판단하고 위험하거나 불확실한 작업만 승인 요청합니다. |
| `default` | 더 보수적으로 파일 수정과 명령 실행 승인을 받습니다. |
| `acceptEdits` | 일반적인 파일 편집 승인을 줄입니다. |
| `plan` | 실제 변경보다 계획 수립 중심으로 동작합니다. |
| `dontAsk` | 추가 질문 없이 허용된 범위에서만 진행합니다. |

실행 중에는 권한 모드를 바꿀 수 없습니다. 작업 완료 또는 `/stop` 이후 변경하세요.

## Telegram 명령어 모음

### 어디서나 사용할 수 있는 명령

| 명령 | 설명 | 예시 |
| --- | --- | --- |
| `/start` | 사용 가능한 주요 명령을 간단히 보여 줍니다. | `/start` |
| `/new` | 프로젝트를 선택해 새 작업을 시작합니다. | `/new` |
| `/new 이름` | 지정한 프로젝트에서 새 작업을 시작합니다. | `/new website` |
| `/projects` | 등록된 프로젝트 이름, 별칭, 폴더 경로를 보여 줍니다. | `/projects` |
| `/addp 경로` | 실행 중인 봇에 프로젝트 폴더를 추가합니다. | `/addp /Users/me/work/app` |
| `/deltp 이름` | 등록된 프로젝트를 제거합니다. 실제 폴더는 삭제하지 않습니다. | `/deltp website` |
| `/sessions` | 최근 작업 15개와 토픽 링크를 보여 줍니다. | `/sessions` |
| `/status` | 봇 프로세스, 현재 작업, 저장된 세션 수를 보여 줍니다. | `/status` |
| `/usage` | 가장 최근 Claude 사용량 스냅샷을 보여 줍니다. | `/usage` |
| `/doctor` | 인증, Telegram, 프로젝트, 저장소, 자동 실행, 로그를 점검합니다. | `/doctor` |

### 작업 토픽에서 사용하는 명령

| 명령 | 설명 | 예시 |
| --- | --- | --- |
| `/plan 작업` | 계획, 승인, Codex 구현, Claude 검토 파이프라인을 시작합니다. | `/plan 인증 버그 수정` |
| `/steer 지시` | 실행 중인 작업에 즉시 반영할 지시를 보냅니다. | `/steer 원인 분석 먼저` |
| `/next 지시` | 현재 작업 뒤에 이어서 할 일을 예약합니다. | `/next 테스트 실행` |
| `/stop` | 현재 실행 중인 작업을 중단합니다. | `/stop` |
| `/fork` | 현재 대화를 바탕으로 새 작업 토픽을 만듭니다. | `/fork` |
| `/compact` | 긴 Claude 대화를 압축합니다. | `/compact 인증 변경 중심` |
| `/memory` | 장기적으로 유효한 사용자 선호와 프로젝트 지식을 저장합니다. | `/memory 배포 절차 중심` |
| `/mode` | 권한 모드를 확인하거나 변경합니다. | `/mode auto` |
| `/model` | 현재 카탈로그의 Claude 모델을 확인하거나 변경합니다. | `/model sonnet` |
| `/thinking` | 현재 Claude 모델이 지원하는 thinking/effort 수준을 확인하거나 변경합니다. | `/thinking high` |
| `/lean` | 최소 구현 원칙 적용 여부를 확인하거나 변경합니다. | `/lean off` |
| `/diff` | 현재 프로젝트의 Git 변경 통계를 보여 줍니다. | `/diff` |
| `/upload 경로` | 지정한 파일을 Telegram으로 전송합니다. | `/upload output/report.pdf` |
| `/delete` | 토픽, 로컬 세션 기록, Claude 대화 원본을 함께 삭제합니다. | `/delete` |

`/delete`는 확인 버튼을 한 번 더 누르게 합니다. 삭제 후에는 복구할 수 없습니다.

## 파일 주고받기

### 사용자가 Claude에게 파일 보내기

Telegram 토픽에 파일을 첨부하면 봇이 로컬 inbox에 저장하고 Claude에게 파일 경로를 알려 줍니다.

기본 저장 위치:

```text
~/.claude/channels/telegram/inbox/
```

지원하는 Telegram 파일 종류:

| 종류 | 설명 |
| --- | --- |
| 사진 | 일반 사진 첨부입니다. Telegram이 압축할 수 있습니다. |
| 문서 | 원본 파일을 유지합니다. PDF, 코드, 압축 파일 등에 적합합니다. |
| 오디오 | 음악 또는 오디오 파일입니다. |
| 음성 메시지 | Telegram 마이크 녹음입니다. |
| 동영상 | 동영상 파일입니다. |
| 원형 동영상 | Telegram의 원형 영상 메시지입니다. |
| 애니메이션/GIF | GIF 또는 짧은 무음 영상입니다. |
| 스티커 | 스티커 파일입니다. |

예시:

```text
(PDF 첨부) 이 논문의 핵심 내용을 5줄로 요약해줘.
```

```text
(스크린샷 첨부) 이 화면에서 어색한 UI를 찾아서 고쳐줘.
```

세션이 없는 곳에서 파일을 보내면, 봇은 파일을 저장한 뒤 `/new`로 작업을 시작하라고 안내합니다.

### Claude가 만든 파일 받기

작업 토픽에서 `/upload`를 사용합니다.

```text
/upload output/result.pdf
```

상대경로는 해당 세션의 프로젝트 폴더 기준입니다. 절대경로도 사용할 수 있습니다.

## 사용량과 토큰 풀

`/usage`는 가장 최근 Claude SDK 사용량 스냅샷을 보여 줍니다. 실행 중 상태 메시지와 완료 메시지에도 같은 한도 정보가 포함됩니다.

표시 대상은 SDK가 실제로 반환하는 한도 창입니다.

- 5시간 한도
- 7일 한도
- Opus 7일 한도
- Sonnet 7일 한도
- OAuth 앱 주간 한도
- overage가 켜진 경우 추가 사용량

`total_cost_usd`는 실제 청구액이 아니라 클라이언트 추정치일 수 있으므로 사용자 화면과 SQLite에 비용으로 저장하지 않습니다.

Claude OAuth 토큰을 여러 개 넣은 경우, 프로그램은 토큰 풀을 만듭니다.

- 기본 토큰부터 사용합니다.
- 사용량 스냅샷에서 한도 사용률이 100%에 도달한 토큰은 회복 시각까지 제외합니다.
- rate-limit 오류가 나면 해당 토큰을 잠시 제외합니다.
- 사용 가능한 다음 토큰이 있으면 새 세션부터 그 토큰을 사용합니다.
- 이 상태는 메모리에만 보관되므로 데몬 재시작 후에는 다시 감지합니다.

## 진행 상황 알림

작업 중 봇은 다음을 Telegram으로 알려 줍니다.

- Claude가 작업 중이라는 상태
- 의미 있는 중간 진행 요약
- 도구 실행 승인 요청
- 사용자 선택 질문
- 긴 작업의 경과 시간
- Codex 실행 중 상태
- 완료 결과
- 긴 결과의 파일 첨부

내부 thinking 원문과 토큰 단위의 미완성 문장은 보내지 않습니다. 스트리밍으로 보낸 내용과 최종 result가 같으면 중복 전송하지 않습니다.

## MCP와 장기 작업

MCP는 Claude가 외부 도구를 쓰기 위한 연결 방식입니다. 이 프로젝트에서는 일반 MCP와 Codex MCP를 다르게 다룹니다.

`.env`에서 조정할 수 있는 값:

```dotenv
MCP_TOOL_TIMEOUT_SECONDS=60
MCP_MAX_ATTEMPTS=3
CODEX_MCP_TIMEOUT_MINUTES=30
CODEX_MCP_HEARTBEAT_SECONDS=60
LONG_RUNNING_MCP_SERVERS=codex,obsidian
TURN_IDLE_TIMEOUT_MINUTES=35
```

- 일반 MCP는 60초 타임아웃을 기본으로 합니다.
- timeout, connection closed, transport 오류는 같은 입력으로 최대 3회 순차 재시도합니다.
- Codex 같은 장기 작업 MCP는 30분까지 기다릴 수 있습니다.
- 장기 작업 중에는 60초마다 진행 중 알림을 보냅니다.
- Codex MCP만 세션 시작 시 `alwaysLoad`로 연결합니다.
- 다른 MCP는 지연 로딩을 유지해 시작 지연과 프롬프트 비대화를 줄입니다.

## 안전 정책

이 도구는 로컬 파일과 명령을 다루므로 안전 정책이 중요합니다.

- 봇은 `.env`에 지정한 Telegram 사용자 한 명과 그룹 하나만 받습니다.
- `.env`, `projects.json`, `data/`는 Git에 올리지 않습니다.
- OAuth 토큰은 로그, SQLite, launchd plist에 저장하지 않습니다.
- 저장 전 계획, 완료 기준, 검토문, 명령 출력에서 토큰·API 키·비밀번호 패턴을 마스킹합니다.
- Claude 자식 프로세스에서는 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`을 제거해 `.env`의 OAuth 토큰이 우선되게 합니다.
- Codex 자식 프로세스에서는 OpenAI API 키와 API base URL 환경 변수를 제거합니다.
- 사용자·프로젝트·로컬 Claude 설정의 사전 승인 규칙은 로드하지 않습니다.
- 루트 `CLAUDE.md`와 `AGENTS.md`는 지침으로만 읽고 도구 권한 부여에는 쓰지 않습니다.
- `WebFetch`는 URL별 승인을 거칩니다.
- `Bash`에는 세션 단위 “항상 허용” 버튼을 제공하지 않습니다.
- SDK가 경로나 명령 범위를 제안할 때만 그 범위의 세션 허용을 적용합니다.
- `bypassPermissions`는 지원하지 않습니다.

## 문제 해결

### 봇이 아무 응답도 하지 않습니다

1. Telegram에서 `/status`를 입력합니다.
2. 응답이 없으면 Mac에서 프로그램이 실행 중인지 확인합니다.
3. `.env`의 `TELEGRAM_ALLOWED_USER_ID`와 `TELEGRAM_CHAT_ID`가 맞는지 확인합니다.
4. 봇이 해당 그룹의 관리자인지 확인합니다.
5. `data/stderr.log`를 확인합니다.
6. `/doctor`가 가능하다면 실행해 전체 상태를 봅니다.

### 새 토픽을 만들지 못합니다

Telegram 그룹에서 봇 권한을 확인합니다.

- `Manage Topics`: 새 작업 토픽 생성에 필요
- `Delete Messages`: `/delete` 처리에 필요

### `.env permissions must be 0600` 오류가 납니다

`.env` 파일 권한이 너무 열려 있다는 뜻입니다.

```bash
chmod 600 .env
```

다시 실행하세요.

### Claude 인증 오류가 납니다

토큰이 만료됐거나 잘못 입력됐을 수 있습니다.

```bash
npm run auth:setup
npm run build
```

그 뒤 봇을 재시작합니다.

### Codex 인증 오류가 납니다

터미널에서 다음을 실행합니다.

```bash
codex
```

`Sign in with ChatGPT` 로그인이 유지되는지 확인합니다. API 키 인증이면 `/plan` 실행이 거부됩니다.

### 프로젝트를 찾을 수 없다고 나옵니다

```text
/projects
```

등록된 이름과 별칭을 확인합니다. `projects.json`의 `cwd`는 실제 존재하는 절대경로여야 합니다.

### 작업이 계속 대기 중입니다

같은 프로젝트에서는 한 번에 하나의 작업만 실행합니다. 파일 충돌을 막기 위한 정책입니다.

```text
/status
```

먼저 실행 중인 작업을 확인하고, 필요하면 해당 토픽에서 `/stop`을 사용합니다.

### 파일 전송이 실패합니다

Telegram Bot API에는 파일 크기 제한이 있습니다. 큰 파일은 나누거나 다른 전달 방식을 사용하세요. 사진은 Telegram이 압축할 수 있으므로 원본이 필요하면 “파일”로 보내는 것이 좋습니다.

### 재시작 후 작업이 중단 상태입니다

프로세스가 종료될 때 실행 중이던 SDK 호출은 자동 복원하지 않습니다. 세션을 `interrupted`로 표시합니다. 기존 토픽에 후속 메시지를 보내 이전 문맥을 바탕으로 다시 시작할 수 있습니다.

## 개발자용 정보

자주 쓰는 명령:

```bash
npm test
npm run typecheck
npm run build
```

주요 파일:

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 프로그램 시작점입니다. 설정을 읽고 봇과 세션 매니저를 연결합니다. |
| `src/bot.ts` | Telegram 명령, 버튼, 파일 수신, 사용자 입력 흐름을 처리합니다. |
| `src/session-manager.ts` | Claude/Codex 실행, 큐, 중단, 진행 상태, `/plan` 흐름을 관리합니다. |
| `src/model-catalog.ts` | Claude/Codex 모델 카탈로그를 동적으로 읽고 fallback 목록을 제공합니다. |
| `src/config.ts` | `.env`와 `projects.json`을 읽고 검증합니다. |
| `src/store.ts` | SQLite에 세션, 승인, 프로젝트, `/plan` 증거를 저장합니다. |
| `src/usage.ts` | Claude 사용량 스냅샷을 읽기 쉬운 문구로 바꿉니다. |
| `src/token-pool.ts` | 여러 Claude OAuth 토큰 중 사용 가능한 토큰을 선택합니다. |
| `src/doctor.ts` | 실행 환경 진단 리포트를 만듭니다. |
| `scripts/setup-oauth-token.sh` | Claude OAuth 토큰을 `.env`에 안전하게 저장합니다. |
| `scripts/install-launch-agent.mjs` | macOS LaunchAgent를 설치합니다. |
| `scripts/restart-launch-agent.mjs` | LaunchAgent 등록을 유지한 채 프로세스를 재시작합니다. |

테스트는 `tests/` 아래에 있습니다. 기능을 바꿀 때는 관련 테스트를 함께 갱신하고, 최소한 `npm test`, `npm run typecheck`, `npm run build`를 통과시켜야 합니다.

## 현재 제한

- macOS 자동 실행 방식만 제공합니다.
- 단일 Telegram 슈퍼그룹과 단일 허용 사용자만 지원합니다.
- Telegram 앱에서 사용자가 직접 삭제한 토픽은 Bot API 삭제 이벤트를 주지 않습니다. 로컬 세션까지 지우려면 토픽 안에서 `/delete`를 사용하세요.
- 승인 대기 중 프로세스가 재시작되면 해당 SDK 호출은 복원하지 않습니다.
- 같은 프로젝트의 작업은 읽기 전용 작업도 포함해 한 번에 하나씩 실행합니다.
- 실제 Telegram 연결 검증에는 유효한 봇 토큰, user ID, forum supergroup ID가 필요합니다.
- `setup-token` OAuth는 Agent SDK 추론용입니다. Claude Remote Control 세션 용도가 아닙니다.
- Claude와 Codex 사용 가능 범위, 모델 이름, 구독 한도 정책은 각 제공사의 정책 변경에 따라 달라질 수 있습니다.

## 라이선스

[MIT License](LICENSE)
