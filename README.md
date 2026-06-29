# ChatKJB

ChatKJB는 Telegram에서 내 Mac의 AI 작업자를 부르는 개인용 작업 오케스트레이터입니다.

Telegram 그룹에 평소 말하듯 요청하면 ChatKJB가 등록된 프로젝트 폴더에서 Claude, Codex, agy 중 알맞은 실행기를 열고 작업을 진행합니다. 파일을 읽고 수정하며, 테스트를 돌리고, 긴 작업의 진행 상황과 승인 요청을 Telegram topic으로 돌려줍니다.

이 README는 처음 보는 사람도 따라 할 수 있도록 네 부분으로 나뉩니다.

| 구분 | 대상 | 내용 |
| --- | --- | --- |
| 1부 | 사용자 | Telegram에서 실제로 어떻게 쓰는지 |
| 2부 | 운영자 | Mac에 설치하고 자동 실행하는 법 |
| 3부 | 개발자 | 구조, 테스트, 기능 추가 위치 |
| 4부 | 문제 해결 | 자주 막히는 지점과 확인 명령 |

비개발자는 보통 1부만 읽으면 됩니다. 직접 설치하는 분은 2부까지 읽으십시오.

---

# 1부. Telegram에서 사용하기

## ChatKJB가 하는 일

ChatKJB는 다음 흐름으로 동작합니다.

1. 사용자가 Telegram supergroup에서 `/new`를 보냅니다.
2. ChatKJB가 작업할 프로젝트를 고르게 합니다.
3. 선택한 프로젝트마다 새 Telegram topic을 만들고 세션을 시작합니다.
4. Claude, Codex, agy 중 현재 설정된 제공자가 실제 작업을 수행합니다.
5. 진행 상황, 질문, 승인 버튼, 완료 결과가 같은 topic에 올라옵니다.
6. 같은 topic에 다시 메시지를 보내면 이전 맥락을 이어서 작업합니다.

즉, Telegram이 “내 Mac 안의 AI 작업실 리모컨”이 됩니다.

## 맡길 수 있는 일

| 하고 싶은 일 | 예시 요청 |
| --- | --- |
| 코드 수정 | `로그인이 실패하는 원인을 찾아 고치고 테스트까지 돌려줘` |
| 문서 작성 | `README를 초보자용으로 다시 써줘` |
| 테스트와 빌드 | `수정 후 npm run typecheck, npm test, npm run build 확인해줘` |
| 파일 분석 | `방금 올린 PDF를 읽고 핵심 주장과 근거를 표로 정리해줘` |
| 긴 작업 자동 진행 | `/goal 모든 테스트가 통과하고 README가 최신 기능을 반영한다` |
| 제공자 추천 | `/route 이 작업은 Claude, Codex, agy 중 누가 좋을까?` |
| 여러 AI 검토 | `/synth 이 설계의 위험 요소를 비교 검토해줘` |
| 과거 기록 검색 | `/query 이전에 정한 메모리 정책이 뭐였지?` |

AI는 등록된 프로젝트 폴더를 기준으로 파일 읽기, 파일 수정, 셸 명령 실행, 테스트 실행, 문서 요약, 코드 리뷰를 수행할 수 있습니다.

## 기본 용어

| 용어 | 뜻 |
| --- | --- |
| 프로젝트 | AI가 작업할 로컬 폴더입니다. 예: 이 저장소, 논문 폴더, 업무 폴더 |
| topic | Telegram forum supergroup 안의 주제 탭입니다. 작업 하나가 보통 topic 하나입니다. |
| 세션 | 한 topic 안에서 이어지는 작업 대화입니다. 이전 지시와 결과를 기억합니다. |
| 제공자 | 실제 일을 수행하는 AI 실행기입니다. 현재 Claude, Codex, agy를 지원합니다. |
| 모델 | 제공자 안에서 고르는 모델입니다. `/model`, `/thinking`, `/power`로 조정합니다. |
| 권한 모드 | 파일 수정과 명령 실행을 얼마나 자동으로 허용할지 정하는 설정입니다. |
| 목표 | `/goal`로 설정하는 자동 진행 조건입니다. 조건이 충족될 때까지 후속 턴을 예약합니다. |

## 첫 작업 시작

Telegram에서 다음 순서로 진행합니다.

