# Telegram Claude Orchestrator

## 이 프로젝트는 무엇인가요?

이 프로젝트는 Telegram 단체 채팅방에서 Claude AI에게 일을 맡길 수 있게 해 주는 개인용 봇입니다.

쉽게 말하면, 이 봇은 “Telegram 채팅방으로 Claude AI에게 작업을 시키는 리모컨”입니다. 예를 들어 Telegram 그룹에서 “내 프로젝트의 README를 더 쉽게 고쳐줘”, “방금 만든 기능을 확인해줘”, “이 파일을 읽고 요약해줘”라고 말하면, Mac에서 켜져 있는 이 프로그램이 Claude에게 그 일을 전달합니다.

중요한 점은 이 봇이 공개 서비스가 아니라는 것입니다. 내 Mac, 내 Telegram 그룹, 내 Claude 구독을 연결해 나 혼자 쓰는 도구입니다.

## 시작 전에 필요한 것

1. Mac 한 대가 필요합니다. Claude가 실제 파일을 읽고 작업하는 장소입니다.
2. Mac은 봇을 쓰는 동안 켜져 있어야 합니다. 잠자기 상태가 되면 봇도 멈춘 것처럼 보일 수 있습니다.
3. Telegram 계정이 필요합니다.
4. Telegram에서 개인용 봇을 만들 수 있어야 합니다. BotFather라는 공식 봇을 사용합니다.
5. Telegram 비공개 그룹이 필요합니다. 이 그룹 안에서 봇에게 명령합니다.
6. Claude Pro, Max, Team, Enterprise 같은 Claude 구독이 필요합니다.
7. Claude CLI가 필요합니다. CLI는 “터미널에서 Claude를 실행하는 작은 앱”이라고 생각하면 됩니다.
8. `/plan` 기능까지 쓰려면 ChatGPT 구독으로 로그인된 Codex CLI가 필요합니다.
9. 인터넷 연결이 필요합니다.
10. 설치할 때만 Mac의 터미널 앱을 사용합니다. 터미널은 “Mac에 글자로 명령을 입력하는 앱”입니다.

## 전체 설치 흐름

1. Homebrew를 설치합니다.
2. nvm으로 Node.js를 설치합니다.
3. 이 프로젝트를 Mac에 내려받습니다.
4. 필요한 부품을 설치합니다.
5. Telegram에서 봇과 그룹을 만듭니다.
6. 내 Telegram 사용자 ID와 그룹 ID를 확인합니다.
7. Claude 토큰을 만듭니다.
8. `.env` 파일에 비밀 설정을 적습니다.
9. `projects.json` 파일에 Claude가 작업할 폴더를 등록합니다.
10. 봇을 실행하고 Telegram에서 확인합니다.

## 1. Homebrew 설치하기

Homebrew는 Mac에 필요한 프로그램을 쉽게 설치해 주는 도구입니다. App Store처럼 프로그램을 찾아 설치해 주지만, 터미널에서 한 줄 명령으로 사용합니다.

1. Mac에서 `터미널` 앱을 엽니다.
2. 아래 한 줄을 그대로 복사해서 붙여넣고 Enter를 누릅니다.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

3. 중간에 Mac 비밀번호를 물어보면 입력합니다. 입력해도 화면에 글자가 보이지 않는 것이 정상입니다.
4. 설치가 끝나면 터미널에 Homebrew를 사용하기 위한 안내 문장이 나올 수 있습니다. 안내가 나오면 그대로 복사해서 한 줄씩 실행합니다.

## 2. nvm과 Node.js 설치하기

nvm은 Node.js 버전을 관리해 주는 도구입니다. Node.js는 이 Telegram 봇을 실행하기 위한 기본 실행 프로그램입니다.

1. nvm을 설치합니다.

```bash
brew install nvm
```

2. nvm이 사용할 폴더를 만듭니다.

```bash
mkdir -p ~/.nvm
```

3. Mac이 nvm을 기억하도록 설정합니다.

```bash
echo 'export NVM_DIR="$HOME/.nvm"; [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"; [ -s "/usr/local/opt/nvm/nvm.sh" ] && . "/usr/local/opt/nvm/nvm.sh"' >> ~/.zshrc
```

4. 터미널 설정을 다시 읽습니다.

```bash
source ~/.zshrc
```

5. Node.js 22 버전을 설치합니다.

