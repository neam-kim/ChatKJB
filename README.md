# ChatKJB

<p align="center">Kim JongBeom의 Homepage, Email/KJBMail, ChatKJB agent dashboard를 한 Android launcher에서 여는 개인 생산성 앱</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-666666?labelColor=333333" alt="AGPL-3.0-or-later" /></a>
  <a href="https://github.com/neam-kim/ChatKJB/actions"><img src="https://img.shields.io/github/actions/workflow/status/neam-kim/ChatKJB/ci.yml?label=CI" alt="CI status" /></a>
</p>

ChatKJB는 `Kim JongBeom` launcher를 시작점으로 Homepage 화면, KJBMail 호스트로 여는 Email, 그리고 터미널에서 실행 중인 herdr agent를 휴대폰에서 확인·응답하는 ChatKJB dashboard를 제공합니다. Android 앱은 Kotlin/Jetpack Compose로 작성되며, 선택적으로 호스트의 Go companion과 WebSocket으로 연결됩니다.

## 제공 기능

- **Kim JongBeom launcher**: Homepage, Email, Chat 진입점과 `kimjb://open/...` / 레거시 `kjbmail://open` deep link.
- **Homepage**: 앱 내부 화면에서 Homepage를 열고 launcher로 돌아옵니다.
- **Email / KJBMail**: `dev.herdr.kjbmail:mail-host`의 Thunderbird Mail host를 통합해 `MailEntryActivity`를 실행합니다. KJBMail 소스는 이 저장소에 포함되지 않습니다.
- **ChatKJB dashboard**: herdr의 workspace/tab/pane 상태, blocked/working/done 상태, quick reply와 구조적 작업, embedded terminal을 제공합니다.
- **Go companion**: `companion/`의 `herdr-mobiled`가 herdr Unix socket을 읽고 Android에 WebSocket으로 상태와 PTY/RPC를 전달하며 UnifiedPush 알림을 중계합니다.

## Architecture

```text
herdr (호스트) -- NDJSON/Unix socket --> herdr-mobiled (Go)
                                              -- JSON/WebSocket --> ChatKJB (Android)
                                              -- UnifiedPush ------> phone notifications
KJBMail composite build --------------------> Android mail host
```

앱의 Android package/applicationId는 현재 `dev.herdr.mobile`로 유지됩니다. Go companion의 기존 upstream 패키지 경로와 내부 이름은 호환성을 위해 유지되며, 제품 UI와 저장소는 ChatKJB 기준입니다.

호환성 참고: `dev.herdr.mobile`, `github.com/mohamed-essam/herdr-mobile/companion`, `herdr-mobiled`, systemd unit 이름, herdr wire protocol 식별자는 기존 호스트와의 연동을 위해 변경하지 않았습니다. ChatKJB는 herdr 프로젝트를 기반으로 하며, 원 프로젝트 attribution은 유지합니다.

## 보안 모델과 현재 제약

companion v1 WebSocket API는 **인증이 없고 터미널 입력을 전송할 수 있습니다**. 인터넷에 노출하는 서버가 아닙니다. loopback 또는 신뢰하는 사설망(예: Tailscale) 주소에만 bind하고 `0.0.0.0`/공개 인터페이스를 사용하지 마십시오. daemon은 non-loopback bind 시 경고를 출력합니다. 자세한 위협 모델은 [`SECURITY.md`](SECURITY.md)를 읽으십시오.

현재 제약: KJBMail composite build가 없으면 Android 빌드는 의도적으로 명확한 설정 오류로 중단됩니다(아래 설정 참조). KJBMail 소스가 공개 저장소에 없으므로 GitHub Actions의 Android CI job은 거짓 성공을 피하기 위해 명시적으로 skip되며, release workflow는 Go companion만 배포합니다. ChatKJB는 아직 mail host 소스를 배포하지 않으며, companion 인증도 제공하지 않습니다.

## 설치

### Go companion

```bash
cd companion
go build -o ~/.local/bin/herdr-mobiled ./cmd/herdr-mobiled
herdr-mobiled --listen "$(tailscale ip -4):8787"
```

systemd user service는 [`companion/deploy/README.md`](companion/deploy/README.md)를 참조하십시오.

### Android

요구사항: JDK 21, Android SDK (compileSdk 36), Go 1.23+ (companion).

```bash
git clone --recurse-submodules https://github.com/neam-kim/ChatKJB.git
cd ChatKJB/app
ANDROID_HOME=$HOME/Android/Sdk ./gradlew :app:assembleDebug
# app/app/build/outputs/apk/debug/app-debug.apk
```

기존 clone은 `git submodule update --init --recursive`로 KJBMail을 가져오십시오. KJBMail은 [`neam-kim/KJBMail`](https://github.com/neam-kim/KJBMail)의 공개 source-only 저장소를 고정 커밋 `5082a97c66aa76d447ed8c5d4e5111db37cdb3ad`로 연결한 submodule이며, 기본 Gradle composite dependency로 사용됩니다. 다른 checkout을 사용하려면 `-Pkjbmail.dir=...` 또는 `KJBMAIL_DIR`로 명시할 수 있습니다. 앱에서 companion 주소는 `ws://<private-address>:8787/`로 설정합니다.

## 개발 및 검증

```bash
cd companion && go test ./... && gofmt -l .
cd ../app && ANDROID_HOME=$HOME/Android/Sdk ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

`docs/`에는 기능 설계 자료가 있습니다. 이 저장소의 upstream 기반 코드와 bundled Termux/JetBrains Mono 고지는 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)에 기록되어 있습니다. 원저작자 attribution과 upstream AGPLv3 조건을 변경하지 않습니다.

## License

ChatKJB는 **AGPL-3.0-or-later**로 배포됩니다. [`LICENSE`](LICENSE), [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)를 참조하십시오.