1. ChatKJB가 들어 있는 Telegram supergroup을 엽니다.
2. `/new`를 보냅니다.
3. 버튼으로 프로젝트를 고릅니다.
4. 기본 제공자와 모델을 확인합니다. 잘 모르겠으면 그대로 둡니다.
5. 하고 싶은 일을 한 문장 이상으로 적습니다.
6. 새 topic이 만들어지면 그 topic 안에서 진행 상황을 봅니다.
7. 승인 버튼이 뜨면 내용을 확인하고 허용 또는 거부합니다.
8. 완료 후 같은 topic에 추가 요청을 보내면 이어서 작업합니다.

예시:

```text
/new
```

프로젝트 선택 후:

```text
이 저장소 README를 처음 보는 사람도 설치와 사용을 따라 할 수 있게 고쳐줘.
현재 구현된 명령과 스크립트를 모두 반영하고, 끝나면 타입체크와 테스트를 확인해줘.
```

## 자주 쓰는 명령어

Telegram 명령어는 `/`로 시작합니다.

| 명령 | 용도 |
| --- | --- |
| `/new` | 새 작업과 새 topic을 시작합니다. |
| `/reserve <프로젝트> <시간> <작업>` | 지정 시각에 새 작업과 새 topic을 시작합니다. |
| `/cancel` | 대기 중인 예약 작업을 목록에서 선택해 취소합니다. |
| `/projects` | 등록된 프로젝트 목록을 봅니다. |
| `/sessions` | 최근 세션 목록을 봅니다. |
| `/status` | 봇과 현재 작업 상태를 확인합니다. |
| `/usage` | Claude/Codex 사용량과 한도 상태를 봅니다. |
| `/doctor` | 실행 환경을 진단합니다. |
| `/stop` | 현재 topic의 실행 중 작업을 중단합니다. |
| `/reset` | 세션의 대화 맥락만 초기화합니다. |
| `/delete` | Telegram topic과 로컬 세션을 삭제합니다. |

## 작업을 조종하는 명령어

| 명령 | 용도 |
| --- | --- |
| `/steer <지시>` | 실행 중인 작업에 즉시 방향 수정을 보냅니다. |
| `/next <지시>` | 현재 작업이 끝난 뒤 실행할 후속 작업을 예약합니다. |
| `/goal <조건>` | 조건이 충족될 때까지 자동으로 후속 턴을 진행합니다. |
| `/goal clear` | 자동 목표를 해제합니다. |
| `/fork` | 현재 세션을 복제해 다른 방향으로 이어 갑니다. |
| `/compact` | 긴 세션 맥락을 압축합니다. |
| `/memory <내용>` | 오래 기억할 사실을 전역 메모리에 기록하도록 요청합니다. |
| `/diff` | 현재 프로젝트의 git diff 요약을 봅니다. |
| `/upload <경로>` | 프로젝트 안의 결과 파일을 Telegram으로 받습니다. |

`/goal`은 `check:` 줄을 함께 쓸 수 있습니다. `check:` 명령이 실패하면 목표가 아직 미달성인 것으로 판단합니다.

```text
/goal README가 최신 기능을 모두 설명하고 검증 명령이 통과한다
check: npm run typecheck
check: npm test
```

## 제공자와 모델을 바꾸는 명령어

| 명령 | 용도 |
| --- | --- |
| `/model` | 제공자와 모델을 확인하거나 변경합니다. |
| `/thinking` | Claude의 extended thinking 설정을 확인하거나 변경합니다. |
| `/power` | 현재 AI 작업량 또는 추론 강도를 확인하거나 변경합니다. |
| `/effort` | `/power`와 같은 계열의 추론 강도 조정 명령입니다. |
| `/mode` | 권한 모드를 확인하거나 변경합니다. |
| `/lean on` | 최소 구현 원칙을 켭니다. |
| `/lean off` | 최소 구현 원칙을 끕니다. |
| `/tokenid <번호>` | 새 Codex 세션에 사용할 Codex 계정 번호를 지정합니다. |

권한 모드는 다음 값을 사용합니다.

| 모드 | 의미 |
| --- | --- |
| `auto` | 기본값입니다. 일반 작업은 진행하고 위험 작업은 확인합니다. |
| `default` | 더 보수적으로 승인 요청을 합니다. |
| `acceptEdits` | 파일 편집은 비교적 쉽게 허용합니다. |
| `plan` | 읽기와 계획 중심으로 제한합니다. |
| `dontAsk` | 가장 자동화된 모드입니다. 신뢰하는 작업에만 쓰십시오. |

