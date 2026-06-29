# ChatKJB

ChatKJB는 텔레그램으로 내 Mac의 AI 작업자에게 일을 맡기고, 진행 상황과 결과를 휴대폰에서 확인하는 개인용 작업 오케스트레이터입니다.

코딩을 잘 모르는 사람도 텔레그램에 평소 말하듯 요청하면, ChatKJB가 미리 등록된 프로젝트 폴더 안에서 Claude, Codex, agy 중 알맞은 AI를 실행합니다. 필요하면 파일을 읽고 고치며, 위험한 작업은 텔레그램 버튼으로 먼저 허락을 받습니다.

이 문서는 세 부분으로 나뉩니다.

| 구분 | 읽는 사람 | 내용 |
| --- | --- | --- |
| 1부 | 봇을 사용하는 사람 | ChatKJB가 무엇인지, 텔레그램에서 어떻게 쓰는지 |
| 2부 | 직접 운영하는 사람 | Mac에 설치하고, 인증하고, 자동 실행하는 방법 |
| 3부 | 개발자 | 코드 구조, 테스트, 기능 추가 위치 |

비개발자는 보통 1부만 읽으면 됩니다.

---

# 1부. 사용 안내

## ChatKJB가 해 주는 일

ChatKJB는 텔레그램 그룹 안에서 다음 일을 대신 연결해 줍니다.

- 사용자가 텔레그램에 요청을 보냅니다.
- ChatKJB가 어떤 프로젝트 폴더에서 일할지 고릅니다.
- Claude, Codex, agy 중 선택한 AI가 그 폴더의 파일을 읽고 작업합니다.
- 진행 상황, 승인 요청, 완료 결과가 텔레그램 주제(topic)에 올라옵니다.
- 필요하면 다른 AI로 바꿔도 이전 맥락을 요약해 이어 갑니다.

즉, 텔레그램이 "내 Mac에서 돌아가는 AI 작업실 리모컨"이 됩니다.

## 무엇을 맡길 수 있나요?

대표적인 사용 예시는 다음과 같습니다.

| 하고 싶은 일 | 예시 요청 |
| --- | --- |
| 문서 정리 | `이 README를 처음 보는 사람도 이해하게 고쳐줘` |
| 코드 수정 | `로그인이 실패할 때 원인을 찾아 고쳐줘` |
| 테스트 실행 | `수정한 뒤 테스트와 타입체크까지 확인해줘` |
| 긴 대화 요약 | `이 세션에서 결정된 내용만 정리해줘` |
| 자료 검토 | `이 PDF를 읽고 핵심 주장과 근거를 표로 정리해줘` |
| 여러 AI 의견 비교 | `/synth 이 설계의 위험 요소를 분석해줘` |
| 과거 지식 검색 | `/query 예전에 정한 메모리 정책이 뭐였지?` |

AI가 하는 일은 프로젝트 폴더 안의 파일 작업, 셸 명령 실행, 문서 읽기, 요약, 검토, 테스트 실행 등입니다. 텔레그램에 파일을 보내면 그 파일도 작업에 포함할 수 있습니다.

## 기본 개념

| 용어 | 쉬운 뜻 |
| --- | --- |
| 프로젝트 | AI가 작업할 폴더입니다. 예: 이 저장소, 논문 폴더, 업무 문서 폴더 |
| 주제(topic) | 텔레그램 그룹 안의 대화방 탭입니다. ChatKJB는 보통 작업 하나를 주제 하나로 나눕니다. |
| 세션 | 한 주제 안에서 이어지는 작업 대화입니다. 앞에서 말한 내용을 기억합니다. |
| 제공자 | 실제 일을 하는 AI입니다. 현재 Claude, Codex, agy를 지원합니다. |
| 모델 | 제공자 안에서 고르는 두뇌 종류입니다. 예: Claude Opus, Codex GPT, Gemini |
| 권한 모드 | AI가 파일 수정이나 명령 실행을 얼마나 자유롭게 할 수 있는지 정하는 설정입니다. |
| 한도 | 구독 계정의 사용량 제한입니다. ChatKJB는 사용량과 회복 시각을 보여 주고, 가능한 경우 다른 계정으로 자동 전환합니다. |

## 처음 쓰는 방법

봇이 이미 설치되어 있다고 가정하면, 텔레그램에서는 다음 순서로 쓰면 됩니다.