```bash
nvm install 22
```

6. Node.js 22를 기본으로 사용하게 설정합니다.

```bash
nvm alias default 22
```

7. 설치가 되었는지 확인합니다.

```bash
node -v
```

## 3. 이 프로젝트 내려받기

1. 터미널에서 프로젝트를 보관할 폴더로 이동합니다. 예를 들어 Downloads 폴더로 이동하려면 아래 명령을 사용합니다.

```bash
cd ~/Downloads
```

2. GitHub에서 이 프로젝트를 내려받습니다. `git clone`은 인터넷 저장소를 내 Mac으로 복사한다는 뜻입니다.

```bash
git clone https://github.com/neam-kim/telegram-clause-SDK-public.git
```

3. 내려받은 프로젝트 폴더로 들어갑니다.

```bash
cd telegram-clause-SDK-public
```

## 4. 필요한 부품 설치하기

npm은 Node.js 프로그램에 필요한 부품을 설치하는 도구입니다. 아래 명령은 이 봇이 필요한 부품을 자동으로 내려받습니다.

```bash
npm install
```

## 5. Telegram 봇 만들기

Telegram 봇은 Telegram 안에서 메시지를 받고 답장하는 별도 계정입니다. BotFather는 Telegram이 공식으로 제공하는 봇 생성 도우미입니다.

1. 스마트폰이나 Mac에서 Telegram을 엽니다.
2. 검색창에 `@BotFather`를 입력합니다.
3. 파란 체크 표시가 있는 공식 BotFather를 엽니다.
4. 채팅창에 `/newbot`을 보냅니다.
5. BotFather가 봇 이름을 물어보면 보기 좋은 이름을 입력합니다. 예: `My Claude Helper`
6. BotFather가 사용자 이름을 물어보면 반드시 `bot`으로 끝나는 이름을 입력합니다. 예: `my_claude_helper_bot`
7. BotFather가 긴 토큰을 보여 줍니다. 이 값은 나중에 `.env` 파일의 `TELEGRAM_BOT_TOKEN`에 넣습니다.
8. 토큰은 비밀번호처럼 다룹니다. 다른 사람에게 보여 주면 안 됩니다.

스크린샷을 찍는다면 이런 장면이 필요합니다.

1. BotFather 검색 화면: 검색창에 `@BotFather`가 입력되어 있고 공식 계정이 보이는 장면
2. `/newbot`을 보낸 화면: BotFather가 이름을 물어보는 장면
3. 봇 사용자 이름을 입력한 화면: `...bot`으로 끝나는 이름을 넣는 장면
4. 토큰이 발급된 화면: 긴 토큰이 보이되, 공유용 문서에서는 일부를 가린 장면

## 6. Telegram 그룹 만들고 Topics 켜기

이 봇은 Telegram 그룹의 “Topics” 기능을 사용합니다. Topic은 그룹 안에 생기는 작은 대화방입니다. 작업 하나가 Topic 하나로 관리됩니다.

1. Telegram에서 새 그룹을 만듭니다.
2. 처음에는 나 혼자만 있어도 됩니다.
3. 그룹 이름을 정합니다. 예: `Claude 작업방`
4. 그룹 설정을 엽니다.
5. `Topics` 또는 `토픽` 기능을 켭니다.
6. 방금 만든 봇을 그룹에 초대합니다.
7. 그룹 설정에서 봇을 관리자로 지정합니다.
8. 봇에게 최소한 다음 권한을 줍니다.
9. `Manage Topics` 권한을 켭니다. 봇이 작업별 Topic을 만들 수 있게 합니다.
10. `Delete Messages` 권한을 켭니다. `/delete`로 작업 Topic을 지울 수 있게 합니다.
11. 가능하면 메시지 읽기와 파일 보내기 관련 권한도 허용합니다.

스크린샷을 찍는다면 이런 장면이 필요합니다.

1. 새 그룹 만들기 화면
2. 그룹 설정에서 Topics를 켠 화면
3. 구성원 목록에 봇이 들어간 화면
4. 봇의 관리자 권한 화면에서 `Manage Topics`가 켜진 장면

## 7. 내 user ID와 그룹 chat ID 확인하기

이 봇은 안전을 위해 정해진 사람과 정해진 그룹의 메시지만 듣습니다. 그래서 내 Telegram user ID와 그룹 chat ID가 필요합니다.