## 추천, 종합, 검색 명령어

| 명령 | 용도 | 주의 |
| --- | --- | --- |
| `/route <작업>` | Claude, Codex, agy 중 적합한 제공자를 추천합니다. | 추천만 하며 자동 실행하지 않습니다. |
| `/synth <작업>` | 여러 제공자에게 읽기 전용 답변을 받아 비교하고 통합합니다. | 시간과 토큰을 많이 씁니다. |
| `/query <질문>` | LLM-Wiki에 쌓인 과거 기록을 검색해 답합니다. | 현재 세션이 유휴 상태일 때 쓰는 것이 좋습니다. |

예시:

```text
/route 이 PDF에서 CRISPR screen 후보 유전자를 정리해줘
```

```text
/synth 현재 아키텍처에서 실패 가능성이 큰 지점을 찾아줘
```

```text
/query ChatKJB에서 Codex 계정 전환은 어떻게 동작해?
```

## 프로젝트 추가와 삭제

운영자가 미리 `projects.json`에 등록하지 않았더라도 Telegram에서 프로젝트를 추가할 수 있습니다.

```text
/addp /Users/me/work/my-project
```

삭제:

```text
/deltp my-project
```

`/deltp`는 ChatKJB 프로젝트 목록에서만 제거합니다. 실제 폴더를 지우지 않습니다. 마지막 남은 프로젝트는 삭제할 수 없습니다.

## 파일 보내고 받기

작업 topic에 파일을 올리면 ChatKJB가 파일을 Mac의 인박스 폴더에 저장하고 해당 경로를 AI에게 알려 줍니다.

지원 입력:

- 문서
- 사진
- 오디오와 음성
- 동영상
- GIF
- 스티커

PDF는 별도 PDF 도구를 통해 텍스트 추출과 그림 추출에 사용할 수 있습니다.

결과 파일 받기:

```text
/upload output/report.pdf
```

상대 경로는 현재 프로젝트 폴더 기준입니다. 절대 경로도 사용할 수 있습니다.

## 안전장치

ChatKJB는 개인 작업 자동화를 위한 도구이므로 다음 안전장치를 둡니다.

- `.env`에 등록된 Telegram 사용자와 그룹의 메시지만 처리합니다.
- 프로젝트 목록에 등록된 폴더를 중심으로 작업합니다.
- 위험하거나 불확실한 작업은 Telegram 버튼으로 승인을 받습니다.
- 토큰, API 키, 비밀번호처럼 보이는 값은 로그와 메시지에서 마스킹합니다.
- `.env`, `projects.json`, `data/` 같은 민감한 런타임 파일은 Git에 올리지 않습니다.
- 한 작업 topic 안에서 실행 상태를 추적하고 `/stop`, `/delete`, `/reset`으로 제어할 수 있습니다.

---

# 2부. 설치와 운영

여기부터는 ChatKJB를 직접 Mac에서 실행하는 사람을 위한 내용입니다.

## 필요한 것

- macOS
- Node.js 22 이상
- Telegram 봇 토큰
- Topics 기능이 켜진 Telegram forum supergroup
- Claude OAuth 토큰
- Codex ChatGPT 로그인
- Gemini API 키
- AI가 작업할 프로젝트 폴더

이 저장소의 `package.json` 이름은 내부 호환성 때문에 아직 `telegram-claude-orchestrator`입니다. GitHub 저장소명 `ChatKJB`, npm 패키지명 `telegram-claude-orchestrator`, launchd 라벨 `com.neam.telegram-claude-orchestrator`는 같은 시스템을 가리킵니다.

## 1단계. 저장소 받기

```bash
git clone https://github.com/neam-kim/ChatKJB
cd ChatKJB
npm install
```

Node 버전 확인:

```bash
node -v
```

`v22` 이상이어야 합니다. Node 버전이 낮으면 `better-sqlite3` 같은 네이티브 모듈에서 문제가 날 수 있습니다.

## 2단계. Telegram 준비

1. Telegram에서 `@BotFather`를 엽니다.
2. `/newbot`으로 봇을 만들고 토큰을 받습니다.
3. 개인용 Telegram supergroup을 만듭니다.
4. 그룹 설정에서 Topics 기능을 켭니다.
5. 봇을 그룹에 추가하고 관리자로 지정합니다.
6. 봇에 `Manage Topics`, `Delete Messages` 권한을 줍니다.
7. 본인의 Telegram user ID와 그룹 chat ID를 확인합니다.