1. 텔레그램 그룹에서 `/new`를 보냅니다.
2. 버튼으로 작업할 프로젝트를 고릅니다.
3. 아래쪽 기본값 패널에서 제공자와 모델을 확인합니다. 잘 모르겠으면 그대로 둡니다.
4. 하고 싶은 일을 한 문장으로 보냅니다.
5. ChatKJB가 새 주제를 만들고 작업을 시작합니다.
6. AI가 중간 진행 상황을 올립니다.
7. 승인 버튼이 나오면 내용을 보고 허용하거나 거부합니다.
8. 완료 메시지를 받은 뒤 같은 주제에 다시 메시지를 보내면 이어서 작업합니다.

예시는 다음과 같습니다.

```text
/new
```

프로젝트 선택 뒤:

```text
이 프로젝트 README를 비개발자도 이해할 수 있게 다시 써줘.
수정 후 타입체크와 테스트까지 확인해줘.
```

## 자주 쓰는 명령어

명령어는 텔레그램에서 `/`로 시작하는 한 줄입니다. 텔레그램 입력창에 `/`만 쳐도 메뉴가 뜹니다.

| 상황 | 명령 |
| --- | --- |
| 새 작업 시작 | `/new` |
| 등록된 프로젝트 보기 | `/projects` |
| 현재 상태 보기 | `/status` |
| 사용량과 한도 보기 | `/usage` |
| 작업 중단 | `/stop` |
| 현재 대화 맥락 초기화 | `/reset` |
| 실행 중 방향 수정 | `/steer 표로 정리해줘` |
| 현재 작업이 끝난 뒤 할 일 예약 | `/next 끝나면 테스트도 돌려줘` |
| 목표를 만족할 때까지 자동 진행 | `/goal 모든 테스트가 통과할 때까지` |
| 목표 해제 | `/goal clear` |
| 제공자 또는 모델 변경 | `/model` |
| 권한 모드 변경 | `/mode` |
| 최소 구현 원칙 켜기/끄기 | `/lean on`, `/lean off` |
| 현재 작업 복제 | `/fork` |
| 긴 대화 압축 | `/compact` |
| 오래 기억할 사실 저장 | `/memory` |
| 변경 diff 확인 | `/diff` |
| 파일 받기 | `/upload output/report.pdf` |
| 세션과 텔레그램 주제 삭제 | `/delete` |
| 환경 진단 | `/doctor` |

## 조금 더 강한 명령어

| 명령 | 언제 쓰나요? | 주의 |
| --- | --- | --- |
| `/route 작업 설명` | Claude, Codex, agy 중 어느 AI가 알맞은지 추천받고 싶을 때 | 추천만 합니다. 자동 배정은 하지 않습니다. |
| `/synth 작업 설명` | 세 AI에게 동시에 읽기 전용 검토를 시키고, 가장 좋은 답을 골라 통합하고 싶을 때 | 토큰과 시간이 많이 듭니다. 파일 수정용이 아닙니다. |
| `/query 질문` | LLM-Wiki에 쌓인 과거 대화와 결정 사항을 검색하고 싶을 때 | 현재 세션이 유휴 상태일 때 쓰는 것이 좋습니다. |

예시:

```text
/route 이 PDF에서 CRISPR screen 관련 후보 유전자를 정리해줘
```

```text
/synth 이 아키텍처에서 실패할 가능성이 큰 지점을 찾아줘
```

```text
/query ChatKJB에서 Claude 토큰 한도 전환은 어떻게 동작해?
```

## 파일을 보내고 받는 방법

ChatKJB는 텔레그램에 올린 파일을 Mac의 수신함 폴더에 저장한 뒤, 그 경로를 AI에게 알려 줍니다.

지원하는 입력은 사진, 문서, 오디오, 음성, 동영상, GIF, 스티커입니다. PDF는 텍스트 추출과 그림 추출 도구도 사용할 수 있습니다.

파일을 보내는 방법:

1. 작업 주제 안에 파일을 그냥 올립니다.
2. 필요하면 캡션에 지시를 적습니다.
3. ChatKJB가 저장 경로를 알려 주고 AI에게 전달합니다.

결과 파일을 받는 방법:

```text
/upload output/result.pdf
```

상대 경로는 현재 프로젝트 폴더 기준입니다. 절대 경로도 사용할 수 있습니다.

## 승인과 안전장치

ChatKJB는 혼자 마음대로 모든 일을 하지 않도록 설계되어 있습니다.

- 허용된 텔레그램 사용자와 그룹에서 온 메시지만 처리합니다.
- 프로젝트 목록에 등록된 폴더를 중심으로 작업합니다.
- 위험하거나 불확실한 도구 실행은 텔레그램 버튼으로 승인받습니다.
- 토큰, API 키, 비밀번호처럼 보이는 값은 로그와 메시지에서 마스킹합니다.
- `.env`, SQLite 데이터베이스, 실제 프로젝트 경로가 담긴 `projects.json`은 Git에 올리지 않습니다.