1. Telegram 검색창에 `@userinfobot`을 입력합니다.
2. `@userinfobot`에게 아무 메시지나 보냅니다.
3. 답장에 나오는 내 숫자 ID를 복사합니다. 이 값은 `.env`의 `TELEGRAM_ALLOWED_USER_ID`에 넣습니다.
4. 방금 만든 Telegram 그룹에 `@userinfobot`을 초대합니다.
5. 그룹 안에서 아무 메시지나 보냅니다.
6. `@userinfobot`이 그룹 정보를 알려 주면 chat ID를 확인합니다.
7. 그룹 chat ID는 보통 `-100`으로 시작하는 긴 숫자입니다. 이 값은 `.env`의 `TELEGRAM_CHAT_ID`에 넣습니다.
8. 확인이 끝나면 `@userinfobot`은 그룹에서 내보내도 됩니다.

스크린샷을 찍는다면 이런 장면이 필요합니다.

1. `@userinfobot` 개인 채팅에서 내 user ID가 보이는 화면
2. 그룹 안에서 chat ID가 보이는 화면
3. chat ID가 `-100...` 형태인지 확인하는 장면

## 8. Claude 토큰 만들기

Claude 토큰은 이 봇이 내 Claude 구독으로 Claude를 실행하기 위한 비밀 열쇠입니다. 이 프로젝트는 일반 API 키가 아니라 `claude setup-token`으로 만든 OAuth 토큰을 사용합니다.

1. 터미널에서 프로젝트 폴더에 있는지 확인합니다.

```bash
pwd
```

2. Claude 토큰 만들기 명령을 실행합니다.

```bash
claude setup-token
```

3. 브라우저가 열리면 Claude 계정으로 로그인합니다.
4. 터미널에 `sk-ant-oat01-`로 시작하는 긴 토큰이 표시됩니다.
5. 그 토큰을 복사합니다.
6. 나중에 `.env` 파일의 `CLAUDE_CODE_OAUTH_TOKEN`에 붙여넣습니다.

이 저장소에는 토큰 저장을 도와주는 명령도 있습니다. 이 명령은 `claude setup-token`을 실행한 뒤 토큰을 `.env`에 저장하는 과정을 도와줍니다.

```bash
npm run auth:setup
```

## 9. `.env` 파일 만들기

`.env` 파일은 비밀 설정을 넣는 파일입니다. Telegram 봇 토큰, 내 user ID, 그룹 chat ID, Claude 토큰이 들어갑니다. 절대 GitHub나 다른 사람에게 공유하지 마세요.

1. 프로젝트 폴더에서 예시 파일을 복사합니다.

```bash
cp .env.example .env
```

2. `.env` 파일을 엽니다.

```bash
open -a TextEdit .env
```

3. 아래 예시처럼 값을 채웁니다. 예시 값은 가짜입니다.

```dotenv
TELEGRAM_BOT_TOKEN=1234567890:AAFakeTelegramBotTokenForExampleOnly
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_CHAT_ID=-1001234567890
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fakeclaudetokenexample
CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-fakesecondtokenexample
CLAUDE_CODE_OAUTH_TOKEN_3=sk-ant-oat01-fakethirdtokenexample
DATABASE_PATH=./data/state.sqlite
PROJECTS_PATH=./projects.json
APPROVAL_TIMEOUT_MINUTES=30
STATUS_DEBOUNCE_MS=2500
MCP_TOOL_TIMEOUT_SECONDS=60
MCP_MAX_ATTEMPTS=3
CODEX_MCP_TIMEOUT_MINUTES=30
CODEX_MCP_HEARTBEAT_SECONDS=60
LONG_RUNNING_MCP_SERVERS=codex,obsidian
TURN_IDLE_TIMEOUT_MINUTES=35
CLAUDE_MEMORY_DIR=~/.claude/memory
FILE_INBOX_DIR=~/.claude/channels/telegram/inbox
CLAUDE_CODE_EXECUTABLE=
```

4. 파일을 저장합니다.
5. 비밀 파일 권한을 안전하게 바꿉니다.

```bash
chmod 600 .env
```

## `.env`의 모든 항목 설명