ChatKJB는 허용된 사용자 ID와 허용된 chat ID가 모두 맞는 메시지만 처리합니다.

## 3단계. `.env` 만들기

예제 파일을 복사합니다.

```bash
cp .env.example .env
chmod 600 .env
```

권한 `0600`은 필수입니다. 권한이 다르면 실행 시 설정 로딩이 실패합니다.

필수 값:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_CHAT_ID=-1001234567890
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-replace-me
GEMINI_API_KEY=replace-with-google-ai-studio-key
```

여러 Telegram 사용자를 허용하려면 쉼표로 등록합니다.

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

`TELEGRAM_ALLOWED_USER_ID` 하나만 써도 되고, `TELEGRAM_ALLOWED_USER_IDS`만 써도 됩니다. 둘 다 쓰면 합쳐서 중복 제거합니다.

## 4단계. AI 제공자 인증

### Claude

Claude OAuth 토큰은 다음 스크립트로 설정할 수 있습니다.

```bash
npm run auth:setup
```

추가 Claude 계정 토큰은 `.env`에 넣을 수 있습니다.

```dotenv
CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-replace-me
CLAUDE_CODE_OAUTH_TOKEN_3=sk-ant-oat01-replace-me
```

기본 토큰이 한도에 도달하거나 rate limit이 발생하면 다음 세션부터 다른 토큰으로 전환할 수 있습니다.

### Codex

Codex는 ChatGPT 로그인 기반 `CODEX_HOME`을 사용합니다.

단일 계정:

```bash
codex login
```

여러 계정:

```bash
CODEX_HOME=/Users/me/.codex codex login
CODEX_HOME=/Users/me/.codex-acct-b codex login
```

`.env`에 계정 홈을 쉼표로 등록합니다.

```dotenv
CODEX_ACCOUNT_HOMES=/Users/me/.codex,/Users/me/.codex-acct-b
```

각 홈에는 `auth.json`이 있어야 하며, `auth_mode`가 `chatgpt`인 로그인만 허용됩니다.

### agy

agy는 Gemini API 키와 Antigravity SDK 브리지를 사용합니다.

```dotenv
GEMINI_API_KEY=replace-with-google-ai-studio-key
```

agy 실행 파일이나 Python 환경을 직접 지정해야 하면 다음 값을 사용합니다.

```dotenv
AGY_EXECUTABLE=/Users/me/.local/bin/agy
AGY_SDK_PYTHON=/Users/me/.local/share/telegram-claude-orchestrator/agy-sdk/bin/python
```

## 5단계. 프로젝트 등록

`projects.json`은 AI가 작업할 폴더 목록입니다. 실제 경로가 들어가므로 Git에 올리지 않습니다.

```bash
cp projects.example.json projects.json
```

예시:

```json
[
  {
    "name": "ChatKJB",
    "cwd": "/Users/me/work/ChatKJB",
    "defaultMode": "auto"
  }
]
```

지원 필드:

| 필드 | 설명 |
| --- | --- |
| `name` | Telegram에서 보이는 프로젝트 이름입니다. |
| `aliases` | 선택 항목입니다. 같은 프로젝트를 다른 이름으로 찾을 수 있게 합니다. |
| `cwd` | 실제 작업 폴더입니다. 절대 경로를 권장합니다. SMB URL은 런타임에서 파일 경로로 해석됩니다. |
| `defaultMode` | 새 세션 기본 권한 모드입니다. `auto`, `default`, `acceptEdits`, `plan`, `dontAsk` 중 하나입니다. |

ChatKJB는 시작 시 접근할 수 없는 프로젝트를 건너뜁니다. NAS나 외장 디스크가 다시 연결된 뒤 재시작하면 다시 사용할 수 있습니다.

## 6단계. 실행

개발 모드:

```bash
npm run dev
```

빌드 후 실행:

```bash
npm run build
npm start
```

정상 실행되면 Telegram에서 `/start`, `/doctor`, `/new`를 보내 확인합니다.

## 7단계. Mac 자동 시작

LaunchAgent 설치:

```bash
npm run launchd:install
```

재시작:

```bash
npm run launchd:restart
```

상태 확인:

```bash
launchctl print gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