권한 모드는 `/mode`에서 바꿀 수 있습니다.

| 모드 | 의미 |
| --- | --- |
| `auto` | 기본값입니다. 일반적인 작업은 자동 판단하고, 위험한 작업은 승인 요청합니다. |
| `default` | 더 보수적으로 묻습니다. |
| `acceptEdits` | 파일 편집은 더 쉽게 허용하고, 그 외 작업은 확인합니다. |
| `plan` | 읽기와 계획 중심입니다. 실제 변경은 제한합니다. |
| `dontAsk` | 가장 자동화된 모드입니다. 신뢰하는 작업에만 쓰는 것이 좋습니다. |

## 제공자 선택

ChatKJB는 세 종류의 AI 실행기를 묶어 씁니다.

| 제공자 | 강점 | 필요한 인증 |
| --- | --- | --- |
| Claude | 계획, 복잡한 코드 이해, 장문 추론, 도구 승인 흐름 | Claude 구독 OAuth 토큰 |
| Codex | 코드 수정, 테스트 기반 작업, OpenAI Codex SDK 흐름 | ChatGPT 로그인 기반 Codex 계정 |
| agy | Gemini 기반 장문 분석과 Antigravity SDK 세션 | Gemini API 키 |

새 작업 전에는 아래쪽 패널에서 기본 제공자를 고를 수 있습니다. 작업 중 제공자를 바꾸려면 `/model`을 쓰면 됩니다. 제공자를 바꿀 때는 이전 대화 전체를 그대로 복사하지 않고, 핵심 목표와 변경 내용을 요약해 다음 AI에게 넘깁니다.

## 자동 목표 진행

`/goal`은 한 번에 끝나지 않는 작업을 자동으로 이어 가게 하는 명령입니다.

예시:

```text
/goal README가 비개발자용으로 정리되고, npm test와 npm run typecheck가 통과한다
check: npm test
check: npm run typecheck
```

동작 방식:

- 한 턴이 끝나면 목표가 달성됐는지 확인합니다.
- `check:` 줄이 있으면 그 명령을 먼저 실행해 객관적으로 판정합니다.
- 아직 부족하면 같은 목표를 향해 다음 턴을 자동으로 예약합니다.
- 최대 턴 수가 있어 무한 반복을 막습니다.
- `/goal clear` 또는 `/stop`으로 멈출 수 있습니다.

## 사용량과 한도

`/usage`는 Claude와 Codex 계정의 사용 상태를 보여 줍니다. Claude OAuth 토큰이나 Codex 계정 홈을 여러 개 등록해 두면, 한 계정이 한도에 걸렸을 때 다른 계정으로 전환할 수 있습니다.

한도가 모두 찬 경우에는 가능한 회복 시각까지 기다렸다가 자동 재개하는 상태로 들어갈 수 있습니다. 급한 작업이라면 `/status`와 `/usage`를 함께 확인하십시오.

## 대화 기록과 장기 기억

ChatKJB는 대화가 끝난 뒤 LLM-Wiki로 transcript와 `.result.md` 결과 로그를 보낼 수 있습니다. 이렇게 쌓인 기록은 나중에 `/query`로 다시 찾아볼 수 있습니다.

`/memory`는 현재 세션에서 오래 기억할 만한 사실만 선별해 전역 메모리에 저장합니다. 임시 상태, 추측, 비밀, 단순 작업 로그는 저장 대상이 아닙니다.

---

# 2부. 설치와 운영

여기부터는 ChatKJB를 직접 Mac에서 띄우는 사람을 위한 내용입니다.

## 필요한 것

- macOS
- Node.js 22 이상
- Telegram 봇 토큰
- Telegram forum supergroup
- 사용할 AI 제공자 인증
  - Claude: `claude setup-token`으로 만든 OAuth 토큰
  - Codex: `codex login`으로 ChatGPT 로그인한 `CODEX_HOME`
  - agy: Gemini API 키
- 작업할 프로젝트 폴더

## 저장소 받기

```bash
git clone https://github.com/neam-kim/ChatKJB
cd ChatKJB
npm install
```

이 저장소의 `package.json` 이름은 아직 내부 런타임 호환성을 위해 `telegram-claude-orchestrator`입니다. GitHub 저장소명 `ChatKJB`와 launchd 라벨 `com.neam.telegram-claude-orchestrator`는 같은 시스템을 가리킵니다.

## Telegram 준비