1. `TELEGRAM_BOT_TOKEN`: BotFather가 준 봇 토큰입니다. 봇의 비밀번호라고 생각하면 됩니다.
2. `TELEGRAM_ALLOWED_USER_ID`: 봇을 사용할 내 Telegram 숫자 ID입니다. 이 사람의 메시지만 처리합니다.
3. `TELEGRAM_CHAT_ID`: 봇을 사용할 Telegram 그룹의 숫자 ID입니다. 이 그룹의 메시지만 처리합니다.
4. `CLAUDE_CODE_OAUTH_TOKEN`: `claude setup-token`으로 만든 Claude 토큰입니다.
5. `CLAUDE_CODE_OAUTH_TOKEN_2`: 선택 항목입니다. 다른 Claude 계정 토큰이 있으면 넣습니다. 첫 번째 토큰이 한도에 닿으면 자동으로 다음 토큰을 사용합니다.
6. `CLAUDE_CODE_OAUTH_TOKEN_3`: 선택 항목입니다. 세 번째 Claude 계정 토큰입니다.
7. `DATABASE_PATH`: 봇의 작업 기록을 저장할 파일 위치입니다. 기본값 그대로 두면 됩니다.
8. `PROJECTS_PATH`: 작업할 프로젝트 목록 파일 위치입니다. 기본값 그대로 두면 됩니다.
9. `APPROVAL_TIMEOUT_MINUTES`: Claude가 위험한 작업 전에 승인을 요청했을 때, 몇 분 동안 기다릴지 정합니다.
10. `STATUS_DEBOUNCE_MS`: 진행 상황 메시지를 너무 자주 보내지 않도록 조절하는 값입니다. 기본값 그대로 두면 됩니다.
11. `MCP_TOOL_TIMEOUT_SECONDS`: Claude가 외부 도구를 호출했을 때 일반적으로 몇 초까지 기다릴지 정합니다.
12. `MCP_MAX_ATTEMPTS`: 외부 도구 오류가 났을 때 몇 번까지 다시 시도할지 정합니다.
13. `CODEX_MCP_TIMEOUT_MINUTES`: Codex처럼 오래 걸릴 수 있는 작업을 몇 분까지 기다릴지 정합니다.
14. `CODEX_MCP_HEARTBEAT_SECONDS`: 오래 걸리는 Codex 작업 중 몇 초마다 “아직 진행 중”이라고 알려 줄지 정합니다.
15. `LONG_RUNNING_MCP_SERVERS`: 오래 걸릴 수 있는 도구 이름 목록입니다. 기본값 그대로 두면 됩니다.
16. `TURN_IDLE_TIMEOUT_MINUTES`: 아무 응답도 없이 너무 오래 멈춰 있을 때 작업을 중단하기 위한 안전 시간입니다.
17. `CLAUDE_MEMORY_DIR`: `/memory` 명령으로 저장되는 장기 메모리 폴더입니다.
18. `FILE_INBOX_DIR`: Telegram으로 받은 파일을 Mac에 저장할 폴더입니다.
19. `CLAUDE_CODE_EXECUTABLE`: Claude 실행 파일 위치를 직접 지정해야 할 때만 사용합니다. 보통 비워 둡니다.

## 10. `projects.json` 만들기

프로젝트는 Claude가 실제로 작업할 폴더입니다. 예를 들어 내 웹사이트 폴더, 글쓰기 폴더, Obsidian vault 폴더, 앱 개발 폴더가 각각 프로젝트가 될 수 있습니다.

1. 예시 파일을 복사합니다.

```bash
cp projects.example.json projects.json
```

2. `projects.json` 파일을 엽니다.

```bash
open -a TextEdit projects.json
```

3. 아래 예시처럼 내 Mac의 실제 폴더 경로를 적습니다.

```json
[
  {
    "name": "my-notes",
    "aliases": ["notes", "obsidian"],
    "cwd": "/Users/your-name/Documents/ObsidianVault",
    "defaultMode": "auto"
  },
  {
    "name": "my-website",
    "aliases": ["site", "web"],
    "cwd": "/Users/your-name/Projects/my-website",
    "defaultMode": "auto"
  }
]
```

4. `name`은 Telegram에서 보일 프로젝트 이름입니다.
5. `aliases`는 짧은 별명입니다. 예를 들어 `notes`라고 부를 수 있습니다.
6. `cwd`는 Claude가 작업할 실제 폴더 경로입니다. 반드시 `/Users/...`로 시작하는 전체 경로를 넣습니다.
7. `defaultMode`는 새 작업의 기본 승인 방식입니다. 처음에는 `auto`를 추천합니다.
8. 파일을 저장합니다.