로그:

```text
data/stdout.log
data/stderr.log
```

단순 재시작은 `npm run launchd:restart`를 쓰십시오. `launchctl bootout`은 등록 해제까지 함께 수행합니다.

## 주요 환경 변수

| 변수 | 필수 | 기본값 | 설명 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 예 | 없음 | BotFather에서 받은 봇 토큰입니다. |
| `TELEGRAM_ALLOWED_USER_ID` | 조건부 | 없음 | 허용할 단일 Telegram 사용자 ID입니다. |
| `TELEGRAM_ALLOWED_USER_IDS` | 조건부 | 없음 | 허용할 여러 사용자 ID CSV입니다. |
| `TELEGRAM_CHAT_ID` | 예 | 없음 | ChatKJB가 동작할 Telegram group chat ID입니다. |
| `CLAUDE_CODE_OAUTH_TOKEN` | 예 | 없음 | Claude Code OAuth 토큰입니다. |
| `CLAUDE_CODE_OAUTH_TOKEN_2`, `_3` | 아니오 | 없음 | Claude 추가 계정 토큰입니다. |
| `GEMINI_API_KEY` | 예 | 없음 | agy/Gemini용 API 키입니다. |
| `CODEX_ACCOUNT_HOMES` | 아니오 | `CODEX_HOME` 또는 `~/.codex` | Codex 계정 홈 CSV입니다. |
| `DATABASE_PATH` | 아니오 | `./data/state.sqlite` | SQLite 상태 DB 위치입니다. |
| `PROJECTS_PATH` | 아니오 | `./projects.json` | 프로젝트 목록 파일입니다. |
| `FILE_INBOX_DIR` | 아니오 | `~/.claude/channels/telegram/inbox` | Telegram 첨부 파일 저장 위치입니다. |
| `CLAUDE_MEMORY_DIR` | 아니오 | `~/.claude/memory` | Claude 장기 메모리 위치입니다. |
| `APPROVAL_TIMEOUT_MINUTES` | 아니오 | `30` | 승인 버튼 대기 시간입니다. |
| `STATUS_DEBOUNCE_MS` | 아니오 | `2500` | 진행 상태 메시지 debounce 시간입니다. |
| `MCP_TOOL_TIMEOUT_SECONDS` | 아니오 | `60` | 일반 MCP 도구 타임아웃입니다. |
| `MCP_MAX_ATTEMPTS` | 아니오 | `3` | MCP 도구 재시도 횟수입니다. |
| `CODEX_MCP_TIMEOUT_MINUTES` | 아니오 | `30` | Codex 장기 MCP 타임아웃입니다. |
| `CODEX_MCP_HEARTBEAT_SECONDS` | 아니오 | `60` | Codex MCP heartbeat 알림 주기입니다. |
| `LONG_RUNNING_MCP_SERVERS` | 아니오 | `codex,obsidian` | 장기 실행으로 취급할 MCP 서버 이름입니다. |
| `TURN_IDLE_TIMEOUT_MINUTES` | 아니오 | `35` | 스트림이 완전히 멈춘 턴을 중단하는 워치독입니다. |
| `CLAUDE_CODE_EXECUTABLE` | 아니오 | PATH의 `claude` | Claude 실행 파일 경로입니다. |
| `AGY_EXECUTABLE` | 아니오 | `~/.local/bin/agy` 또는 PATH | agy 실행 파일 경로입니다. |
| `AGY_SDK_PYTHON` | 아니오 | 사용자 전용 agy SDK Python | agy SDK 브리지 Python입니다. |

## Transcript와 결과 로그 수집

완료된 세션 transcript와 `.result.md` 결과 로그를 LLM-Wiki inbox로 모을 수 있습니다.

수동 실행:

```bash
npm run transcripts:dump
```

LaunchAgent 설치:

```bash
npm run transcripts:install-agent
```

특징:

- 완료, 오류, 중단, 검증 실패 상태의 세션을 수집합니다.
- 같은 세션을 반복 덤프해도 새로 늘어난 대화 묶음만 기록합니다.
- Unicode와 공백을 정규화한 지문으로 중복을 줄입니다.
- 사용자 홈과 SynologyDrive 아래의 `.result.md`를 찾아 결과 로그로 병합할 수 있습니다.

## PDF 도구