1. BotFather에서 새 봇을 만들고 토큰을 받습니다.
2. 본인용 Telegram supergroup을 만들고 Topics 기능을 켭니다.
3. 봇을 그룹 관리자로 추가합니다.
4. 봇에 `Manage Topics`, `Delete Messages` 권한을 줍니다.
5. 본인 Telegram user ID와 그룹 chat ID를 확인합니다.

ChatKJB는 `.env`의 허용 user ID와 chat ID가 모두 맞는 업데이트만 처리합니다.

## 환경 파일 만들기

```bash
test -f .env || cp .env.example .env
chmod 600 .env
```

필수 값 예시:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
TELEGRAM_CHAT_ID=-100...
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
GEMINI_API_KEY=...
```

두 Telegram 계정에서 같은 그룹을 쓰려면 쉼표로 추가 허용 ID를 등록합니다.

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Claude OAuth 토큰은 다음 명령으로 설정할 수 있습니다.

```bash
npm run auth:setup
```

Codex는 각 계정 홈에서 한 번 로그인합니다.

```bash
CODEX_HOME=/Users/me/.codex codex login
```

여러 Codex 계정을 쓰려면 `.env`에 쉼표로 등록합니다.

```dotenv
CODEX_ACCOUNT_HOMES=/Users/me/.codex,/Users/me/.codex-acct-b
```

## 프로젝트 등록

`projects.json`은 실제 작업 폴더 목록입니다. Git에는 올리지 않습니다.

```bash
cp projects.example.json projects.json
```

예시:

```json
[
  {
    "name": "ChatKJB",
    "cwd": "/Users/neam/Library/CloudStorage/SynologyDrive-neam/AI/ChatKJB",
    "defaultMode": "auto"
  }
]
```

텔레그램에서도 `/addp /절대/경로`로 프로젝트를 추가하고 `/deltp 이름`으로 제거할 수 있습니다. 등록 삭제는 목록에서만 제거하며 실제 폴더는 지우지 않습니다.

## 실행

개발 실행:

```bash
npm run dev
```

빌드 후 실행:

```bash
npm run build
npm start
```

## Mac 자동 시작

launchd LaunchAgent를 설치합니다.

```bash
npm run launchd:install
```

재시작:

```bash
npm run launchd:restart
```

중지:

```bash
launchctl bootout gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

주의: `bootout`은 등록 해제와 중지를 함께 하므로, 단순 재시작에는 `npm run launchd:restart`를 쓰십시오.

로그:

```text
data/stdout.log
data/stderr.log
```

## LLM-Wiki transcript 수집

완료된 세션과 `.result.md` 결과 로그를 LLM-Wiki inbox로 모을 수 있습니다.

수동 실행:

```bash
npm run transcripts:dump
```

LaunchAgent 설치:

```bash
npm run transcripts:install-agent
```

특징:

- 같은 세션을 반복 덤프해도 새로 늘어난 대화 묶음만 기록합니다.
- Unicode와 공백을 정규화한 지문으로 중복을 막습니다.
- 완료, 오류, 중단, 검증 실패 상태의 세션만 처리합니다.
- 사용자 홈과 SynologyDrive 아래의 `.result.md`를 찾아 하나의 결과 로그 파일로 병합할 수 있습니다.

## PDF 도구

`scripts/pdf-tools-mcp.py`는 이미 설치된 PyMuPDF(`fitz`)만 사용해 PDF 도구를 제공합니다.

도구:

- `pdftotext`: PDF 텍스트를 `.txt` 파일로 저장하고 경로를 반환합니다.
- `pdf_extract_figures`: PDF 안의 이미지 또는 페이지 렌더링 결과를 PNG로 저장하고 경로를 반환합니다.

대용량 PDF 본문을 텔레그램 메시지로 길게 밀어 넣지 않고 파일 경로로 넘기기 위한 도구입니다.

## 공통 자원 계층

ChatKJB는 Claude, Codex, agy가 같은 지침과 도구 구성을 보도록 공통 자원 계층을 만듭니다.

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

## 운영 점검

자주 쓰는 점검 명령:

```bash
npm run typecheck
npm test
npm run build
npm run launchd:restart
launchctl print gui/$(id -u)/com.neam.telegram-claude-orchestrator
```

이 저장소는 Node 22 런타임을 기준으로 검증되었습니다. 다른 Node 버전에서 `better-sqlite3` ABI 오류가 나면 Node 22 경로로 실행해야 합니다.

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

## 주요 디렉터리

| 경로 | 역할 |
| --- | --- |
| `src/` | 봇 본체와 세션 실행 로직 |
| `scripts/` | 인증, launchd, transcript dump, PDF MCP, agy 브리지 |
| `tests/` | vitest 테스트 |
| `launchd/` | LaunchAgent 템플릿 |
| `data/` | 런타임 DB와 로그. Git 제외 |
| `dist/` | 빌드 산출물. Git 제외 |