## 11. 봇 실행하기

1. 먼저 프로그램을 실행 가능한 상태로 준비합니다.

```bash
npm run build
```

2. 봇을 시작합니다.

```bash
npm start
```

3. Telegram 그룹으로 갑니다.
4. 그룹 일반 채팅에서 아래 명령을 보냅니다.

```text
/status
```

5. “오케스트레이터: 정상 응답” 같은 답장이 오면 연결된 것입니다.
6. 새 작업을 시작하려면 아래 명령을 보냅니다.

```text
/new
```

7. 버튼으로 프로젝트, 모델, thinking 수준을 고릅니다.
8. 봇이 “실행할 작업을 입력하세요”라고 하면 원하는 일을 평소 말하듯 입력합니다.

## 기본 사용법

1. Telegram 그룹에서 `/new`를 보냅니다.
2. 프로젝트를 선택합니다.
3. Claude 모델을 선택합니다.
4. thinking 수준을 선택합니다.
5. 하고 싶은 일을 문장으로 보냅니다.
6. 봇이 새 Topic을 만들고 그 안에서 작업을 진행합니다.
7. 이후 같은 작업의 후속 요청은 그 Topic 안에서 보냅니다.

예를 들어 이렇게 사용할 수 있습니다.

```text
/new notes
```

```text
이번 주 회의 메모를 읽고 해야 할 일을 정리해줘.
```

## 전체 명령어 설명

## `/new`

새 Claude 작업을 시작합니다.

```text
/new
```

프로젝트 이름이나 별명을 바로 붙일 수도 있습니다.

```text
/new my-notes
```

## `/status`

봇이 살아 있는지, 현재 실행 중인 작업이 있는지 확인합니다.

```text
/status
```

작업 Topic 안에서 쓰면 그 작업의 상태를 보여 줍니다. 그룹 일반 채팅에서 쓰면 전체 상태를 보여 줍니다.

## `/doctor`

설정이 제대로 되었는지 점검합니다. Telegram 연결, Claude 토큰, 프로젝트 경로, 저장소 상태, LaunchAgent 상태 등을 확인합니다.

```text
/doctor
```

## `/plan`

큰 작업을 더 안전하게 진행합니다. Claude가 먼저 계획을 만들고, 사용자가 승인하면 Codex가 구현하고, 다시 Claude가 검토합니다.

```text
/plan 로그인 화면 문구를 더 친절하게 바꾸고 관련 테스트도 확인해줘.
```

이 명령은 기존 작업 Topic 안에서 사용합니다.

## `/addp`

새 프로젝트 폴더를 등록합니다.

```text
/addp /Users/your-name/Projects/new-project
```

경로를 빼고 보내면 봇이 “추가할 프로젝트의 절대경로를 입력하세요”라고 물어봅니다.

## `/deltp`

등록된 프로젝트를 목록에서 제거합니다. 실제 폴더와 파일은 지우지 않습니다.

```text
/deltp my-website
```

## `/sessions`

최근 작업 목록을 보여 줍니다.

```text
/sessions
```

## `/usage`

Claude 구독 한도 사용량을 확인합니다. 여러 Claude 토큰을 등록했다면 토큰별 상태도 보여 줍니다.

```text
/usage
```

## `/projects`

등록된 프로젝트 목록을 보여 줍니다.

```text
/projects
```

## `/steer`

현재 실행 중인 작업에 즉시 방향 수정 지시를 보냅니다.

```text
/steer 방금 말한 방향 말고, 기존 디자인을 최대한 유지해줘.
```

실행 중인 작업 Topic 안에서 사용합니다.

## `/next`

현재 작업이 끝난 뒤 이어서 할 일을 예약합니다.

```text
/next 끝나면 변경된 내용을 짧게 요약해줘.
```

작업이 이미 끝난 상태라면 바로 후속 작업을 시작합니다.

## `/stop`

현재 실행 중인 작업을 중단합니다.

```text
/stop
```

## `/fork`

현재 대화 내용을 바탕으로 새 방향의 작업을 시작합니다. 기존 작업은 그대로 두고, 새 가지를 만드는 느낌입니다.

```text
/fork
```