`scripts/pdf-tools-mcp.py`는 PyMuPDF(`fitz`)를 사용해 PDF 작업을 돕는 MCP 도구입니다.

| 도구 | 역할 |
| --- | --- |
| `pdftotext` | PDF 텍스트를 `.txt` 파일로 저장하고 경로를 반환합니다. |
| `pdf_extract_figures` | PDF 이미지 또는 페이지 렌더링 결과를 PNG로 저장하고 경로를 반환합니다. |

대용량 PDF 본문을 Telegram 메시지로 길게 보내지 않고 파일 경로로 넘기기 위한 도구입니다.

## price-feed MCP

`price-feed-mcp/`는 별도 하위 패키지입니다. 미국 주식 근실시간 시세를 반환하는 독립 MCP 서버이며, 코드상 Toss Securities, Yahoo, Google 순서의 provider 흐름을 갖습니다.

```bash
cd price-feed-mcp
npm install
npm run build
npm test
```

실행:

```bash
npm start
```

## 공통 자원 계층

ChatKJB는 Claude, Codex, agy가 같은 지침과 리소스를 볼 수 있도록 공통 자원 계층을 동기화합니다.

주요 파일:

```text
~/.claude/shared-resources/RESOURCE.md
~/.claude/shared-resources/SKILLS.md
~/.claude/shared-resources/MEMORY-BRIDGE.md
~/.claude/shared-resources/connectors.json
```

역할:

- 전역 지침을 세 제공자에 공통 주입합니다.
- Claude 메모리, Claude 자동 메모리, Codex 자동 메모리를 함께 찾을 수 있게 연결합니다.
- 설치된 스킬과 플러그인 스킬을 하나의 카탈로그로 합칩니다.
- Claude와 Codex의 MCP 커넥터 설정을 병합해 agy에도 전달합니다.

---

# 3부. 개발자 안내

## 기술 스택

- TypeScript ESM
- Node.js 22 이상
- grammY
- Claude Agent SDK
- OpenAI Codex SDK
- Python `google-antigravity` SDK 브리지
- better-sqlite3
- zod
- vitest

## 주요 디렉터리와 파일

| 경로 | 역할 |
| --- | --- |
| `src/` | 봇 본체와 세션 실행 로직입니다. |
| `scripts/` | 인증, launchd, transcript dump, PDF MCP, agy 브리지 스크립트입니다. |
| `tests/` | vitest 테스트입니다. |
| `price-feed-mcp/` | 독립 시세 MCP 서버 하위 패키지입니다. |
| `data/` | SQLite DB와 로그가 저장되는 런타임 폴더입니다. Git 제외 대상입니다. |
| `dist/` | TypeScript 빌드 산출물입니다. |
| `.env.example` | 환경 변수 예제입니다. |
| `projects.example.json` | 프로젝트 목록 예제입니다. |

핵심 소스:

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 앱 진입점, 설정 로딩, 공통 자원 동기화, Telegram 명령 메뉴 등록, 봇 시작 |
| `src/config.ts` | `.env`, `projects.json`, 경로, 계정 홈, 환경 검증 |
| `src/bot.ts` | Telegram 명령, 버튼, 파일 입력, topic 처리 |
| `src/session-manager.ts` | 세션 실행, 제공자 전환, 목표 자동 진행, 한도 전환 |
| `src/store.ts` | SQLite 스키마와 CRUD |
| `src/model-catalog.ts` | 제공자별 모델 목록과 fallback |
| `src/permission-broker.ts` | Claude 도구 승인 브로커 |
| `src/token-pool.ts` | Claude OAuth 토큰 회전과 한도 상태 |
| `src/codex-account-pool.ts` | Codex 계정 홈 회전 |
| `src/connectors.ts` | MCP 커넥터 병합과 동기화 |
| `src/resource-sync.ts` | 공통 지침, 메모리, 스킬, 커넥터 자원 생성 |
| `src/router.ts` | `/route` 제공자 추천 |
| `src/judge.ts` | `/synth` 판정과 통합 보조 |
| `src/goal-checks.ts` | `/goal`의 `check:` 파싱과 위험도 추정 |
| `src/orchestration/local-tiers.ts` | 로컬 Ollama tier 호출과 timeout |
| `src/orchestration/frontier-review.ts` | frontier review 오케스트레이션 |
| `src/stream-renderer.ts` | 세션 스트림을 Telegram 메시지로 렌더링 |
| `src/redaction.ts` | 비밀정보 마스킹 |
| `src/filesystem-path.ts` | 로컬 경로와 SMB URL 해석 |