## 핵심 파일

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 앱 진입점, 설정 로딩, 명령 메뉴 등록, 봇 시작 |
| `src/config.ts` | `.env`, `projects.json`, 실행 경로 설정 |
| `src/bot.ts` | Telegram 명령, 버튼, 미디어 입력 처리 |
| `src/session-manager.ts` | 세션 실행, 제공자 전환, 목표 자동 진행, 한도 전환 |
| `src/store.ts` | SQLite 스키마와 CRUD |
| `src/model-catalog.ts` | 제공자별 모델 목록과 fallback |
| `src/permission-broker.ts` | Claude 도구 승인 브로커 |
| `src/token-pool.ts` | Claude OAuth 토큰 회전과 한도 상태 |
| `src/codex-account-pool.ts` | Codex 계정 홈 회전 |
| `src/connectors.ts` | MCP 커넥터 병합과 동기화 |
| `src/resource-sync.ts` | 공통 지침, 메모리, 스킬, 커넥터 자원 생성 |
| `src/usage.ts` | 사용량 표시 포매팅 |
| `src/redaction.ts` | 비밀정보 마스킹 |
| `src/orchestration/local-tiers.ts` | 로컬 Ollama 티어 호출, 타임아웃, 동적 `num_ctx` |
| `src/goal-checks.ts` | `/goal`의 결정론적 `check:` 게이트와 위험도 추정 |

## 요청 처리 흐름

1. `index.ts`가 봇과 저장소, 모델 카탈로그, 공통 자원을 초기화합니다.
2. `bot.ts`가 Telegram 업데이트를 받고 허용된 사용자와 그룹인지 확인합니다.
3. `/new`는 프로젝트를 고르고 새 topic과 세션을 만듭니다.
4. 일반 메시지는 해당 topic의 세션으로 이어집니다.
5. `session-manager.ts`가 세션 제공자에 따라 Claude, Codex, agy를 실행합니다.
6. 스트리밍 출력과 승인 요청은 Telegram topic에 전송됩니다.
7. 완료 후 상태와 사용량, 결과 요약이 저장됩니다.

## 새 명령을 추가하는 위치

1. `src/bot.ts`에 `bot.command("name", ...)` 핸들러를 추가합니다.
2. Telegram 공개 메뉴에 보여야 하면 `src/index.ts`의 `setMyCommands`에도 추가합니다.
3. 세션 상태가 필요하면 `src/types.ts`와 `src/store.ts` 마이그레이션을 수정합니다.
4. 실행 옵션에 영향을 주면 `src/session-manager.ts`에서 세 제공자 경로를 확인합니다.
5. 상태 표시가 필요하면 `formatSessionStatus`에 추가합니다.
6. README 명령표와 테스트를 갱신합니다.

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

agy live 테스트는 실제 인증과 네트워크가 필요하므로 별도 스크립트로 분리되어 있습니다.

```bash
npm run test:agy-live
```

## 커밋 전 확인할 것

- `.env`, `projects.json`, `data/`가 Git에 들어가지 않았는지 확인합니다.
- 토큰이나 API 키가 README, 테스트 fixture, 로그에 포함되지 않았는지 확인합니다.
- 사용자에게 보이는 명령을 바꿨다면 README와 `setMyCommands`를 함께 갱신합니다.
- 런타임 라벨 `com.neam.telegram-claude-orchestrator`를 바꾸는 작업은 launchd, 로그, 메모리, 기존 DB 경로까지 함께 점검해야 합니다.

---

# 현재 제한

- 단일 Telegram supergroup을 기준으로 동작합니다.
- Telegram Bot API 제한상 큰 파일 수신에는 제한이 있습니다.
- 사용자가 앱에서 직접 삭제한 topic은 Telegram이 삭제 이벤트를 보내지 않으므로, 로컬 세션까지 지우려면 `/delete`를 사용해야 합니다.
- 프로젝트별 작업 큐는 충돌 방지를 위해 한 번에 하나씩 실행합니다.
- Codex는 계정 전환 시 기존 Codex 스레드를 그대로 이어받지 못할 수 있어 요약 기반으로 새 스레드를 시작합니다.
- agy는 Gemini API 키와 SDK 상태에 의존합니다.

---

# 빠른 참조

```bash
npm install
npm run auth:setup
npm run build
npm start
```

```bash
npm run typecheck
npm test
npm run build
```

```bash
npm run launchd:install
npm run launchd:restart
```

Telegram에서:

```text
/new
/status
/usage
/goal clear
/stop
```