명령 후 봇이 새 분기에서 실행할 지시를 물어봅니다.

## `/compact`

긴 대화 내용을 압축해서 이어가기 쉽게 만듭니다. 대화가 너무 길어졌을 때 사용합니다.

```text
/compact 핵심 결정과 남은 할 일 중심으로 압축해줘.
```

## `/memory`

앞으로도 계속 기억하면 좋은 사용자 선호나 프로젝트 지식을 Claude 메모리에 저장합니다.

```text
/memory 이 프로젝트에서는 한국어 답변과 작은 변경 단위를 선호한다는 점을 기억해줘.
```

## `/mode`

Claude가 파일 수정이나 명령 실행 전에 얼마나 자주 물어볼지 정합니다.

```text
/mode auto
```

값을 빼고 보내면 현재 모드와 선택 가능한 모드를 보여 줍니다.

```text
/mode
```

## `/model`

현재 작업 Topic에서 다음 실행에 사용할 Claude 모델을 바꿉니다.

```text
/model
```

버튼으로 모델을 고를 수 있습니다. 직접 입력하려면 모델 별명을 사용할 수도 있습니다.

```text
/model sonnet
```

## `/thinking`

Claude가 답을 내기 전에 얼마나 깊게 생각할지 정합니다.

```text
/thinking high
```

값을 빼고 보내면 버튼으로 선택할 수 있습니다.

```text
/thinking
```

## `/lean`

최소 구현 원칙을 켜거나 끕니다. 켜면 Claude가 불필요한 구조나 새 도구를 덜 만들고, 필요한 만큼만 바꾸려 합니다.

```text
/lean on
```

```text
/lean off
```

## `/diff`

현재 프로젝트에서 변경된 파일 요약을 보여 줍니다. Git을 사용하는 프로젝트에서 유용합니다.

```text
/diff
```

## `/delete`

현재 작업 Topic과 로컬 세션 기록, Claude 대화 원본을 삭제합니다. 되돌릴 수 없으므로 확인 버튼이 한 번 더 나옵니다.

```text
/delete
```

## `/upload`

Mac에 있는 파일을 Telegram으로 보냅니다. 작업 결과 PDF나 이미지 파일을 받을 때 유용합니다.

```text
/upload output/result.pdf
```

상대경로를 쓰면 현재 프로젝트 폴더 안에서 찾습니다. 전체 경로를 써도 됩니다.

## 파일 보내기

Telegram Topic 안에 사진, 문서, 음성, 동영상, GIF, 스티커 등을 보내면 봇이 Mac에 저장하고 Claude에게 파일 위치를 알려 줍니다.

1. 새 작업을 시작하려면 `/new`로 프로젝트를 먼저 선택합니다.
2. “실행할 작업을 입력하세요” 상태에서 파일을 보낼 수 있습니다.
3. 이미 만들어진 작업 Topic 안에서도 파일을 보낼 수 있습니다.
4. 파일과 함께 캡션을 쓰면 그 설명도 Claude에게 같이 전달됩니다.

## 모드 설명

## `default`

가장 기본적인 모드입니다. Claude가 위험할 수 있는 일은 더 자주 물어봅니다. 처음 써 보거나 중요한 폴더에서 작업할 때 적합합니다.

## `acceptEdits`

파일 수정은 비교적 자연스럽게 허용하고, 더 위험한 명령은 확인을 요구하는 모드입니다. 문서 수정이나 작은 코드 수정에 편합니다.

## `plan`

Claude가 먼저 계획을 세우고 조심스럽게 진행하는 모드입니다. 큰 작업을 바로 실행하지 않고 생각을 먼저 보고 싶을 때 좋습니다.

## `dontAsk`

가능한 한 묻지 않고 진행하는 모드입니다. 매우 편하지만 위험할 수 있습니다. 신뢰하는 프로젝트에서만 사용하세요.

## `auto`

상황에 맞게 자동으로 판단하는 모드입니다. 이 프로젝트의 기본 추천값입니다.

## Thinking 수준 설명

Thinking은 Claude가 답을 내기 전에 생각에 쓰는 강도입니다. 높을수록 복잡한 문제에 유리할 수 있지만, 더 오래 걸리고 사용량도 더 빨리 쓸 수 있습니다.

## `adaptive`

자동 모드입니다. Claude가 작업 난이도에 맞춰 생각의 깊이를 조절합니다. 대부분의 경우 추천합니다.