## 요청 처리 흐름

1. `src/index.ts`가 설정, 저장소, 모델 카탈로그, 공통 자원을 초기화합니다.
2. `src/bot.ts`가 Telegram 업데이트를 받고 허용된 사용자와 그룹인지 확인합니다.
3. `/new`가 프로젝트 선택 UI를 띄우고 새 topic과 세션을 만듭니다.
4. 일반 메시지는 해당 topic의 세션으로 전달됩니다.
5. `src/session-manager.ts`가 provider 설정에 따라 Claude, Codex, agy를 실행합니다.
6. 스트리밍 출력, 승인 요청, 오류, 완료 결과가 Telegram topic에 전송됩니다.
7. 세션 상태와 사용량, 요약이 SQLite DB에 저장됩니다.
8. 필요하면 transcript dump가 완료 세션을 LLM-Wiki inbox로 보냅니다.

## npm 스크립트

| 명령 | 역할 |
| --- | --- |
| `npm run auth:setup` | Claude OAuth 토큰 설정 스크립트를 실행합니다. |
| `npm run dev` | `tsx watch src/index.ts`로 개발 실행합니다. |
| `npm run build` | `dist/`를 지우고 TypeScript 빌드를 수행합니다. |
| `npm start` | `node dist/index.js`로 빌드 산출물을 실행합니다. |
| `npm run launchd:install` | LaunchAgent를 설치합니다. |
| `npm run launchd:restart` | LaunchAgent를 재시작합니다. |
| `npm run transcripts:dump` | transcript와 결과 로그를 수동 수집합니다. |
| `npm run transcripts:install-agent` | transcript dump LaunchAgent를 설치합니다. |
| `npm run typecheck` | TypeScript 타입체크를 실행합니다. |
| `npm test` | 전체 vitest 테스트를 실행합니다. |
| `npm run test:agy-live` | 실제 agy 네트워크 live 테스트를 실행합니다. |

`prism`, `prism:status`, `prism:block-status` 스크립트는 `scripts/prismctl`이 있는 환경에서만 동작합니다. 일반 설치와 검증에는 필요하지 않습니다.

## 새 Telegram 명령 추가

1. `src/bot.ts`에 `bot.command("name", ...)` 핸들러를 추가합니다.
2. 공개 메뉴에 보여야 하면 `src/index.ts`의 `setMyCommands`에도 추가합니다.
3. 세션 상태 저장이 필요하면 `src/types.ts`와 `src/store.ts` 마이그레이션을 수정합니다.
4. 제공자 실행 옵션에 영향을 주면 `src/session-manager.ts`의 Claude/Codex/agy 경로를 확인합니다.
5. 사용자에게 보이는 명령이면 README 명령표와 테스트를 갱신합니다.

## 검증

기본 검증:

```bash
npm run typecheck
npm test
npm run build
```

특정 테스트:

```bash
npm test -- tests/orchestration-local-tiers.test.ts
```

agy live 테스트:

```bash
npm run test:agy-live
```

agy live 테스트는 실제 인증과 네트워크가 필요합니다. `.env.example`의 `AGY_LIVE_TEST=1` 안내를 확인한 뒤 실행하십시오.

## 커밋 전 확인

- `.env`, `projects.json`, `data/`, 로그 파일이 Git에 들어가지 않았는지 확인합니다.
- README, 테스트 fixture, 로그에 토큰이나 API 키가 들어가지 않았는지 확인합니다.
- Telegram 공개 명령을 바꿨다면 `src/index.ts`의 `setMyCommands`, `src/bot.ts`, README를 함께 갱신합니다.
- 설정 키를 바꿨다면 `.env.example`, `src/config.ts`, README를 함께 갱신합니다.
- launchd 라벨 `com.neam.telegram-claude-orchestrator`를 바꾸는 작업은 기존 DB, 로그, LaunchAgent, 문서까지 함께 점검합니다.

---

# 4부. 문제 해결

## 빠른 상태 확인

