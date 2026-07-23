# ChatKJB

[![한국어](https://img.shields.io/badge/%EC%96%B8%EC%96%B4-%ED%95%9C%EA%B5%AD%EC%96%B4-0b5fff?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/Language-English-6b7280?style=for-the-badge)](README.en.md)

> 문의는 **contact@kimjb.com** 으로 보내 주세요.

---

## 이 프로그램은 무엇인가요?

**ChatKJB는 내 컴퓨터(Mac) 안에서 일하는 AI 비서를, 휴대폰의 텔레그램(Telegram)으로 부르는 프로그램입니다.**

조금 더 쉽게 설명하면 이렇습니다.

집에 아주 똑똑한 조수가 한 명 있다고 상상해 보세요. 이 조수는 내 컴퓨터 앞에 앉아 있습니다. 파일을 읽을 줄 알고, 글을 고칠 줄 알고, 프로그램도 만들 줄 압니다. 그런데 나는 지금 밖에 있습니다. 이때 휴대폰으로 문자를 보내듯 "이것 좀 해줘"라고 말하면, 조수가 컴퓨터 앞에서 그 일을 하고 결과를 다시 문자로 알려 줍니다.

**ChatKJB가 바로 그 문자 창구입니다.**

| 이런 게 필요했다면 | ChatKJB가 해 줍니다 |
| --- | --- |
| 밖에 있는데 집 컴퓨터로 작업을 시키고 싶다 | 텔레그램으로 말만 하면 됩니다 |
| AI에게 파일을 직접 고치게 하고 싶다 | 폴더를 지정하면 그 안의 파일을 읽고 고칩니다 |
| 오래 걸리는 일을 맡겨 놓고 다른 걸 하고 싶다 | 진행 상황을 텔레그램으로 계속 알려 줍니다 |
| 여러 AI를 비교해 보고 싶다 | 4가지 AI를 골라서, 또는 동시에 쓸 수 있습니다 |

### 어떤 AI를 쓸 수 있나요?

ChatKJB는 직접 AI를 만들지 않습니다. 이미 있는 유명한 AI 4개를 **불러다 쓰는** 프로그램입니다. 리모컨 하나로 TV, 에어컨, 선풍기를 모두 켜는 것과 비슷합니다.

| AI 이름 | 만든 곳 | 잘하는 일 |
| --- | --- | --- |
| **Claude** | Anthropic | 긴 글 이해, 종합 판단, 검토, 문서 작성 |
| **Codex** | OpenAI | 코드 수정, 테스트, 빌드, Git 작업 |
| **Antigravity** | Google | 그림·소리까지 다루기, 아주 긴 글 한 번에 읽기 |
| **Grok** | xAI | 빠른 단발 작업, 다른 AI와 비교용 |

> **중요:** 이 4개 AI 중 **최소 1개**는 본인이 직접 계정을 만들고 로그인해야 합니다. ChatKJB가 AI 사용료를 대신 내주지는 않습니다.

### 준비물

| 준비물 | 설명 |
| --- | --- |
| **Mac 컴퓨터** | 현재 macOS에서만 동작합니다. 윈도우는 지원하지 않습니다. |
| **Node.js 26.4.0 이상** | 프로그램을 돌리는 엔진입니다. 아래 설치 안내에 나옵니다. |
| **텔레그램 계정** | 무료입니다. |
| **AI 계정 1개 이상** | 위 표의 4개 중 아무거나. |
| **작업할 폴더** | AI가 만질 파일이 들어 있는 폴더입니다. |

---

## 목차

이 문서는 네 부분으로 나뉩니다. **컴퓨터를 잘 모르는 분은 1부만 읽으셔도 됩니다.**

| 부 | 누구를 위한 것인가 | 무엇이 적혀 있나 |
| --- | --- | --- |
| [1부](#1부-텔레그램에서-사용하기) | **쓰는 사람** | 텔레그램에서 실제로 어떻게 시키는지 |
| [2부](#2부-내-mac에-설치하기) | **설치하는 사람** | 내 Mac에 깔고 자동으로 켜지게 하는 법 |
| [3부](#3부-개발자-안내) | **고치는 사람** | 프로그램 구조와 기능 추가 위치 |
| [4부](#4부-문제-해결) | **막힌 사람** | 안 될 때 확인할 것들 |

---

# 1부. 텔레그램에서 사용하기

## 전체 흐름 먼저 보기

ChatKJB는 이런 순서로 움직입니다.

```text
1. 내가 텔레그램에 "/new" 라고 보낸다
        ↓
2. ChatKJB가 새 대화방(topic)을 하나 만들어 준다
        ↓
3. 그 방에 "이런 일 해줘" 라고 평소 말하듯 쓴다
        ↓
4. ChatKJB가 "어느 폴더에서 하는 일이지?" 를 스스로 판단한다
        ↓
5. AI가 그 폴더에서 실제로 일을 시작한다
        ↓
6. 진행 상황이 그 방에 계속 올라온다
        ↓
7. 위험한 작업은 "해도 될까요?" 버튼으로 물어본다
        ↓
8. 다 끝나면 결과를 알려 준다. 같은 방에 또 시키면 이어서 한다
```

## 꼭 알아야 할 5개 단어

프로그램을 쓰다 보면 계속 나오는 단어들입니다. 이것만 알면 됩니다.

| 단어 | 쉬운 설명 |
| --- | --- |
| **프로젝트** | AI가 일할 **폴더**입니다. "내 논문 폴더", "회사 일 폴더"처럼 생각하면 됩니다. |
| **topic (토픽)** | 텔레그램 단톡방 안의 **작은 주제 방**입니다. 카카오톡에는 없는 기능인데, 큰 방 안에 작은 방을 여러 개 만드는 것입니다. 보통 **일 하나 = 방 하나**입니다. |
| **세션** | 한 방 안에서 이어지는 **대화 한 묶음**입니다. AI가 앞에서 한 말을 기억합니다. |
| **제공자 (provider)** | 실제로 일하는 **AI 이름**입니다. Claude, Codex, Antigravity, Grok 중 하나입니다. |
| **권한 모드** | AI가 **얼마나 마음대로 해도 되는지** 정하는 설정입니다. "물어보고 해" ↔ "알아서 다 해" 사이를 고릅니다. |

## 처음 한 번 해보기

텔레그램 앱을 열고 그대로 따라 해 보세요.

**1단계.** ChatKJB가 들어 있는 텔레그램 그룹을 엽니다.

**2단계.** 이렇게 딱 한 글자만 보냅니다.

```text
/new
```

**3단계.** 새 방이 하나 생깁니다. 그 방에 들어가서 하고 싶은 일을 **문장으로** 씁니다. 짧게 쓰지 말고 자세히 쓸수록 좋습니다.

```text
내 블로그 폴더에 있는 글 중에서 맞춤법이 틀린 곳을 찾아서 고쳐줘.
고친 곳은 목록으로 정리해서 알려줘.
```

**4단계.** ChatKJB가 알아서 폴더를 고르고, 방 이름을 바꾸고, 일을 시작합니다.

**5단계.** 중간에 이런 버튼이 뜨면 내용을 읽어 보고 누릅니다.

```text
이 파일을 수정해도 될까요?
[ 허용 ]  [ 거부 ]
```

**6단계.** 끝나면 결과가 올라옵니다. 같은 방에 또 말을 걸면 이어서 일합니다.

## 이런 일을 시킬 수 있습니다

| 하고 싶은 일 | 이렇게 말하면 됩니다 |
| --- | --- |
| 코드 고치기 | `로그인이 안 되는 이유를 찾아서 고치고 테스트까지 돌려줘` |
| 문서 쓰기 | `README를 처음 보는 사람도 알 수 있게 다시 써줘` |
| 검사하기 | `수정한 다음에 타입체크랑 테스트가 통과하는지 확인해줘` |
| 파일 분석 | `방금 올린 PDF를 읽고 핵심 주장을 표로 정리해줘` |
| AI 고르기 | `/route 이 작업은 어느 AI가 잘할까?` |
| 여러 AI 비교 | `/synth 이 설계에서 위험한 부분을 찾아줘` |
| 옛날 기록 찾기 | `/query 예전에 정한 규칙이 뭐였지?` |
| 지금 상태 보기 | `/status` |

## 명령어 사전

텔레그램에서 `/` 로 시작하는 것이 명령어입니다. 외울 필요는 없고, 필요할 때 여기서 찾아보면 됩니다.

### 가장 많이 쓰는 것

| 명령 | 무엇을 하나 |
| --- | --- |
| `/start` | 도움말을 봅니다. **막히면 일단 이것부터** 쳐 보세요. |
| `/new` | 새 일을 시작할 방을 엽니다. **가장 많이 씁니다.** |
| `/new <프로젝트이름>` | 폴더를 직접 정해서 새 방을 엽니다. |
| `/new browse` | 컴퓨터의 폴더 목록을 눈으로 보면서 고릅니다. |
| `/status` | 지금 무슨 일이 돌아가고 있는지 한눈에 봅니다. |
| `/stop` | 지금 하는 일을 **멈춥니다**. |
| `/doctor` | 어디가 고장 났는지 전체 검사합니다. |
| `/usage` | AI를 얼마나 썼는지, 한도가 얼마나 남았는지 봅니다. |
| `/sessions` | 최근에 한 일 목록을 봅니다. |
| `/delete` | 이 방과 기록을 지웁니다. |
| `/reset` | 방은 두고 **대화 기억만** 지웁니다. |

### 일을 조종하는 것

| 명령 | 무엇을 하나 |
| --- | --- |
| `/steer <지시>` | 일하는 **도중에** 방향을 바꿉니다. "아니 그거 말고 이렇게 해" |
| `/next <지시>` | 지금 일이 끝나면 **그 다음에** 할 일을 예약합니다. |
| `/shotgun [설명]` | AI가 뭔가 빠뜨렸을 때 **처음부터 다시 검토**하게 합니다. |
| `/resume` | 컴퓨터가 꺼졌다 켜지는 등으로 멈춘 일을 **다시 이어서** 합니다. |
| `/fork` | 지금 대화를 **복사해서** 다른 방향으로 시험해 봅니다. |
| `/compact` | 대화가 너무 길어졌을 때 **요약해서** 줄입니다. |
| `/diff` | 파일이 어떻게 바뀌었는지 **변경 내역**을 봅니다. |
| `/upload <파일경로>` | 컴퓨터 안의 결과 파일을 **텔레그램으로 받습니다**. |
| `/memory <내용>` | 오래 기억해야 할 사실을 저장하라고 시킵니다. |

### 예약해서 나중에 시키기

| 명령 | 무엇을 하나 |
| --- | --- |
| `/reserve` | 나중에 할 일을 예약합니다. |
| `/reserve <프로젝트> <시간> <할일>` | 예: `/reserve 블로그 내일 오전 9시 맞춤법 검사해줘` |
| `/reserve browse` | 폴더를 눈으로 고르면서 예약합니다. |
| `/cancel` | 예약한 일을 취소합니다. |
| `/restop` | 한도가 풀리면 자동으로 다시 시작하는 예약만 취소합니다. |

### AI와 성능을 바꾸는 것

| 명령 | 무엇을 하나 |
| --- | --- |
| `/provider` | 지금 방에서 일하는 **AI를 바꿉니다**. 바꿔도 앞의 대화 요약을 넘겨줍니다. |
| `/firstp` | **앞으로 새로 여는 방**의 기본 AI를 정합니다. |
| `/model` | 같은 AI 안에서 **모델**을 바꿉니다. (같은 회사의 상위/하위 제품) |
| `/power` 또는 `/effort` | AI가 **얼마나 깊게 생각할지** 정합니다. 깊게 할수록 느리고 비쌉니다. |
| `/thinking` | Claude의 깊은 생각 기능을 켜고 끕니다. |
| `/mode` | **권한 모드**를 바꿉니다. (아래 표 참고) |
| `/lean on` / `/lean off` | **꼭 필요한 것만** 만들게 하거나, 해제합니다. |
| `/tokenid <번호>` | Codex 계정이 여러 개일 때 몇 번 계정을 쓸지 고릅니다. |

**권한 모드 5가지** — AI를 얼마나 믿을지 정하는 설정입니다.

| 모드 | 뜻 | 언제 쓰나 |
| --- | --- | --- |
| `auto` | **기본값.** 보통 일은 그냥 하고, 위험한 일만 물어봅니다. | 평소 |
| `default` | 좀 더 자주 물어봅니다. | 조심스러울 때 |
| `acceptEdits` | 파일 고치는 건 안 물어보고 합니다. | 파일 수정이 많을 때 |
| `plan` | **읽기만** 하고 아무것도 안 고칩니다. | 계획만 짜게 할 때 |
| `dontAsk` | 거의 다 알아서 합니다. | **믿는 작업에만** 쓰세요 |

### 여러 AI를 함께 쓰는 것

| 명령 | 무엇을 하나 | 주의할 점 |
| --- | --- | --- |
| `/route <작업>` | 어느 AI가 이 일을 잘할지 **추천만** 해 줍니다. | 추천만 하고 실행은 안 합니다. |
| `/synth <작업>` | 4개 AI에게 **다 물어본 다음**, 서로 비판하게 하고, 점수를 매겨 하나로 합칩니다. | **시간과 비용이 많이 듭니다.** |
| `/query <질문>` | 예전에 쌓아둔 기록(LLM-Wiki)에서 답을 찾습니다. | 일이 없을 때 쓰는 게 좋습니다. |
| `/compile [소스]` | 쌓인 기록을 정리해서 정식 기록으로 만듭니다. | 한 번에 하나만 돌아갑니다. |

### 요구사항을 꼼꼼히 정리하는 3단 워크플로

큰 일을 시킬 때, 바로 시키지 않고 **차근차근 정리한 뒤** 시작하는 방법입니다.

| 명령 | 무엇을 하나 |
| --- | --- |
| `/deepinterview <요청>` | AI가 **한 번에 하나씩 질문**하며 뭘 원하는지 명확하게 만듭니다. |
| `/ralplan <작업 또는 위 결과>` | 계획을 짜고, 다른 AI가 그 계획을 **비판·검토**합니다. |
| `/ultragoal <승인된 계획>` | 이제 실제로 **구현하고 검증**합니다. |

권장 순서:

```text
/deepinterview 애매한 요청
    ↓ (요구사항 정리됨, 내가 승인)
/ralplan 정리된 요구사항
    ↓ (계획 검토됨, 내가 승인)
/ultragoal 승인된 계획
    ↓
실제 작업 + 증거 기록
```

- **Deep Interview**는 물어보기만 하고 파일을 안 고칩니다.
- **Ralplan**은 계획만 짜고, 승인 전에는 실행하지 않습니다.
- **Ultragoal**은 승인된 범위만 실행하고, 증거가 다 갖춰져야 "끝"으로 칩니다.

> 이 세 명령은 [Gajae-Code](https://github.com/Yeachan-Heo/gajae-code)의 워크플로를 ChatKJB에 맞게 옮긴 것입니다. `/shotgun`은 [fivetaku/shotgun](https://github.com/fivetaku/shotgun)의 재검토 흐름을 옮긴 것입니다.

### 목표를 정해두는 것

| 명령 | 무엇을 하나 |
| --- | --- |
| `/goal <조건>` | "이 조건이 만족될 때까지 해줘"라고 목표를 겁니다. |
| `/goal clear` | 목표를 해제합니다. |

예시:

```text
/goal 모든 테스트가 통과하고 README가 최신 내용을 반영한다
```

> `/goal`은 **Claude와 Codex에서만** 됩니다. Antigravity와 Grok에는 같은 기능이 없습니다.

## 상태를 읽는 법

### 라이브 작업 콕핏 (실행 중 상태 메시지)

작업이 돌아가는 동안 텔레그램·Terminal 앱 모두에서 **같은 구조의 상태 메시지**가 제자리 갱신됩니다. 네 칸은 항상 같은 순서로 보입니다.

| 칸 | 내용 |
| --- | --- |
| ① 현재 단계·행동 | 지금 무엇을 하는지 (도구·하위 작업·응답 작성 등) |
| ② 대기 사유 | 승인 / 한도 / 서브에이전트 / 도구 대기, 또는 대기 아님 |
| ③ 지금까지 한 일 | 도구·파일·명령·조향 결정의 누적 ledger |
| ④ 남은 계획·진행률 | 체크리스트·진행률. **정확한 시간 ETA는 제공하지 않습니다.** |

제공자(Claude·Codex·Antigravity·Grok·Cline)마다 노출 정보가 다르면 빈칸 대신 **명시적 제한 표기(degrade)** 로 채웁니다. 롤백이 필요하면 `CHATKJB_COCKPIT_V2=0`으로 이전 레이아웃을 씁니다.

`/steer`로 라이브 지시를 내면 ledger에 조향 사실이 기록됩니다. Claude는 중단 없이 주입, Codex는 현재 턴 재시작, 그 외 제공자는 큐 주입(+ 라이브 제한 표기)입니다. 승인 대기 중에는 토픽에서 허용/거절하면 대기 사유 칸이 바로 갱신됩니다.

### `/status` — 지금 뭐가 돌아가나

`/status`는 **어디서 치느냐**에 따라 다르게 나옵니다.

| 어디서 쳤나 | 무엇이 나오나 |
| --- | --- |
| 작업 방 안에서 | 그 작업 하나의 상세 상태 |
| 큰 방(General)에서 | **전체 작업판.** 돌아가는 일, 기다리는 일, 승인 대기 중인 일이 카드로 쭉 나옵니다. |

작업판 카드에는 이런 게 담깁니다.

- 어느 폴더에서 무슨 일을 하는지
- 어떤 AI, 어떤 모델을 쓰는지
- 지금 몇 분째 하고 있는지
- 왜 기다리고 있는지
- 다음에 뭘 해야 하는지
- 그 방으로 바로 가는 링크

### `/usage` — 얼마나 썼나

AI는 무한정 쓸 수 없고 한도가 있습니다. `/usage`가 남은 양을 보여 줍니다.

| 어디서 쳤나 | 무엇이 나오나 |
| --- | --- |
| 큰 방에서 | 4개 AI 전부의 사용량 |
| 특정 작업 방에서 | 그 방에서 쓴 양 위주 |
| 조회 실패 시 | 마지막으로 저장된 값 + 실패한 이유 |

### `/doctor` — 어디가 고장 났나

문제가 생기면 이것부터 쳐 보세요. 이런 걸 한 번에 검사합니다.

- AI 로그인이 살아 있는지
- 각 AI 프로그램이 설치되어 있고 버전이 맞는지
- 자동 실행 등록이 되어 있는지
- 데이터베이스에 쓸 수 있는지
- 텔레그램 연결이 되는지
- 디스크 공간이 남아 있는지
- 최근 오류 기록이 있는지

## 파일 주고받기

### 파일 보내기 (나 → AI)

작업 방에 파일을 그냥 **끌어다 놓거나 첨부**하면 됩니다. ChatKJB가 컴퓨터에 저장하고 그 위치를 AI에게 알려 줍니다.

보낼 수 있는 것: 문서, 사진, 오디오·음성, 동영상, GIF, 스티커

PDF는 별도 도구로 **글자만 뽑아내거나 그림만 뽑아낼** 수 있습니다.

### 파일 받기 (AI → 나)

```text
/upload output/report.pdf
```

경로는 지금 작업 중인 폴더 기준입니다. 전체 경로를 써도 됩니다.

## 프로젝트(폴더)는 어떻게 정해지나

### 자동으로 고르기

`/new` 뒤에 아무것도 안 쓰면, ChatKJB가 **내가 쓴 문장을 읽고** 어느 폴더 이야기인지 스스로 판단합니다.

이때 폴더를 고르는 AI는 **아무것도 건드릴 수 없게 완전히 잠긴 상태**로 돌아갑니다. 파일 수정도, 인터넷 접속도 못 합니다. 오직 "이 일은 이 폴더 것 같다"라고 고르기만 합니다. 그리고 ChatKJB가 그 결과를 **다시 한 번 검증한 뒤에만** 실제로 시작합니다.

고르기에 실패해도 방을 지우지 않으니, 문장을 바꿔서 다시 시도하면 됩니다.

### 직접 고르기

```text
/new browse
```

이러면 지금 Mac에서 접근 가능한 **드라이브 목록**이 버튼으로 나옵니다. 눌러서 폴더를 하나씩 들어가고, `이 폴더 선택`을 누르면 됩니다.

미리 등록하지 않은 폴더도 바로 쓸 수 있습니다.

> **개인정보 보호:** 드라이브 이름에 계정명이나 이메일이 섞여 있으면(예: `GoogleDrive-user@example.com`) 텔레그램 화면에는 `GoogleDrive`처럼 **정리해서** 표시합니다. 폴더를 돌아다닐 때도 전체 경로는 화면에 안 나옵니다.

### 폴더 목록은 언제 갱신되나

- 프로그램 시작할 때
- 30분마다
- 작업이 끝날 때마다
- 자동 선택 직전 (새로 연결한 외장 디스크·클라우드도 바로 잡힙니다)
- `/catbot` 을 치면 즉시

목록에는 **폴더 이름·위치·짧은 설명**만 저장합니다. 파일 내용이나 `.env` 같은 비밀 파일은 절대 수집하지 않습니다.

## AI 프로그램의 원래 명령어도 쓸 수 있습니다

ChatKJB가 안 쓰는 `/명령어`를 방에 보내면, 지금 쓰는 AI가 원래 아는 명령이면 **그대로 전달**합니다. 예를 들어 Claude 방에서 `/init`, `/review`, `/mcp`, `/help` 같은 Claude 원래 명령을 쓸 수 있습니다.

모르는 명령은 조용히 무시하지 않고 안내 메시지를 보냅니다. 이름이 겹치면 ChatKJB 명령이 우선입니다.

## 여러 AI가 동시에 일하는 방식 (서브에이전트)

큰 일은 혼자 하는 것보다 나눠서 하는 게 빠릅니다. ChatKJB는 조사·검토·테스트처럼 **서로 상관없는 일**을 최대 **3개까지 동시에** 다른 AI 일꾼(서브에이전트)에게 맡깁니다.

몇 가지 원칙이 있습니다.

- "동시에 3명"이지, "총 3번만"이 아닙니다. 한 명이 끝나면 자리가 비고, 다음 일꾼을 투입합니다.
- **파일을 고치는 일은 동시에 하지 않습니다.** 서로 부딪히면 파일이 깨지기 때문입니다. 담당 파일이 완전히 나뉠 때만 허용합니다.
- 일꾼이 또 다른 일꾼을 만드는 것(재귀)은 **금지**입니다. 무한정 늘어나는 것을 막기 위해서입니다.
- 결과를 모으고 최종 확인하는 책임은 **주 AI**가 집니다.

| AI | 쓰는 기능 |
| --- | --- |
| Claude | Task/Agent |
| Codex | `collaboration.spawn_agent` (자식 3개, 깊이 1로 제한) |
| Antigravity | 내장 백그라운드 서브에이전트 |
| Grok | 내장 서브에이전트 |

## AI가 나에게 선택지를 물어볼 때

작업 중 AI가 "A로 할까요, B로 할까요?" 하고 물어야 할 때가 있습니다. 이때 텔레그램에 **누를 수 있는 버튼**이 뜹니다.

- 한 번에 질문 묶음 1개
- 묶음당 질문 1~3개
- 질문당 선택지 2~4개
- 직접 입력도 가능

> **주의:** 질문 대기 상태는 프로그램 메모리에만 있습니다. 답을 안 한 채로 프로그램이 재시작되면 그 질문은 사라집니다.

## 오래된 기록을 찾는 법 (`/query`와 `/compile`)

ChatKJB는 대화를 무작정 쌓아두지 않습니다. **LLM-Wiki**라는 별도 기록 창고를 씁니다.

```text
10-inbox/     ← 끝난 대화가 여기 쌓임 (원재료)
    ↓  /compile  (정리하기)
30-wiki/      ← 정리된 정식 기록 (정본)
    ↓  /query   (찾아보기)
답변
```

**`/query <질문>`** — 정식 기록만 근거로 답합니다. 기록에 없으면 **지어내지 않고** "위키에 없음"이라고 솔직하게 답하는 것이 원칙입니다.

**`/compile [소스]`** — 쌓인 원재료를 정식 기록으로 승격시킵니다.

- 기본은 `10-inbox/`의 정리 안 된 것 전부
- 제한 시간 45분
- **한 번에 하나만** 돌아갑니다 (실행 중이면 다른 요청은 거절)
- 새 방을 만들지 않고, 큰 방에 시작·완료·오류만 알립니다
- 고른 AI가 실패해도 다른 AI로 자동 대체하지 않습니다

## 안전장치

개인 작업을 자동으로 처리하는 도구이므로, 다음 안전장치가 들어 있습니다.

| 안전장치 | 설명 |
| --- | --- |
| **사용자 확인** | 설정에 등록한 텔레그램 사용자와 그룹의 메시지만 처리합니다. 다른 사람이 봇을 찾아내도 **아무 반응도 하지 않습니다.** |
| **폴더 제한** | 등록된 폴더를 중심으로만 일합니다. |
| **승인 요청** | 위험하거나 확실하지 않은 작업은 버튼으로 물어봅니다. |
| **비밀값 가리기** | 토큰·API 키·비밀번호처럼 보이는 값은 화면과 기록에서 `[REDACTED]`로 가립니다. |
| **비밀 파일 제외** | `.env`, `projects.json`, `data/` 같은 파일은 Git에 절대 올라가지 않습니다. |
| **중단 가능** | `/stop`, `/delete`, `/reset`으로 언제든 멈추고 지울 수 있습니다. |

---

# 2부. 내 Mac에 설치하기

여기에는 서로 다른 두 설치물이 있습니다. 필요한 것부터 고르세요.

| 설치 경로 | 들어 있는 것 | 언제 고르나 |
| --- | --- | --- |
| **릴리스 DMG** | `ChatKJB Terminal.app` 데스크톱 보기 앱 | 이미 실행 중인 ChatKJB 봇의 방을 Mac 앱으로 보고 싶을 때 |
| **소스 설치** | 텔레그램 봇 서비스·AI CLI 연동·LaunchAgent | 자신의 봇과 AI 계정으로 ChatKJB를 실행하거나 개발할 때 |

`ChatKJB Terminal`은 봇 서비스가 아닙니다. DMG만 설치해도 화면은 쓸 수 있지만, ChatKJB 답변을 받으려면 아래 소스 설치 또는 다른 Mac에서 **별도로 실행 중인 봇 서비스**가 있어야 합니다.

## A. 릴리스 DMG로 ChatKJB Terminal 설치하기

릴리스 DMG는 Apple Silicon과 macOS 14 이상에서 검증된 `ChatKJB Terminal.app` 하나를 제공합니다. 저장소와 Node.js는 이 앱을 실행하는 Mac에 설치할 필요가 없습니다.

### 설치와 첫 실행

1. 받은 `ChatKJB Terminal.dmg`를 Finder에서 엽니다.
2. `ChatKJB Terminal.app`을 DMG 안의 `Applications` 별칭으로 끌어 놓습니다.
3. DMG를 꺼낸 뒤 `/Applications/ChatKJB Terminal.app`을 엽니다. 처음 실행이 차단되면 **시스템 설정 → 개인정보 보호 및 보안**에서 열기를 한 번 허용합니다.
4. 앱에 Telegram API ID, 32자리 API Hash, 방 chat ID, 허용 사용자 ID를 넣고, 휴대폰 Telegram의 **설정 → 기기 → 데스크톱 기기 연결**에서 QR 코드를 스캔합니다. 2단계 인증을 쓴다면 QR 승인 뒤 비밀번호도 한 번 입력합니다.

이 앱은 봇 토큰이 아닌 Telegram 사용자 계정의 API ID/API Hash를 쓰며, 앱 전용 세션을 만듭니다. 자세한 동작과 로그아웃 차이는 [ChatKJB Terminal 데스크톱 앱](#선택-chatkjb-terminal-데스크톱-앱) 절을 보세요.

### DMG 업데이트, 백업, 복구

업데이트 전에는 앱을 `⌘Q`로 완전히 종료하세요. 새 DMG를 열어 새 `ChatKJB Terminal.app`을 `/Applications`로 끌어 놓고 **대치**를 선택한 뒤 다시 엽니다. 설정과 Telegram 세션은 앱 번들 밖의 `~/Library/Application Support/ChatKJB Terminal`에 있으므로, 앱을 대치해도 그대로 남습니다.

처음 실행을 마친 뒤, 업데이트·설정 변경 전에 해당 폴더를 한 번 백업할 수 있습니다.

```bash
backup="$HOME/Desktop/ChatKJB-Terminal-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
ditto "$HOME/Library/Application Support/ChatKJB Terminal" "$backup/ChatKJB Terminal"
```

이 백업에는 앱 설정 `.env`와 `data/telegram-gui.session`이 들어 있습니다. 업데이트 뒤 문제가 생기면 앱을 종료하고, 보관해 둔 이전 DMG의 앱으로 `/Applications/ChatKJB Terminal.app`을 대치하면 앱 버전을 되돌릴 수 있습니다. 설정까지 되돌릴 때는 Finder에서 백업한 `ChatKJB Terminal` 폴더를 `~/Library/Application Support`로 복원한 뒤 앱을 다시 여세요. 복원할 백업을 확인하기 전에는 현재 폴더를 지우지 마세요.

### DMG 수령자용 라이선스 안내

프로젝트는 [MIT LICENSE](LICENSE)로 제공됩니다. 번들에 실제 포함된 Node.js와 npm 의존성의 라이선스·버전·SHA-256 추적 정보는 앱 안의 다음 경로에 있습니다.

```text
/Applications/ChatKJB Terminal.app/Contents/Resources/Licenses/manifest.json
/Applications/ChatKJB Terminal.app/Contents/Resources/Licenses/Node/LICENSE
/Applications/ChatKJB Terminal.app/Contents/Resources/Licenses/Packages/
```

Finder에서 확인하려면 다음 명령을 쓸 수 있습니다.

```bash
open "/Applications/ChatKJB Terminal.app/Contents/Resources/Licenses"
```

수령자에게 전달할 최소 고지와 현재 DMG 포함 상태는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 정리되어 있습니다.

## B. 소스로 봇 서비스 설치하기

ChatKJB는 서버에 올려 여러 사람에게 서비스하는 프로그램이 **아닙니다.** 저장소를 내려받아 **내 Mac에서, 내 봇으로, 내 AI 계정으로** 돌리는 개인용 도구입니다.

## 아주 빠른 소스 설치 (요약)

이미 개발 환경이 익숙한 분은 이것만 보셔도 됩니다.

```bash
git clone https://github.com/<owner>/ChatKJB
cd ChatKJB
nvm use              # Node 26.4.0 이상
npm install
npm run setup        # .env · projects.json · data/ 준비
# .env 를 본인 값으로 편집

# 쓸 AI만 로그인 (최소 1개)
npm run auth:setup   # Claude
codex login          # Codex
# Antigravity / Grok 은 각 CLI에서 1회 로그인

npm run build
npm start
# 또는 자동 실행 등록:
npm run launchd:install
```

끝나면 텔레그램에서 `/doctor` 로 확인합니다.

---

아래는 **처음부터 하나씩** 따라 하는 설명입니다.

## 1단계. Node.js 준비하기

Node.js는 이 프로그램을 돌리는 **엔진**입니다. 자동차에 엔진이 필요한 것과 같습니다.

터미널(Terminal 앱)을 열고 확인합니다.

```bash
node -v
```

`v26.4.0` 보다 **높은** 숫자가 나와야 합니다. 안 나오거나 낮으면 Node.js를 설치하거나 올려야 합니다.

> **왜 버전이 중요한가요?** 이 프로그램은 `better-sqlite3`처럼 컴퓨터에 딱 맞춰 만들어지는 부품을 씁니다. 설치할 때의 Node 버전과 실행할 때의 Node 버전이 다르면 부품이 안 맞아서 오류가 납니다. **설치와 실행을 같은 Node로** 하세요.

## 2단계. 저장소 받기

```bash
git clone https://github.com/<owner>/ChatKJB
cd ChatKJB
nvm use
npm install
npm run setup
```

`npm run setup`이 `.env`, `projects.json`, `data/` 폴더를 자동으로 준비합니다. **이미 파일이 있으면 덮어쓰지 않고 그대로 둡니다.**

## 3단계. 텔레그램 봇 만들기

봇은 내가 직접 만들어야 합니다. 무료이고 5분이면 됩니다.

**3-1. 봇 만들기**

1. 텔레그램에서 `@BotFather` 를 검색해서 엽니다. (텔레그램 공식 봇입니다)
2. `/newbot` 을 보냅니다.
3. 봇 이름을 정하라고 하면 원하는 이름을 씁니다.
4. **토큰**을 줍니다. `123456:ABC-DEF...` 같이 생겼습니다. **이건 비밀번호와 같습니다. 절대 남에게 보여주지 마세요.**

**3-2. 그룹 만들기**

1. 텔레그램에서 새 **그룹**을 만듭니다. (나 혼자만 있어도 됩니다)
2. 그룹을 **supergroup**으로 만들고 설정에서 **Topics** 기능을 켭니다.
   - Topics는 큰 방 안에 작은 방을 여러 개 만드는 기능입니다. **이게 켜져 있어야 ChatKJB가 동작합니다.**
3. 만든 봇을 그룹에 **초대**합니다.
4. 봇을 **관리자**로 지정합니다.
5. 봇에게 `Manage Topics`(토픽 관리)와 `Delete Messages`(메시지 삭제) 권한을 줍니다.

**3-3. 내 ID와 그룹 ID 알아내기**

내 텔레그램 사용자 ID(숫자)와 그룹 chat ID(음수 숫자)를 확인해 둡니다. ChatKJB는 **이 두 개가 모두 맞는 메시지만** 처리합니다.

## 4단계. `.env` 파일 채우기

`.env`는 비밀 설정을 모아 두는 파일입니다.

```bash
cp .env.example .env
chmod 600 .env
```

> **`chmod 600`은 반드시 해야 합니다.** 이건 "나 말고 아무도 이 파일을 못 읽게" 만드는 명령입니다. 권한이 다르면 프로그램이 **일부러 시작을 거부합니다.** 비밀이 새는 것을 막기 위한 안전장치입니다.

**최소한 이 3개**는 채워야 합니다.

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_CHAT_ID=-1001234567890
```

여러 사람을 허용하려면 쉼표로 나열합니다.

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

`TELEGRAM_ALLOWED_USER_ID` 하나만 써도 되고, `TELEGRAM_ALLOWED_USER_IDS`만 써도 되고, 둘 다 쓰면 합쳐집니다.

**시간대**는 컴퓨터 설정을 그대로 따릅니다. 다른 시간대로 고정할 때만 `TZ`에 IANA 시간대 이름을 넣습니다.

**AI 프로그램을 못 찾을 때**만 경로를 직접 알려 줍니다.

```dotenv
CLAUDE_CODE_EXECUTABLE=~/.local/bin/claude
CODEX_EXECUTABLE=/opt/homebrew/bin/codex
AGY_EXECUTABLE=~/.local/bin/agy
GROK_EXECUTABLE=~/.local/bin/grok
```

### 선택: 텔레그램 앱에서 방을 지우면 같이 지워지게 하기

기본 상태에서는 텔레그램 앱에서 방을 직접 지워도 컴퓨터 쪽 기록은 남습니다. 같이 지워지게 하려면 [my.telegram.org/apps](https://my.telegram.org/apps)에서 API ID와 API Hash를 발급받아 넣습니다.

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
# 선택: 기본값 ./data/telegram-mtproto.session
TELEGRAM_MTPROTO_SESSION_PATH=./data/telegram-mtproto.session
```

> **API Hash와 session 파일은 봇 토큰과 똑같이 중요한 비밀입니다.** session 파일은 처음 인증할 때 자동으로 만들어지고 권한 `0600`이 강제되며, `data/` 폴더째로 Git에서 제외됩니다.
>
> 설정하지 않으면 이 기능만 꺼지고 나머지는 정상 동작합니다. 그때는 `/delete`로 지우면 됩니다.

## 5단계. AI 로그인하기 (최소 1개)

### Claude

```bash
npm run auth:setup
```

계정이 여러 개면 `.env`에 추가할 수 있습니다. 한도에 걸리면 다음 세션부터 다른 계정으로 넘어갑니다.

```dotenv
CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-replace-me
CLAUDE_CODE_OAUTH_TOKEN_3=sk-ant-oat01-replace-me
```

### Codex

Codex는 ChatGPT 계정으로 로그인합니다.

```bash
codex login
```

계정이 여러 개일 때는 계정마다 별도 폴더에 로그인합니다.

```bash
CODEX_HOME=~/.codex codex login
CODEX_HOME=~/.codex-acct-b codex login
```

그리고 `.env`에 등록합니다.

```dotenv
CODEX_ACCOUNT_HOMES=~/.codex,~/.codex-acct-b
```

각 폴더에 `auth.json`이 있어야 하고, **ChatGPT 로그인 방식**(`auth_mode=chatgpt`)만 허용됩니다.

### Antigravity

`agy` CLI에서 **최초 1회** 구독 계정으로 로그인합니다.

```dotenv
AGY_EXECUTABLE=~/.local/bin/agy
```

Google One AI Premium 할당량을 쓰는 환경이면 `~/.gemini/antigravity-cli/settings.json`에서 `useG1Credits`도 켜 주세요.

agy에 연결할 확장 도구(MCP)는 이름만 적어서 제한할 수 있습니다. 도구 설치와 인증은 각자 환경에서 합니다.

```dotenv
AGY_MCP_SERVERS=llm-wiki,obsidian,outlook,peekaboo,playwright,price-feed,literature-evidence,scihub
```

### Grok

```dotenv
GROK_EXECUTABLE=~/.local/bin/grok
GROK_MODEL=grok-4.5
```

Grok은 글자를 조각조각 보내는데, ChatKJB가 이를 **합쳐서** 완결된 문장 단위로 하나씩 텔레그램에 올립니다. AI의 내부 생각(`thought`)이나 원시 로그는 전달하지 않습니다.

## 6단계. 작업할 폴더 등록하기 (선택)

`projects.json`은 자주 쓰는 폴더 목록입니다. **비워 둬도 됩니다.** `/new`의 자동 선택이나 `/new browse`의 직접 선택으로 충분합니다.

고정 등록하려면:

```bash
cp projects.example.json projects.json
```

```json
[
  {
    "name": "내 블로그",
    "cwd": "~/work/blog",
    "defaultMode": "auto"
  }
]
```

| 항목 | 설명 |
| --- | --- |
| `name` | 텔레그램에 보일 이름입니다. |
| `aliases` | (선택) 다른 이름으로도 찾을 수 있게 합니다. |
| `cwd` | 진짜 폴더 위치입니다. 전체 경로, `~/...`, SMB 주소를 지원합니다. |
| `defaultMode` | 기본 권한 모드입니다. `auto`, `default`, `acceptEdits`, `plan`, `dontAsk` 중 하나. |

> **이 파일에는 내 컴퓨터의 실제 경로가 들어갑니다. Git에 올리지 마세요.** (기본 설정으로 이미 제외되어 있습니다)

시작할 때 접근할 수 없는 폴더는 건너뜁니다. 외장 디스크를 다시 연결하고 재시작하면 다시 잡힙니다.

## 7단계. 실행하기

개발하면서 쓸 때 (코드를 고치면 자동 반영):

```bash
npm run dev
```

정식으로 쓸 때:

```bash
npm run build
npm start
```

잘 되면 텔레그램에서 `/start`, `/doctor`, `/new` 를 보내 확인합니다.

## 8단계. Mac 켤 때 자동으로 시작되게 하기

매번 터미널을 여는 게 번거로우면 자동 실행을 등록합니다.

```bash
npm run launchd:install
```

| 무엇 | 어디에 있나 |
| --- | --- |
| 실행 파일 | `<저장소>/dist/index.js` |
| 실행 주체 | `~/Library/Application Support/ChatKJB/ChatKJB.app` |
| 설정 | `<저장소>/.env`, `projects.json` |
| 데이터베이스 | `<저장소>/data/state.sqlite` |
| 등록 정보 | `~/Library/LaunchAgents/com.chatkjb.bot.plist` |
| 기록(로그) | `~/Library/Logs/com.chatkjb.bot/stdout.log`, `stderr.log` |

> **중요:** `launchd:install`을 실행한 그 순간의 Node 위치가 등록 정보에 **그대로 박힙니다.** Node를 바꿨다면 원하는 Node로 맞춘 상태에서 `npm install` → `npm run build` → `npm run launchd:install`을 **다시** 하세요.

### 권한 화면에 ChatKJB로 표시되게 하기

봇을 Node로 그냥 실행하면 macOS **시스템 설정 → 개인정보 보호 및 보안** 화면에 프로세스가 `node`라고만 뜹니다. 내 컴퓨터에는 Node를 쓰는 프로그램이 여러 개일 수 있어서, 그중 어느 것에 전체 디스크 접근 같은 권한을 주는 것인지 구분할 수 없습니다.

그래서 `npm run launchd:install`은 설치할 때 **`ChatKJB.app`이라는 작은 앱 껍데기**를 함께 만듭니다.

```text
~/Library/Application Support/ChatKJB/ChatKJB.app
```

이 앱 안에 들어 있는 실행 파일은 **Node 그 자체를 복사한 것**입니다. 하는 일은 완전히 같고, macOS에 보이는 **이름과 아이콘만** ChatKJB로 바뀝니다. 아이콘은 ChatKJB Terminal 앱과 같은 것을 씁니다. 백그라운드 데몬이므로 Dock에는 나타나지 않습니다.

이제 권한 대화상자에 `node` 대신 **ChatKJB**가 아이콘과 함께 표시되므로, 안심하고 권한을 줄 수 있습니다.

> **권한이 풀리지 않게 하는 장치:** macOS는 앱의 서명이 바뀌면 다른 앱으로 취급해 권한을 다시 묻습니다. 그래서 ChatKJB는 **Node 실행 파일이 실제로 바뀐 경우에만** 앱을 다시 만듭니다. 그냥 재설치할 때는 기존 앱을 그대로 두므로 한 번 준 권한이 유지됩니다.

앱만 따로 다시 만들려면:

```bash
npm run launchd:app
```

코드를 고친 뒤에는 다시 등록할 필요 없이 재시작만 하면 됩니다.

```bash
npm run build
npm run launchd:restart
```

상태 확인:

```bash
launchctl print gui/$(id -u)/com.chatkjb.bot
```

정상이면 이렇게 나옵니다.

- `state = running`
- `program`이 의도한 Node 경로
- `arguments`가 저장소의 `dist/index.js`를 가리킴
- `working directory`가 저장소 경로

### 소스 업데이트와 LaunchAgent 건강 확인

소스 설치본은 저장소 루트에서 다음 순서로 업데이트합니다. `git pull --ff-only`가 멈추면 충돌을 임의로 덮어쓰지 말고, 현재 작업을 먼저 정리하세요.

```bash
git pull --ff-only
nvm use
npm install
npm run build
npm run launchd:restart
launchctl print gui/$(id -u)/com.chatkjb.bot
```

마지막 출력에서 위의 `state = running`, `arguments`, `working directory`를 확인하고 Telegram에서 `/doctor`도 실행하세요. Node를 바꿨거나 `program` 경로가 기대와 다르면 재시작이 아니라 아래처럼 LaunchAgent를 다시 등록해야 합니다.

```bash
npm install
npm run build
npm run launchd:install
launchctl print gui/$(id -u)/com.chatkjb.bot
```

소스 설치의 선택적 CloudStorage/NAS 미러는 아래 [개인 백업](#선택-개인-백업-일반-설치에는-불필요) 절에서 등록합니다. 미러는 소스 저장소의 `.env`, `projects.json`, `data/`를 보존하지만 `node_modules`와 `dist`는 제외하므로, 복구한 저장소에서는 `npm install`과 `npm run build`를 다시 실행한 뒤 `npm run launchd:install`으로 등록을 복원하세요. 이 미러는 DMG 앱의 Application Support 폴더는 백업하지 않습니다.

### 재시작 뒤에 하던 일 이어가기

재시작 직전에 **돌아가던 중**이거나 **대기 중**이던 작업은 다음 시작 때 **한 번 자동으로 이어집니다.**

단, **승인 대기 중**이거나 **한도 대기 중**이던 작업은 자동으로 이어지지 **않습니다.** 내가 확인하지 않은 위험한 작업이 몰래 실행되는 것을 막기 위해서입니다.

자동으로 안 이어졌는데 계속하고 싶으면 그 방에서 `/resume` 을 보내세요.

## 선택: ChatKJB Terminal 데스크톱 앱

`ChatKJB Terminal`은 Mac에서 ChatKJB 대화를 **터미널처럼 생긴 화면**으로 보는 앱입니다.

일반 텔레그램 앱과 다른 점:

- 텔레그램 전체가 아니라 **ChatKJB가 있는 방 하나만** 보여 줍니다.
- 연락처·전화·설정 화면이 없습니다.
- 메시지를 말풍선에 가두지 않고, 창 너비에 맞춰 흐르는 **어두운 터미널 화면**으로 보여 줍니다.

> **주의:** 이것은 텔레그램 공식 앱이 아닌 **비공식 클라이언트**입니다. 텔레그램 API 이용약관과 계정 보안은 본인이 확인하셔야 합니다.

이 앱은 봇 토큰이 아니라 **API ID / API Hash**를 씁니다. 앱 전용 세션 파일은 봇의 세션과 분리하세요.

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_GUI_SESSION_PATH=./data/telegram-gui.session
```

### 앱 만들기

```bash
npm run gui:macos:build    # 앱 만들기
npm run gui:macos:audit    # 비밀값이 안 들어갔는지 검사
npm run gui:macos:smoke    # 실제로 뜨고 잘 꺼지는지 검사
```

한 번에 닫고·빌드하고·실행하려면:

```bash
./script/build_and_run.sh
./script/build_and_run.sh --verify   # 실행까지 확인
```

완성된 앱은 `.artifacts/ChatKJB Terminal.app` 에 생깁니다. **이 앱 하나만 다른 Mac에 복사해도 실행됩니다.** 그 Mac에 저장소나 Node가 없어도 됩니다. (Apple Silicon + macOS 14 이상)

> ad-hoc 서명이라서, 새 Mac에서 처음 열 때 **시스템 설정 → 개인정보 보호 및 보안**에서 한 번 열기를 허용해야 할 수 있습니다.

### 처음 실행할 때

1. API ID, 32자리 API Hash, 방 chat ID, 허용 사용자 ID를 입력합니다.
2. 앱이 `~/Library/Application Support/ChatKJB Terminal` 안에 설정을 만듭니다. (폴더 `0700`, 파일 `0600`)
3. **QR 코드**가 뜹니다. 휴대폰 텔레그램의 **설정 → 기기 → 데스크톱 기기 연결**로 스캔합니다.
4. 2단계 인증을 켜 두었다면 QR 승인 후 비밀번호를 한 번 더 넣습니다.

> 이 로그인은 **기기 하나를 추가**하는 것입니다. 휴대폰 텔레그램은 그대로 쓸 수 있고 로그아웃되지 않습니다.
>
> ChatKJB 응답을 받으려면 **봇 서비스는 따로 계속 돌고 있어야 합니다.** 이 앱은 보는 창일 뿐입니다.

### 앱 끄기와 로그아웃의 차이

| 동작 | 결과 |
| --- | --- |
| 창 닫기 / `⌘Q` | 화면만 끕니다. 세션은 유지되어 다음에 QR을 다시 안 물어봅니다. |
| **세션 → 로그아웃** | 서버에서 진짜 로그아웃하고 세션 파일도 지웁니다. 휴대폰 텔레그램과 봇은 그대로입니다. |
| 앱이 안 열릴 때 | 휴대폰 텔레그램 **설정 → 기기**에서 해당 세션을 종료한 뒤, 로컬 세션 파일을 지우고 다시 QR로 연결합니다. |

### 기존 설정을 앱으로 옮기기

개발 Mac의 설정과 앱 전용 세션만 Application Support로 한 번 옮깁니다. **봇 토큰·AI 토큰·데이터베이스는 복사하지 않고, 원본도 그대로 둡니다.**

```bash
npm run gui:macos:migrate
# 설치 검증이 실패했을 때만
npm run gui:macos:migrate:rollback
```

되돌리기는 **이번에 새로 만든 파일만** 대상으로 하며, 사용자가 파일을 손댄 뒤에는 안전하게 중단됩니다.

## 선택: 개인 백업 (일반 설치에는 불필요)

클라우드나 NAS로 백업하는 기능입니다. **봇 동작과 아무 상관이 없으니 건너뛰어도 됩니다.**

```dotenv
CHATKJB_MIRROR_DEST=/absolute/path/to/mirror/ChatKJB
CHATKJB_NAS_SSH=user@nas-host
CHATKJB_NAS_PORT=22
# CHATKJB_NAS_REMOTE_DIR=$HOME/backups
```

```bash
npm run mirror:install-agent       # CHATKJB_MIRROR_DEST 필요
npm run nas-mirror:install-agent   # CHATKJB_NAS_SSH 필요
```

설정하지 않으면 스크립트가 안내만 하고 그냥 종료합니다.

## 환경 변수 전체 목록

`.env`에 넣을 수 있는 설정입니다. **대부분은 안 건드려도 됩니다.**

### 꼭 필요한 것

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | 없음 | BotFather에서 받은 봇 토큰입니다. |
| `TELEGRAM_CHAT_ID` | 없음 | ChatKJB가 동작할 그룹 chat ID입니다. |
| `TELEGRAM_ALLOWED_USER_ID` | 없음 | 허용할 사용자 ID 하나입니다. |
| `TELEGRAM_ALLOWED_USER_IDS` | 없음 | 허용할 사용자 ID를 쉼표로 여러 개 씁니다. |

### AI 관련

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | 없음 | Claude를 쓸 때 필요합니다. |
| `CLAUDE_CODE_OAUTH_TOKEN_2`, `_3` | 없음 | Claude 추가 계정입니다. |
| `CODEX_ACCOUNT_HOMES` | `~/.codex` | Codex 계정 폴더를 쉼표로 나열합니다. |
| `CLAUDE_CODE_EXECUTABLE` | 자동 탐색 | Claude 실행 파일 위치입니다. |
| `CODEX_EXECUTABLE` | 자동 탐색 | Codex 실행 파일 위치입니다. |
| `AGY_EXECUTABLE` | 자동 탐색 | Antigravity 실행 파일 위치입니다. |
| `GROK_EXECUTABLE` | 자동 탐색 | Grok 실행 파일 위치입니다. |
| `GROK_MODEL` | `grok-4.5` | Grok 기본 모델입니다. |
| `AGY_MCP_SERVERS` | 목록 있음 | Antigravity에 노출할 확장 도구 이름입니다. |
| `GROK_MCP_SERVERS` | 목록 있음 | Grok에 노출할 확장 도구 이름입니다. |

### 텔레그램 관련

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TELEGRAM_IP_FAMILY` | `auto` | 연결 방식입니다. 특정 네트워크에서만 `4` 또는 `6`으로 고정합니다. |
| `TELEGRAM_API_ID` | 없음 | 앱에서 방을 지웠을 때 감지하는 기능에 필요합니다. |
| `TELEGRAM_API_HASH` | 없음 | 위와 함께 설정합니다. **외부에 노출 금지.** |
| `TELEGRAM_MTPROTO_SESSION_PATH` | `./data/telegram-mtproto.session` | 봇용 세션 파일입니다. |
| `TELEGRAM_GUI_SESSION_PATH` | `./data/telegram-gui.session` | Terminal 앱 전용 세션 파일입니다. **봇 세션과 분리하세요.** |

### 경로와 저장소

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/state.sqlite` | 상태 데이터베이스 위치입니다. |
| `PROJECTS_PATH` | `./projects.json` | 프로젝트 목록 파일입니다. |
| `FILE_INBOX_DIR` | `~/.claude/channels/telegram/inbox` | 텔레그램으로 받은 파일을 저장할 곳입니다. |
| `CLAUDE_MEMORY_DIR` | `~/.claude/memory` | Claude 장기 메모리 위치입니다. |
| `LLM_WIKI_ROOT` 또는 `WIKI_VAULT` | 자동 탐색 | 기록 창고 위치입니다. 마운트된 볼륨(`/Volumes/*/LLM-Wiki`)과 CloudStorage에서 자동으로 찾습니다. |
| `KJB_WIKI_POST_COMPILE_SCRIPT` | 없음 | `/compile` 성공 뒤 실행할 스크립트입니다. (절대 경로만) |
| `CHATKJB_LOG_ROOT` | `~/Library/Logs` | 기록 파일을 둘 상위 폴더입니다. |

### 동작 조절

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TZ` | 컴퓨터 설정 | 시간대입니다. IANA 이름을 씁니다. |
| `CHATKJB_LOCALE` | `ko-KR` | 날짜·숫자 표시 형식입니다. |
| `APPROVAL_TIMEOUT_MINUTES` | `30` | 승인 버튼을 몇 분 기다릴지 정합니다. |
| `STATUS_DEBOUNCE_MS` | `2500` | 진행 상황 메시지를 너무 자주 안 보내게 막는 간격입니다. |
| `MCP_TOOL_TIMEOUT_SECONDS` | `60` | 확장 도구 제한 시간입니다. |
| `MCP_MAX_ATTEMPTS` | `3` | 확장 도구 재시도 횟수입니다. |
| `CODEX_MCP_TIMEOUT_MINUTES` | `30` | Codex의 긴 확장 도구 제한 시간입니다. |
| `CODEX_MCP_HEARTBEAT_SECONDS` | `60` | Codex 확장 도구 생존 신호 주기입니다. |
| `LONG_RUNNING_MCP_SERVERS` | `codex,obsidian` | 오래 걸리는 것으로 취급할 도구 이름입니다. |
| `PROVIDER_TURN_TIMEOUT_MINUTES` | `0` | 한 턴의 절대 제한입니다. `0`이면 무제한입니다. |
| `TURN_IDLE_TIMEOUT_MINUTES` | `35` | 완전히 멈춘 작업을 자동으로 끊는 최후 안전장치입니다. |

### 백업 (선택)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `CHATKJB_MIRROR_DEST` | 없음 | 백업 대상 폴더 절대 경로입니다. |
| `CHATKJB_NAS_SSH` | 없음 | NAS 접속 주소(`user@host`)입니다. |
| `CHATKJB_NAS_PORT` | `22` | NAS 접속 포트입니다. |
| `CHATKJB_NAS_REMOTE_DIR` | `$HOME/backups` | NAS 쪽 백업 폴더입니다. |

### 내부용 (직접 넣을 필요 없음)

| 변수 | 용도 |
| --- | --- |
| `CHATKJB_PROJECT_DIR` | 자동 실행이 사용할 저장소 위치입니다. |
| `CHATKJB_FOLDER_BROWSER_ROOT` | 테스트에서 탐색 범위를 좁힐 때 씁니다. |

## LLM-Wiki 연결하기 (선택)

ChatKJB는 오래 쓸 기록을 **LLM-Wiki**라는 별도 저장소에 모으도록 만들어져 있습니다.

위치는 자동으로 찾습니다.

1. 마운트된 볼륨의 `LLM-Wiki` 폴더 (`/Volumes/*/LLM-Wiki`)
2. `~/Library/CloudStorage` 아래 클라우드 드라이브의 `LLM-Wiki` 폴더
3. ChatKJB 저장소와 나란히 있는 `LLM-Wiki` 폴더

세 번째 방식이 가장 간단합니다.

```text
work/
  ChatKJB/
  LLM-Wiki/
```

자동으로 못 찾는 곳에 두었다면 직접 알려 주세요.

```dotenv
LLM_WIKI_ROOT=/absolute/path/to/LLM-Wiki
```

### 대화 기록 모으기

끝난 대화와 `.result.md` 결과 기록을 LLM-Wiki의 `10-inbox/` 로 모을 수 있습니다.

텔레그램에서:

```text
/dpbot
```

터미널에서:

```bash
npm run transcripts:dump
```

특징:

- 완료·오류·중단·검증실패 상태의 대화를 모읍니다.
- 같은 대화를 여러 번 모아도 **새로 늘어난 부분만** 기록합니다.
- 글자와 공백을 정규화한 지문으로 중복을 줄입니다.
- 사용자 홈, 클라우드, 연결된 외장·네트워크 디스크에서 `.result.md`를 찾아 함께 모읍니다. 휴지통·메타데이터·라이브러리 폴더는 건너뜁니다.
- **예약 실행하지 않습니다.** 필요할 때 직접 돌리세요.

## 함께 들어 있는 확장 도구 (MCP)

MCP는 AI에게 **추가 능력을 붙여 주는 부품**입니다. 저장소에 몇 개가 함께 들어 있습니다.

### PDF 도구

`scripts/pdf-tools-mcp.py` — PyMuPDF를 씁니다.

| 도구 | 하는 일 |
| --- | --- |
| `pdftotext` | PDF에서 글자를 뽑아 `.txt`로 저장하고 위치를 알려 줍니다. |
| `pdf_extract_figures` | PDF의 그림을 PNG로 저장하고 위치를 알려 줍니다. |

큰 PDF 내용을 텔레그램 메시지로 길게 쏟아내는 대신 **파일 위치만 넘기기** 위한 도구입니다.

### 논문·임상시험 검색

`scripts/literature-evidence-mcp.py` — **유료 플랜 없이** 공개 API만 씁니다.

| 도구 | 데이터 출처 | 알려주는 것 |
| --- | --- | --- |
| `search_papers` | Semantic Scholar (막히면 OpenAlex) | 제목, 저자, 초록, DOI/PMID, 학술지, 연도, 인용 수, 공개 PDF |
| `search_clinical_trials` | ClinicalTrials.gov API v2 | NCT ID, 요약, 상태, 단계, 등록 수, 질환, 중재, 스폰서, 날짜 |

> **주의:** 초록과 등록 정보만 보고 내린 중요한 결론은 **반드시 원문에서 다시 확인**하세요.

### scihub

`scripts/scihub-mcp.py` — DOI·PMID·URL을 미러에서 찾아 PDF를 내려받습니다.

| 도구 | 하는 일 |
| --- | --- |
| `list_mirrors` | 설정된 미러 목록을 보여 줍니다. |
| `resolve_paper` | PDF 주소와 인용 정보만 찾습니다. (저장 안 함) |
| `fetch_paper` | PDF를 내려받고 위치를 알려 줍니다. |

> **저작권과 접근 규정을 지킬 책임은 사용하는 사람에게 있습니다.** 가능하면 오픈액세스를 먼저 쓰세요.

### price-feed (주식 시세)

`price-feed-mcp/` 는 **독립된 하위 패키지**입니다. 미국·국내 주식 시세와 시장 심리를 알려 줍니다.

| 도구 | 하는 일 |
| --- | --- |
| `get_quote` | 현재가를 조회합니다. |
| `get_order_book` | 호가창(사려는 값·팔려는 값)을 조회합니다. |
| `get_fear_greed` | CNN Fear & Greed 심리 지수를 조회합니다. |
| `feed_status` | 자격증명이 설정되었는지 확인합니다. |

```bash
cd price-feed-mcp
npm install
npm run build
npm test
npm start
```

> 자격증명은 환경 변수나 로컬 비밀 파일에서 읽으며, **Git에 커밋하지 않습니다.**

## 4개 AI가 같은 것을 보게 하기 (공통 자원)

Claude, Codex, Antigravity, Grok이 **같은 지침과 같은 도구 목록**을 보도록 동기화하는 계층입니다.

```text
~/.claude/shared-resources/RESOURCE.md
~/.claude/shared-resources/POLICIES.md
~/.claude/shared-resources/SKILLS.md
~/.claude/shared-resources/MEMORY-BRIDGE.md
~/.claude/shared-resources/connectors.json
~/.claude/shared-resources/codex-agents/lite.toml
```

하는 일:

- `~/.claude/CLAUDE.md` **하나를 원본**으로 두고, 4개 AI가 각자 찾는 위치에 안전한 바로가기(심링크)로 연결합니다.
- 긴 규칙은 `POLICIES.md`에 보관하고, **필요한 상황이 왔을 때 해당 부분만** 읽습니다. 매번 전문을 집어넣지 않습니다.
- 흩어진 메모리 저장소들을 함께 찾을 수 있게 연결합니다.
- 설치된 스킬과 플러그인 스킬을 **하나의 목록**으로 합칩니다. 저장소에 들어 있는 `skills/deep-interview`, `skills/ralplan`, `skills/ultragoal`도 포함됩니다.
- Claude와 Codex의 확장 도구 설정을 병합해 공유 목록을 만듭니다.
- `connectors.json`은 **결과물**이지 입력이 아닙니다. 도구를 영구 등록하려면 원본 Claude/Codex 설정에 하세요. 안 그러면 동기화할 때 사라집니다.
- Codex는 주 작업자만 확장 도구를 띄우고, 보조 일꾼들은 `lite.toml`로 도구를 생략합니다. **일꾼 수만큼 서버가 늘어나는 것을 막기 위해서**입니다.
- 도구별 비밀값은 별도 비밀 파일로 넣으며, **문서에는 실제 값을 쓰지 않습니다.**

공용 스킬 추가:

```bash
npm run skills:add-shared -- "스킬 이름" --description "이럴 때 쓴다"
npm run shared:sync    # 내용을 고친 뒤 다시 동기화
```

---

# 3부. 개발자 안내

## 기술 스택

- TypeScript (ESM)
- Node.js 26.4.0 이상
- grammY (텔레그램)
- Claude Agent SDK
- OpenAI Codex SDK
- Antigravity CLI 백엔드
- Grok CLI 백엔드
- better-sqlite3
- zod
- vitest

## 폴더 구조

| 경로 | 역할 |
| --- | --- |
| `src/` | 봇 본체와 세션 실행 로직 |
| `src/gui/` | 텔레그램 사용자 클라이언트, loopback 서버, 터미널형 웹 UI |
| `native/macos/` | WKWebView 네이티브 셸, 격리된 백엔드 spawn 코드, `Info.plist` |
| `script/build_and_run.sh` | Terminal 앱의 종료·빌드·실행·검증 단일 진입점 |
| `scripts/` | 인증, launchd, transcript dump, PDF MCP, 공유 스킬 스크립트 |
| `skills/` | 번들된 제공자 중립 워크플로 스킬 정의 |
| `tests/` | vitest 테스트 |
| `price-feed-mcp/` | 독립 시세 MCP 하위 패키지 |
| `data/` | SQLite DB와 런타임 데이터 (**Git 제외**) |
| `dist/` | 빌드 산출물 |

## 핵심 소스 파일

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 진입점, 설정 로딩, 자원 동기화, 명령 메뉴 등록, 봇 시작 |
| `src/config.ts` | `.env`, `projects.json`, 경로, 계정 홈, 환경 검증 |
| `src/bot.ts` | 텔레그램 봇 조립과 공유 의존성 생성 |
| `src/bot/handlers/*.ts` | 명령·버튼·메시지·파일 핸들러 그룹 |
| `src/session-manager.ts` | 세션 큐, provider 전환, native goal 전달, 한도 상태 조정 |
| `src/session/executors/{claude,codex,agy,grok}.ts` | provider별 실행·중단·재시도·정리 수명주기 |
| `src/session/executors/shared.ts` | 실행기가 공유하는 최소 호스트 계약 |
| `src/user-input-protocol.ts` | 제공자 중립 선택형 UI 요청 검증과 답변 직렬화 |
| `src/workflow-skills.ts` | 번들 워크플로 목록과 세션별 상태 경로 |
| `src/child-process.ts` | CLI 자식 프로세스와 하위 프로세스 종료 유틸리티 |
| `src/session-prompts.ts` | 오케스트레이션 경계와 서브에이전트 위임 지침 생성 |
| `src/session-environment.ts` | provider CLI 환경변수·PATH 조립, Codex multi-agent 한도 적용 |
| `src/store.ts` | SQLite 스키마와 CRUD |
| `src/model-catalog.ts` | provider별 모델 목록과 fallback |
| `src/cli-resolver.ts` | 4개 provider 실행 파일 탐색 |
| `src/doctor.ts` | `/doctor` 진단 보고서 |
| `src/dashboard.ts` | `/status` 작업판 |
| `src/permission-broker.ts` | 도구 승인과 선택형 질문 브로커 |
| `src/token-pool.ts` | Claude OAuth 토큰 회전과 한도 상태 |
| `src/codex-account-pool.ts` | Codex 계정 홈 회전 |
| `src/connectors.ts` | MCP 커넥터 병합과 동기화 |
| `src/resource-sync.ts` | 공통 지침·메모리·스킬·커넥터 생성 |
| `src/wiki-paths.ts` | LLM-Wiki 경로 탐지 |
| `src/router.ts` | `/route` provider 추천 |
| `src/judge.ts` | `/synth` 상호 비판·리그 판정·통합 |
| `src/stream-renderer.ts` | 세션 스트림을 텔레그램 메시지로 렌더링 |
| `src/redaction.ts` | 비밀값 마스킹 |
| `src/runtime-paths.ts` | 실행 기준 저장소 경로 해석 |

## 실행 수명주기

`SessionManager`는 **공통 조정만** 맡습니다. 실제 provider 실행은 전용 실행기가 맡으므로, 한 provider의 변경이 다른 provider 경로에 섞이지 않습니다.

```text
텔레그램 메시지
  → SessionManager   : 세션·큐·provider 선택과 상태 조정
  → provider executor: 실행, 스트리밍, 재시도, 중단, 정리
  → 텔레그램 결과 + SQLite 세션 상태
```

- 4개 실행기가 각자 자기 SDK/CLI 수명주기를 관리합니다.
- `/stop`·삭제·종료 시 `SessionManager`가 취소하고, 실행기가 입력·타이머·세션을 정리합니다. CLI 자식 프로세스는 하위 프로세스까지 종료합니다.
- 실행기와 조정자 사이에는 `shared.ts`의 최소 계약만 공유합니다. **새 provider를 추가할 때 provider 전용 상태를 `SessionManager`로 되돌려 넣지 마세요.**

## 요청 처리 흐름

1. `src/index.ts`가 설정·저장소·모델 카탈로그·공통 자원을 초기화합니다.
2. `src/bot.ts`가 업데이트를 받아 **허용된 사용자와 그룹인지 확인**합니다.
3. `/new`가 프로젝트 미확정 topic을 만들고, 첫 메시지를 격리된 읽기 전용 선택기에 넘깁니다.
4. 검증된 프로젝트 ID를 실제 경로로 해석한 뒤 세션을 만듭니다.
5. `src/session-manager.ts`가 설정된 provider의 전용 실행기로 넘깁니다.
6. 실행기가 스트리밍·승인·오류·완료를 topic에 전송합니다.
7. 상태·사용량·요약이 SQLite에 저장됩니다.
8. 필요하면 transcript dump가 완료 세션을 LLM-Wiki inbox로 보냅니다.

## npm 스크립트

| 명령 | 역할 |
| --- | --- |
| `npm run dev` | `tsx watch`로 개발 실행 |
| `npm run build` | `dist/`를 지우고 빌드 |
| `npm start` | 빌드 산출물 실행 |
| `npm run typecheck` | 타입체크 |
| `npm test` | 전체 테스트 |
| `npm run auth:setup` | Claude OAuth 토큰 설정 |
| `npm run launchd:app` | 권한 화면용 `ChatKJB.app` 래퍼만 다시 생성 |
| `npm run launchd:install` | 자동 실행 등록 (래퍼 앱 생성 포함) |
| `npm run launchd:restart` | 자동 실행 재시작 |
| `npm run gui:macos:build` | Terminal 앱 빌드 + ad-hoc 서명 |
| `npm run gui:macos:audit` | 번들에 비밀값·세션이 안 들어갔는지 검사 |
| `npm run gui:macos:smoke` | 실제 기동·정상종료·비정상종료 정리 검증 |
| `npm run gui:macos:migrate` | 설정·세션만 Application Support로 이관 |
| `npm run gui:macos:migrate:rollback` | 이번 이관의 신규 상태만 제거 |
| `npm run gui:render:check` | 실제 브라우저에서 렌더링·스크롤·입력 검증 |
| `npm run audit:portability` | **추적 파일의 개인 절대 경로·이메일 흔적 검사** |
| `npm run shared:sync` | 공통 지침·스킬·커넥터 재생성 |
| `npm run skills:add-shared` | 공유 스킬 골격 추가 |
| `npm run transcripts:dump` | transcript와 결과 로그 수집 |

## 새 텔레그램 명령 추가하기

1. 성격에 맞는 `src/bot/handlers/*.ts`에 `bot.command("name", ...)` 핸들러를 추가합니다. 새 그룹이 필요하면 `src/bot/handlers/index.ts`에 등록합니다.
2. 메뉴에 보이려면 `src/index.ts`의 `setMyCommands`에도 추가합니다.
3. 상태 저장이 필요하면 `src/types.ts`와 `src/store.ts` 마이그레이션을 고칩니다.
4. provider 실행에 영향을 주면 해당 실행기와 `src/session-manager.ts` 경계를 함께 봅니다.
5. 사용자에게 보이는 명령이면 **README 명령표와 테스트를 갱신**합니다.

## 검증

```bash
npm run typecheck
npm test
npm run build
```

특정 테스트만:

```bash
npm test -- tests/orchestration-tier0.test.ts
```

## 커밋 전 확인 목록

- [ ] `.env`, `projects.json`, `data/`, 로그가 Git에 안 들어갔는가
- [ ] README·테스트·로그에 실제 토큰이나 API 키가 없는가
- [ ] `npm run audit:portability`가 통과하는가 (개인 절대 경로·이메일 검사)
- [ ] 공개 명령을 바꿨다면 `setMyCommands`·`src/bot.ts`·README를 함께 고쳤는가
- [ ] 설정 키를 바꿨다면 `.env.example`·`src/config.ts`·README를 함께 고쳤는가
- [ ] launchd 라벨을 바꾼다면 DB·로그·LaunchAgent·문서를 함께 점검했는가

---

# 4부. 문제 해결

## 일단 이것부터

터미널에서:

```bash
npm run typecheck
npm test
npm run build
launchctl print gui/$(id -u)/com.chatkjb.bot
```

텔레그램에서:

```text
/doctor
/status
/usage
```

## `.env permissions must be 0600` 오류

**증상:** 시작하자마자 설정 로딩이 실패합니다.

**원인:** `.env` 파일을 다른 사람도 읽을 수 있는 상태입니다.

**해결:**

```bash
chmod 600 .env
```

## `better-sqlite3` 관련 오류

**증상:** 빌드나 실행 중 네이티브 모듈 오류가 납니다.

**원인:** 설치할 때의 Node 버전과 실행할 때의 Node 버전이 다릅니다.

**해결:**

```bash
node -v          # v26.4.0 이상인지 확인
npm install
npm run build
```

## 텔레그램이 아무 반응이 없을 때

위에서부터 순서대로 확인하세요.

1. `.env`의 `TELEGRAM_BOT_TOKEN`이 맞습니까?
2. `TELEGRAM_CHAT_ID`가 진짜 그 그룹의 ID입니까? (보통 `-100`으로 시작하는 음수)
3. `TELEGRAM_ALLOWED_USER_ID`에 **내 ID**가 들어 있습니까?
4. 봇이 그룹 **관리자**이고 **토픽 관리 권한**이 있습니까?
5. 자동 실행 중이라면 `~/Library/Logs/com.chatkjb.bot/stderr.log`를 보세요.
6. 직접 실행 중이라면 터미널 출력을 보세요.

## 폴더가 목록에 안 보일 때

1. `projects.json` 위치가 `PROJECTS_PATH`와 맞습니까?
2. 각 `cwd`가 **실제로 존재하는** 폴더입니까?
3. ChatKJB가 그 폴더를 읽고 쓸 수 있습니까?
4. 외장 디스크나 NAS라면 **연결(마운트)되어 있습니까?**
5. 텔레그램에서 `/new browse`로 드라이브가 보이는지 확인하세요.

## AI 사용 한도에 걸렸을 때

```text
/usage
```

- Claude는 `CLAUDE_CODE_OAUTH_TOKEN_2`, `_3`에 계정을 더 등록할 수 있습니다.
- Codex는 `CODEX_ACCOUNT_HOMES`에 계정 폴더를 더 등록할 수 있습니다.
- 한도에 걸린 계정은 회복될 때까지 기다리거나 다음 계정으로 넘어갑니다.
- 회복되면 자동으로 다시 시작하는데, 원치 않으면 그 방에서 `/restop`을 보내세요.

## Codex 로그인이 안 될 때

```bash
CODEX_HOME=~/.codex codex login
```

`CODEX_ACCOUNT_HOMES`에 적은 **모든 폴더**에 `auth.json`이 있어야 하고, **ChatGPT 로그인 방식**이어야 합니다.

## Antigravity가 안 될 때

```bash
agy --version
agy --help
```

`AGY_EXECUTABLE` 경로, CLI 로그인 상태, `agy --print` 동작을 확인하세요. 필요하면 `useG1Credits` 설정도 봅니다.

## 작업이 멈춘 것 같을 때

1. `/status`로 진짜 멈췄는지 확인합니다. (오래 생각 중일 수도 있습니다)
2. `/stop`으로 중단합니다.
3. `TURN_IDLE_TIMEOUT_MINUTES`가 완전히 멈춘 작업을 자동으로 끊는 최후 안전장치입니다.
4. 오래 걸리는 확장 도구 문제라면 `LONG_RUNNING_MCP_SERVERS`, `CODEX_MCP_TIMEOUT_MINUTES`, `CODEX_MCP_HEARTBEAT_SECONDS`를 확인합니다.

## Terminal 앱이 안 열릴 때

1. `~/Library/Application Support/ChatKJB Terminal` 폴더가 **내 소유**이고 권한이 `0700`입니까?
2. 그 안의 `.env`와 세션 파일이 일반 파일이고 권한이 `0600`입니까?
3. 개발 환경이라면 다시 검증해 봅니다.

```bash
npm run gui:macos:audit
npm run gui:macos:smoke
```

---

# 현재 제한 사항

솔직하게 밝히는, 지금 안 되는 것들입니다.

- **텔레그램 그룹 하나**를 기준으로 동작합니다.
- 텔레그램 Bot API 제한 때문에 **큰 파일**은 주고받기 어렵습니다.
- 앱에서 방을 지웠을 때 동기화는 `TELEGRAM_API_ID`와 `TELEGRAM_API_HASH`를 **둘 다** 설정해야 켜집니다. 아니면 `/delete`를 쓰세요.
- 폴더별 작업은 충돌 방지를 위해 **한 번에 하나씩만** 실행합니다.
- **Codex**는 계정을 바꾸면 이전 대화를 그대로 이어받지 못할 수 있어 요약으로 새로 시작합니다.
- **Antigravity**는 CLI가 상태·취소·사용량을 충분히 알려주지 않으면 ChatKJB가 보여줄 수 있는 정보도 제한됩니다.
- **Grok**은 CLI 실행 파일과 CLI의 모델 목록 응답에 의존합니다.
- **`/goal`은 Claude와 Codex에서만** 동작합니다.
- **macOS 전용**입니다. 윈도우와 리눅스는 지원하지 않습니다.

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

자주 쓰는 텔레그램 명령:

```text
/new
/reserve 블로그 내일 오전 9시 맞춤법 검사해줘
/cancel
/status
/usage
/doctor
/stop
```

---

## 라이선스

MIT License. 자세한 내용은 [LICENSE](LICENSE)를 보세요. 앱 번들 의존성의 추적 가능한 고지와 DMG 배포 후속 지점은 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.

## 문의

**contact@kimjb.com**