## `off`

추가 thinking을 끕니다. 간단한 질문, 짧은 문서 수정, 빠른 확인에 적합합니다.

## `low`

낮은 수준입니다. 간단하지만 약간의 판단이 필요한 작업에 좋습니다.

## `medium`

보통 수준입니다. 일반적인 수정, 요약, 확인 작업에 무난합니다.

## `high`

높은 수준입니다. 복잡한 코드 수정, 설계 판단, 오류 추적에 좋습니다.

## `xhigh`

매우 높은 수준입니다. 어려운 문제를 더 깊게 보게 하고 싶을 때 사용합니다.

## `max`

최대 수준입니다. 가장 복잡한 작업에만 사용하세요. 시간이 오래 걸리고 사용량을 많이 쓸 수 있습니다.

## Mac에서 백그라운드 서비스로 실행하기

터미널 창을 계속 열어 두지 않고 봇을 켜 두려면 macOS의 LaunchAgent를 사용합니다. LaunchAgent는 “Mac 로그인 후 자동으로 앱을 실행해 주는 기능”입니다.

1. 프로젝트 폴더로 이동합니다.

```bash
cd ~/telegram-clause-SDK-public
```

2. 프로그램을 빌드합니다.

```bash
npm run build
```

3. LaunchAgent를 설치합니다.

```bash
npm run launchd:install
```

4. Telegram 그룹에서 상태를 확인합니다.

```text
/status
```

5. 설정을 바꾼 뒤 다시 시작하려면 아래 명령을 사용합니다.

```bash
npm run launchd:restart
```

6. 실행 로그는 프로젝트 폴더의 `data/stdout.log`와 `data/stderr.log`에 저장됩니다.
7. 문제가 생기면 Telegram에서 `/doctor`를 먼저 실행해 보세요.

## 자주 묻는 질문

## Claude 사용량 한도에 도달하면 어떻게 되나요?

`.env`에 `CLAUDE_CODE_OAUTH_TOKEN_2`, `CLAUDE_CODE_OAUTH_TOKEN_3`을 등록해 두었다면 봇이 다음 사용 가능한 토큰으로 자동 전환합니다. 한도 회복 시간이 확인되면 그 시간까지 해당 토큰을 쉬게 합니다. 회복 시간을 알 수 없으면 기본적으로 약 1시간 동안 해당 토큰을 다시 쓰지 않습니다.

모든 토큰이 한도에 도달하면 더 이상 자동 전환할 수 없습니다. 그때는 Claude 한도가 회복될 때까지 기다려야 합니다.

## Overloaded 오류는 무엇인가요?

Overloaded는 내 설정 문제가 아니라 Claude 서버가 일시적으로 바쁠 때 나는 오류입니다. 이 봇은 Overloaded, 529, 503, 502 같은 일시적 서버 오류를 만나면 잠시 기다렸다가 자동으로 다시 시도합니다. 최대 5번까지 재시도합니다.

## 여러 프로젝트를 등록할 수 있나요?

네. `projects.json`에 여러 폴더를 등록할 수 있습니다. Telegram에서 `/projects`로 목록을 볼 수 있고, `/new 프로젝트이름`으로 원하는 프로젝트에서 새 작업을 시작할 수 있습니다.

## Mac이 꺼져도 봇이 작동하나요?

아니요. 이 봇은 내 Mac에서 실행됩니다. Mac이 꺼져 있거나 인터넷이 끊기거나 잠자기 상태가 되면 Telegram 메시지를 처리할 수 없습니다.

## Telegram 그룹에 다른 사람이 들어오면 어떻게 되나요?

`.env`의 `TELEGRAM_ALLOWED_USER_ID`에 적힌 사람의 메시지만 처리합니다. 그래도 보안을 위해 이 그룹은 비공개로 유지하고, 봇 토큰과 Claude 토큰은 공유하지 마세요.

## Claude가 내 파일을 마음대로 지우나요?

모드에 따라 다릅니다. `default`, `acceptEdits`, `auto`에서는 위험한 작업에 대해 승인 버튼이 나올 수 있습니다. `dontAsk`는 묻지 않고 진행할 수 있으므로 조심해서 사용하세요.

## `/plan`은 꼭 써야 하나요?