```bash
npm run typecheck
npm test
npm run build
npm run launchd:restart
launchctl print gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

Telegram에서는 다음을 보냅니다.

```text
/doctor
/status
/usage
```

## `.env` 권한 오류

증상:

- 시작 직후 설정 로딩 실패
- `.env permissions must be 0600` 오류

해결:

```bash
chmod 600 .env
```

## Node 버전 문제

증상:

- `better-sqlite3` ABI 오류
- 빌드 또는 실행 시 네이티브 모듈 오류

해결:

```bash
node -v
npm install
npm run build
```

Node 22 이상에서 다시 설치하십시오.

## Telegram 응답이 없을 때

확인 순서:

1. `.env`의 `TELEGRAM_BOT_TOKEN`이 맞는지 확인합니다.
2. `TELEGRAM_CHAT_ID`가 실제 supergroup ID인지 확인합니다.
3. `TELEGRAM_ALLOWED_USER_ID` 또는 `TELEGRAM_ALLOWED_USER_IDS`에 본인 ID가 있는지 확인합니다.
4. 봇이 그룹 관리자이고 topic 관리 권한이 있는지 확인합니다.
5. `data/stderr.log`와 `data/stdout.log`를 확인합니다.

## 프로젝트가 보이지 않을 때

확인 순서:

1. `projects.json` 경로가 `.env`의 `PROJECTS_PATH`와 맞는지 봅니다.
2. 각 `cwd`가 실제 존재하는 디렉터리인지 확인합니다.
3. ChatKJB 프로세스가 해당 폴더를 읽고 쓸 수 있는지 확인합니다.
4. NAS나 외장 디스크 경로라면 마운트 상태를 확인합니다.
5. Telegram에서 `/projects`를 보냅니다.

## Claude/Codex 한도 문제

확인:

```text
/usage
```

대응:

- Claude는 `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3`에 추가 토큰을 등록할 수 있습니다.
- Codex는 `CODEX_ACCOUNT_HOMES`에 여러 `CODEX_HOME`을 등록할 수 있습니다.
- 한도에 도달한 계정은 회복 시각까지 대기하거나 다음 계정으로 전환합니다.

## Codex 로그인 문제

각 계정 홈에서 로그인합니다.

```bash
CODEX_HOME=/Users/me/.codex codex login
```

`CODEX_ACCOUNT_HOMES`에 등록한 각 디렉터리에는 `auth.json`이 있어야 하고, ChatGPT 로그인(`auth_mode=chatgpt`)이어야 합니다.

## agy 문제

확인:

```bash
npm run test:agy-live
```

`GEMINI_API_KEY`, `AGY_EXECUTABLE`, `AGY_SDK_PYTHON` 값을 확인하십시오. live 테스트는 실제 네트워크와 인증을 사용합니다.

## 실행 중 작업이 멈춘 것 같을 때

- `/status`로 현재 세션 상태를 봅니다.
- `/stop`으로 실행을 중단할 수 있습니다.
- `TURN_IDLE_TIMEOUT_MINUTES`는 스트림이 완전히 멈춘 턴을 자동 중단하는 최후의 안전장치입니다.
- 장기 MCP 작업은 `LONG_RUNNING_MCP_SERVERS`, `CODEX_MCP_TIMEOUT_MINUTES`, `CODEX_MCP_HEARTBEAT_SECONDS` 설정을 확인합니다.

---

# 현재 제한

- 단일 Telegram supergroup을 기준으로 동작합니다.
- Telegram Bot API 제한 때문에 큰 파일 수신과 전송에는 제한이 있습니다.
- 사용자가 Telegram 앱에서 topic을 직접 삭제하면 Bot API가 삭제 이벤트를 주지 않으므로, 로컬 세션까지 지우려면 `/delete`를 사용해야 합니다.
- 프로젝트별 작업 큐는 충돌 방지를 위해 한 번에 하나씩 실행합니다.
- Codex는 계정 전환 시 기존 Codex thread를 그대로 이어받지 못할 수 있어 요약 기반으로 새 thread를 시작합니다.
- agy는 Gemini API 키와 SDK 상태에 의존합니다.

---

# 빠른 참조

처음 설치:

```bash
npm install
cp .env.example .env
chmod 600 .env
cp projects.example.json projects.json
npm run build
npm start
```

검증:

```bash
npm run typecheck
npm test
npm run build
```

자동 실행:

```bash
npm run launchd:install
npm run launchd:restart
```

Telegram:

```text
/new
/reserve ChatKJB 내일 오전 9시 README 점검해줘
/cancel
/projects
/status
/usage
/doctor
/goal clear
/stop
```