아니요. 일반 작업은 `/new`로 충분합니다. `/plan`은 큰 변경, 중요한 코드 수정, 여러 단계 검증이 필요한 작업에 적합합니다.

## Obsidian 노트도 작업할 수 있나요?

네. Obsidian vault 폴더를 `projects.json`의 `cwd`에 등록하면 됩니다. 이 프로젝트에서 “제 2의 뇌”와 관련된 프롬프트는 Obsidian을 의미합니다.

## 문제 해결

## `/status`에 답이 없어요

1. Mac이 켜져 있는지 확인합니다.
2. 터미널에서 봇을 실행 중인지 확인합니다.
3. Telegram 그룹 ID가 `.env`의 `TELEGRAM_CHAT_ID`와 같은지 확인합니다.
4. 내 user ID가 `.env`의 `TELEGRAM_ALLOWED_USER_ID`와 같은지 확인합니다.
5. BotFather 토큰이 `.env`의 `TELEGRAM_BOT_TOKEN`에 정확히 들어갔는지 확인합니다.
6. 봇이 그룹에서 관리자인지 확인합니다.

## “.env permissions must be 0600” 오류가 나요

`.env` 파일 권한이 너무 열려 있다는 뜻입니다. 아래 명령을 실행하세요.

```bash
chmod 600 .env
```

## “프로젝트 경로를 읽을 수 없음” 오류가 나요

1. `projects.json`의 `cwd`가 실제로 존재하는 폴더인지 확인합니다.
2. 경로가 `/Users/...`로 시작하는 전체 경로인지 확인합니다.
3. 폴더 이름에 오타가 없는지 확인합니다.
4. 외장 드라이브에 있는 폴더라면 드라이브가 연결되어 있는지 확인합니다.

## “Telegram이 파일 경로를 제공하지 않습니다” 오류가 나요

Telegram Bot API가 너무 큰 파일의 경로를 제공하지 못할 때 생길 수 있습니다. 더 작은 파일로 다시 보내거나, 파일을 Mac에 직접 넣고 Claude에게 경로를 알려 주세요.

## Claude 토큰 형식 오류가 나요

토큰은 `sk-ant-oat01-`로 시작해야 합니다. `claude setup-token`을 다시 실행해서 새 토큰을 만든 뒤 `.env`에 넣으세요.

```bash
claude setup-token
```

## `npm start`가 실패해요

1. 먼저 빌드를 했는지 확인합니다.

```bash
npm run build
```

2. 필요한 부품이 설치되었는지 확인합니다.

```bash
npm install
```

3. 다시 시작합니다.

```bash
npm start
```

## `/doctor`에서 Codex 인증 오류가 나요

`/plan` 기능을 쓰려면 Codex CLI가 ChatGPT 구독으로 로그인되어 있어야 합니다. 터미널에서 Codex를 실행하고 ChatGPT로 로그인하세요.

```bash
codex
```

## LaunchAgent로 실행했는데 작동하지 않아요

1. 프로젝트 폴더에서 다시 빌드합니다.

```bash
npm run build
```

2. LaunchAgent를 다시 시작합니다.

```bash
npm run launchd:restart
```

3. Telegram에서 진단을 실행합니다.

```text
/doctor
```

4. `data/stderr.log`에 최근 오류가 있는지 확인합니다.

## 보안 주의사항

1. `.env` 파일은 절대 공유하지 마세요.
2. BotFather 토큰은 비밀번호처럼 다루세요.
3. Claude OAuth 토큰도 비밀번호처럼 다루세요.
4. Telegram 그룹은 비공개로 유지하세요.
5. `dontAsk` 모드는 신뢰하는 프로젝트에서만 사용하세요.
6. 중요한 폴더에서 큰 작업을 시키기 전에는 백업을 권장합니다.

## 빠른 확인 목록

1. Homebrew 설치 완료
2. nvm 설치 완료
3. Node.js 22 설치 완료
4. 저장소 내려받기 완료
5. `npm install` 완료
6. Telegram 봇 생성 완료
7. Telegram 그룹 생성 및 Topics 활성화 완료
8. 봇을 그룹 관리자로 추가 완료
9. user ID와 chat ID 확인 완료
10. Claude 토큰 생성 완료
11. `.env` 작성 완료
12. `projects.json` 작성 완료
13. `npm run build` 완료
14. `npm start` 실행 완료
15. Telegram에서 `/status` 확인 완료
