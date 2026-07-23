import AppKit
import CoreImage
import Darwin
import Foundation
import WebKit

@_silgen_name("chatkjb_spawn_backend")
private func chatkjbSpawnBackend(
    _ supervisorPath: UnsafePointer<CChar>,
    _ nodePath: UnsafePointer<CChar>,
    _ entryPath: UnsafePointer<CChar>,
    _ workingDirectory: UnsafePointer<CChar>,
    _ readDescriptor: UnsafeMutablePointer<Int32>,
    _ childPid: UnsafeMutablePointer<pid_t>
) -> Int32

@_silgen_name("chatkjb_run_backend_supervisor")
private func chatkjbRunBackendSupervisor(
    _ nodePath: UnsafePointer<CChar>,
    _ entryPath: UnsafePointer<CChar>,
    _ workingDirectory: UnsafePointer<CChar>,
    _ controlDescriptor: Int32
) -> Int32

private enum ShellError: Error {
    case invalidRuntime(String)
    case invalidConfiguration(String)
    case invalidControlEvent
}

private struct RuntimeConfig {
    let supervisorURL: URL
    let workingDirectoryURL: URL
    let nodeURL: URL
    let backendURL: URL

    static func load(workingDirectoryURL: URL) throws -> RuntimeConfig {
        guard
            let supervisor = Bundle.main.executableURL,
            let resources = Bundle.main.resourceURL
        else { throw ShellError.invalidRuntime("앱 런타임 경로가 없습니다.") }

        let resourceRoot = resources.standardizedFileURL
        let node = resourceRoot.appendingPathComponent("Runtime/node", isDirectory: false).standardizedFileURL
        let backend = resourceRoot.appendingPathComponent("Backend/gui-entry.mjs", isDirectory: false).standardizedFileURL
        let resourcePrefix = resourceRoot.path.hasSuffix("/") ? resourceRoot.path : resourceRoot.path + "/"
        guard node.path.hasPrefix(resourcePrefix), backend.path.hasPrefix(resourcePrefix) else {
            throw ShellError.invalidRuntime("앱 런타임 경계가 올바르지 않습니다.")
        }
        guard FileManager.default.isExecutableFile(atPath: node.path) else {
            throw ShellError.invalidRuntime("내장 Node 실행 파일을 사용할 수 없습니다.")
        }
        guard FileManager.default.fileExists(atPath: backend.path) else {
            throw ShellError.invalidRuntime("내장 ChatKJB GUI 백엔드를 찾을 수 없습니다.")
        }
        return RuntimeConfig(
            supervisorURL: supervisor.standardizedFileURL,
            workingDirectoryURL: workingDirectoryURL.standardizedFileURL,
            nodeURL: node,
            backendURL: backend
        )
    }
}

private struct SetupValues {
    let apiId: Int64
    let apiHash: String
    let chatId: Int64
    let allowedUserIds: String

    static func parse(apiId: String, apiHash: String, chatId: String, allowedUserIds: String) throws -> SetupValues {
        let trimmedHash = apiHash.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAllowed = allowedUserIds.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            let parsedApiId = Int64(apiId.trimmingCharacters(in: .whitespacesAndNewlines)),
            parsedApiId > 0,
            trimmedHash.range(of: "^[A-Fa-f0-9]{32}$", options: .regularExpression) != nil,
            let parsedChatId = Int64(chatId.trimmingCharacters(in: .whitespacesAndNewlines)),
            parsedChatId < 0,
            !trimmedAllowed.isEmpty,
            trimmedAllowed.split(separator: ",", omittingEmptySubsequences: false).allSatisfy({ part in
                guard let value = Int64(part.trimmingCharacters(in: .whitespaces)), value > 0 else { return false }
                return value <= 9_007_199_254_740_991
            })
        else {
            throw ShellError.invalidConfiguration("입력값 형식이 올바르지 않습니다.")
        }
        return SetupValues(
            apiId: parsedApiId,
            apiHash: trimmedHash.lowercased(),
            chatId: parsedChatId,
            allowedUserIds: trimmedAllowed.split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespaces)
            }.joined(separator: ",")
        )
    }

    var environmentText: String {
        "TELEGRAM_API_ID=\(apiId)\n"
            + "TELEGRAM_API_HASH=\(apiHash)\n"
            + "TELEGRAM_CHAT_ID=\(chatId)\n"
            + "TELEGRAM_ALLOWED_USER_IDS=\(allowedUserIds)\n"
    }
}

private enum ConfigurationInspection {
    case missing
    case valid
    case repairable
    case unsafe
}

private enum ConfigurationStore {
    private static let allowedKeys = Set([
        "TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_CHAT_ID",
        "TELEGRAM_ALLOWED_USER_ID", "TELEGRAM_ALLOWED_USER_IDS"
    ])

    static func applicationSupportDirectory(noninteractive: Bool) throws -> URL {
        if noninteractive,
           let override = ProcessInfo.processInfo.environment["CHATKJB_CONFIG_BASE_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty {
            guard override.hasPrefix("/") else {
                throw ShellError.invalidConfiguration("격리 설정 경로가 절대경로가 아닙니다.")
            }
            return URL(fileURLWithPath: override, isDirectory: true).standardizedFileURL
        }
        guard let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            throw ShellError.invalidConfiguration("Application Support 경로를 찾지 못했습니다.")
        }
        return base.appendingPathComponent("ChatKJB Terminal", isDirectory: true).standardizedFileURL
    }

    static func prepareDirectory(_ directory: URL) throws {
        let manager = FileManager.default
        if (try? manager.destinationOfSymbolicLink(atPath: directory.path)) != nil {
            throw ShellError.invalidConfiguration("설정 폴더는 symbolic link일 수 없습니다.")
        }
        if !manager.fileExists(atPath: directory.path) {
            try manager.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
        let attributes = try manager.attributesOfItem(atPath: directory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid() else {
            throw ShellError.invalidConfiguration("설정 폴더가 안전한 사용자 폴더가 아닙니다.")
        }
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
        if permissions & 0o777 != 0o700 {
            try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        let verified = try manager.attributesOfItem(atPath: directory.path)
        let verifiedPermissions = (verified[.posixPermissions] as? NSNumber)?.intValue ?? -1
        guard verifiedPermissions & 0o777 == 0o700 else {
            throw ShellError.invalidConfiguration("설정 폴더 권한을 0700으로 만들지 못했습니다.")
        }
    }

    static func inspect(_ environmentURL: URL) -> ConfigurationInspection {
        let manager = FileManager.default
        if (try? manager.destinationOfSymbolicLink(atPath: environmentURL.path)) != nil { return .unsafe }
        guard manager.fileExists(atPath: environmentURL.path) else { return .missing }
        guard let attributes = try? manager.attributesOfItem(atPath: environmentURL.path) else { return .unsafe }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == geteuid() else {
            return .unsafe
        }
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
        guard permissions & 0o777 == 0o600 else { return .repairable }
        guard
            let data = try? Data(contentsOf: environmentURL, options: [.mappedIfSafe]),
            data.count <= 16_384,
            let text = String(data: data, encoding: .utf8),
            validEnvironment(text)
        else { return .repairable }
        return .valid
    }

    private static func validEnvironment(_ text: String) -> Bool {
        var values: [String: String] = [:]
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = String(rawLine).trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let separator = line.firstIndex(of: "=") else { return false }
            let key = String(line[..<separator])
            let value = String(line[line.index(after: separator)...])
            guard allowedKeys.contains(key), values[key] == nil, !value.isEmpty else { return false }
            values[key] = value
        }
        let allowed = [values["TELEGRAM_ALLOWED_USER_ID"], values["TELEGRAM_ALLOWED_USER_IDS"]]
            .compactMap { $0 }
            .joined(separator: ",")
        return (try? SetupValues.parse(
            apiId: values["TELEGRAM_API_ID"] ?? "",
            apiHash: values["TELEGRAM_API_HASH"] ?? "",
            chatId: values["TELEGRAM_CHAT_ID"] ?? "",
            allowedUserIds: allowed
        )) != nil
    }

    static func write(_ values: SetupValues, to environmentURL: URL) throws {
        let manager = FileManager.default
        let existing = inspect(environmentURL)
        guard existing != .unsafe else {
            throw ShellError.invalidConfiguration("기존 설정 파일이 안전한 일반 파일이 아닙니다.")
        }
        if existing != .missing {
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd-HHmmss"
            let backup = environmentURL.deletingLastPathComponent()
                .appendingPathComponent(".env.backup-\(formatter.string(from: Date()))", isDirectory: false)
            if !manager.fileExists(atPath: backup.path) {
                try manager.copyItem(at: environmentURL, to: backup)
                try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
            }
        }
        let temporary = environmentURL.deletingLastPathComponent()
            .appendingPathComponent(".env.tmp-\(UUID().uuidString)", isDirectory: false)
        guard manager.createFile(
            atPath: temporary.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else { throw ShellError.invalidConfiguration("임시 설정 파일을 만들지 못했습니다.") }
        do {
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.write(contentsOf: Data(values.environmentText.utf8))
            try handle.synchronize()
            try handle.close()
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
            if rename(temporary.path, environmentURL.path) != 0 {
                throw ShellError.invalidConfiguration("설정 파일을 원자적으로 교체하지 못했습니다.")
            }
        } catch {
            try? manager.removeItem(at: temporary)
            throw error
        }
        guard inspect(environmentURL) == .valid else {
            throw ShellError.invalidConfiguration("저장된 설정 파일을 검증하지 못했습니다.")
        }
    }

    static func runSelfTest(root: URL) throws {
        let manager = FileManager.default
        let rootURL = root.standardizedFileURL
        let temporaryRoot = manager.temporaryDirectory.standardizedFileURL.path
        guard rootURL.path.hasPrefix(temporaryRoot.hasSuffix("/") ? temporaryRoot : temporaryRoot + "/") else {
            throw ShellError.invalidConfiguration("설정 self-test 경로가 임시 폴더 밖입니다.")
        }
        try manager.createDirectory(at: rootURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let values = try SetupValues.parse(
            apiId: "12345678",
            apiHash: "0123456789abcdef0123456789abcdef",
            chatId: "-1001234567890",
            allowedUserIds: "123456"
        )

        let missingDirectory = rootURL.appendingPathComponent("Missing", isDirectory: true)
        try prepareDirectory(missingDirectory)
        let missingEnvironment = missingDirectory.appendingPathComponent(".env")
        guard inspect(missingEnvironment) == .missing else {
            throw ShellError.invalidConfiguration("missing 설정 검사가 실패했습니다.")
        }
        guard (try? SetupValues.parse(apiId: "x", apiHash: "bad", chatId: "1", allowedUserIds: "0")) == nil,
              !manager.fileExists(atPath: missingEnvironment.path) else {
            throw ShellError.invalidConfiguration("잘못된 입력이 파일을 만들었습니다.")
        }
        try write(values, to: missingEnvironment)
        guard inspect(missingEnvironment) == .valid else {
            throw ShellError.invalidConfiguration("유효 설정 저장 검사가 실패했습니다.")
        }

        let repairDirectory = rootURL.appendingPathComponent("Repair", isDirectory: true)
        try prepareDirectory(repairDirectory)
        let repairEnvironment = repairDirectory.appendingPathComponent(".env")
        try Data("BROKEN=yes\n".utf8).write(to: repairEnvironment)
        try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: repairEnvironment.path)
        guard inspect(repairEnvironment) == .repairable else {
            throw ShellError.invalidConfiguration("repairable 설정 검사가 실패했습니다.")
        }
        try write(values, to: repairEnvironment)
        let repairEntries = try manager.contentsOfDirectory(atPath: repairDirectory.path)
        guard inspect(repairEnvironment) == .valid,
              repairEntries.contains(where: { $0.hasPrefix(".env.backup-") }) else {
            throw ShellError.invalidConfiguration("설정 repair/backup 검사가 실패했습니다.")
        }

        let linkDirectory = rootURL.appendingPathComponent("Symlink", isDirectory: true)
        try prepareDirectory(linkDirectory)
        let canary = rootURL.appendingPathComponent("canary", isDirectory: false)
        try Data("canary\n".utf8).write(to: canary)
        let linkedEnvironment = linkDirectory.appendingPathComponent(".env", isDirectory: false)
        try manager.createSymbolicLink(at: linkedEnvironment, withDestinationURL: canary)
        guard inspect(linkedEnvironment) == .unsafe else {
            throw ShellError.invalidConfiguration("symbolic link 설정을 거부하지 못했습니다.")
        }
        var refusedSymbolicLink = false
        do {
            try write(values, to: linkedEnvironment)
        } catch ShellError.invalidConfiguration {
            refusedSymbolicLink = true
        }
        guard refusedSymbolicLink else {
            throw ShellError.invalidConfiguration("symbolic link 설정을 덮어썼습니다.")
        }
        guard try String(contentsOf: canary, encoding: .utf8) == "canary\n" else {
            throw ShellError.invalidConfiguration("symbolic link 대상이 변경되었습니다.")
        }
    }
}

private final class AppDelegate: NSObject,
    NSApplicationDelegate,
    NSWindowDelegate,
    NSMenuItemValidation,
    WKNavigationDelegate,
    WKUIDelegate,
    WKDownloadDelegate
{
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusLabel: NSTextField!
    private var qrPanel: NSPanel?
    private var qrExpiryTimer: Timer?
    private var backendPid: pid_t?
    private var backendSource: DispatchSourceProcess?
    private var controlHandle: FileHandle?
    private var startupTimer: Timer?
    private var pageTimer: Timer?
    private var controlBuffer = Data()
    private var controlProtocolRejected = false
    private let controlQueue = DispatchQueue(label: "com.chatkjb.terminal.control")
    private var allowedOrigin: (scheme: String, host: String, port: Int)?
    private var bootstrapURL: URL?
    private var terminating = false
    private var backendReady = false
    private var ready = false
    private var unexpectedFailureShown = false
    private var smokeValidationStarted = false
    private var smokePageReady = false
    private var smokeAuthReady = false
    private var downloads: [ObjectIdentifier: WKDownload] = [:]
    private var pendingDownloadDestinations: [ObjectIdentifier: (URL?) -> Void] = [:]
    private let smokeTest = CommandLine.arguments.contains("--smoke-test")
    private let diagnosticTest = CommandLine.arguments.contains("--diagnostic-test")
    private let noninteractive = CommandLine.arguments.contains("--smoke-test")
        || CommandLine.arguments.contains("--lifecycle-test")
        || CommandLine.arguments.contains("--diagnostic-test")

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenus()
        configureWindow()
        do {
            let configDirectory = try ConfigurationStore.applicationSupportDirectory(noninteractive: noninteractive)
            try ConfigurationStore.prepareDirectory(configDirectory)
            try ensureConfiguration(in: configDirectory)
            let runtime = try RuntimeConfig.load(workingDirectoryURL: configDirectory)
            try launchBackend(runtime)
        } catch {
            smokeDiagnostic("LAUNCH")
            failAndTerminate("ChatKJB Terminal을 시작하지 못했습니다.")
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        cancelPendingDownloadDestinations()
        closeQrPanel()
        pageTimer?.invalidate()
        pageTimer = nil
        stopBackend()
        webView.configuration.websiteDataStore.removeData(
            ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
            modifiedSince: .distantPast,
            completionHandler: {}
        )
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")

        statusLabel = NSTextField(labelWithString: "ChatKJB 백엔드를 시작하는 중입니다…")
        statusLabel.alignment = .center
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        webView.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(calibratedWhite: 0.045, alpha: 1).cgColor
        content.addSubview(webView)
        content.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            statusLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: content.centerYAnchor)
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "ChatKJB Terminal"
        window.minSize = NSSize(width: 720, height: 560)
        window.contentView = content
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func configureMenus() {
        let main = NSMenu()
        NSApp.mainMenu = main

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu(title: "ChatKJB Terminal")
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "ChatKJB Terminal 종료", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // macOS는 표준 편집 단축키(⌘C/⌘V/⌘X/⌘A/⌘Z)를 메뉴 항목의 key equivalent로만
        // 전달한다. 편집 메뉴가 없으면 웹뷰 안에서 복사·붙여넣기가 아예 동작하지 않는다.
        // 동작 대상은 nil 타깃으로 두어 현재 first responder(웹뷰 입력란)가 처리한다.
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "편집")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "실행 취소", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = editMenu.addItem(
            withTitle: "다시 실행",
            action: Selector(("redo:")),
            keyEquivalent: "z"
        )
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "오려두기", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "복사", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "붙여넣기", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "서식 없이 붙여넣기",
            action: #selector(NSTextView.pasteAsPlainText(_:)),
            keyEquivalent: "V"
        )
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "전체 선택", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let sessionItem = NSMenuItem()
        main.addItem(sessionItem)
        let sessionMenu = NSMenu(title: "세션")
        sessionItem.submenu = sessionMenu
        sessionMenu.addItem(withTitle: "로그아웃", action: #selector(logOut), keyEquivalent: "l")

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "보기")
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "새로고침", action: #selector(reload), keyEquivalent: "r")

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "윈도우")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "창 닫기", action: #selector(closeWindow), keyEquivalent: "w")
        windowMenu.addItem(
            withTitle: "최소화",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
    }

    private func ensureConfiguration(in directory: URL) throws {
        let environmentURL = directory.appendingPathComponent(".env", isDirectory: false)
        switch ConfigurationStore.inspect(environmentURL) {
        case .valid:
            return
        case .unsafe:
            throw ShellError.invalidConfiguration("기존 설정 파일이 안전한 일반 파일이 아닙니다.")
        case .missing, .repairable:
            guard !noninteractive else {
                throw ShellError.invalidConfiguration("격리 실행 설정이 없거나 올바르지 않습니다.")
            }
            try runConfigurationSheet(environmentURL: environmentURL)
        }
    }

    private func runConfigurationSheet(environmentURL: URL) throws {
        while true {
            let apiId = NSTextField(string: "")
            apiId.placeholderString = "12345678"
            let apiHash = NSSecureTextField(string: "")
            apiHash.placeholderString = "32자리 API Hash"
            let chatId = NSTextField(string: "")
            chatId.placeholderString = "-100… forum chat ID"
            let allowed = NSTextField(string: "")
            allowed.placeholderString = "Telegram 사용자 ID (여러 개면 쉼표)"
            for field in [apiId, apiHash, chatId, allowed] {
                field.frame.size.width = 310
                field.usesSingleLineMode = true
            }
            let grid = NSGridView(views: [
                [NSTextField(labelWithString: "API ID"), apiId],
                [NSTextField(labelWithString: "API Hash"), apiHash],
                [NSTextField(labelWithString: "Forum chat ID"), chatId],
                [NSTextField(labelWithString: "허용 사용자 ID"), allowed]
            ])
            grid.rowSpacing = 8
            grid.columnSpacing = 12
            grid.column(at: 0).xPlacement = .trailing
            grid.column(at: 1).xPlacement = .fill
            grid.frame = NSRect(x: 0, y: 0, width: 430, height: 116)

            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = "ChatKJB Terminal 최초 설정"
            alert.informativeText = "앱에는 비밀을 넣지 않습니다. 이 Mac의 Application Support에만 0600 권한으로 저장합니다."
            alert.accessoryView = grid
            alert.addButton(withTitle: "저장하고 계속")
            alert.addButton(withTitle: "종료")
            guard alert.runModal() == .alertFirstButtonReturn else {
                throw ShellError.invalidConfiguration("사용자가 최초 설정을 취소했습니다.")
            }
            do {
                let values = try SetupValues.parse(
                    apiId: apiId.stringValue,
                    apiHash: apiHash.stringValue,
                    chatId: chatId.stringValue,
                    allowedUserIds: allowed.stringValue
                )
                try ConfigurationStore.write(values, to: environmentURL)
                return
            } catch {
                let failure = NSAlert()
                failure.alertStyle = .warning
                failure.messageText = "설정값을 확인해 주십시오"
                failure.informativeText = "API ID·사용자 ID는 양수, forum chat ID는 음수, API Hash는 32자리 16진수여야 합니다."
                failure.runModal()
            }
        }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(logOut) || menuItem.action == #selector(reload) { return ready }
        return true
    }

    @objc private func reload() {
        guard ready else { return }
        webView.reloadFromOrigin()
    }

    @objc private func closeWindow() {
        window.performClose(nil)
    }

    @objc private func logOut() {
        guard ready else { return }
        webView.callAsyncJavaScript(
            "return await window.chatkjbNativeLogout();",
            arguments: [:],
            in: nil,
            in: .page
        ) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value) where (value as? Bool) == true:
                    NSApp.terminate(nil)
                default:
                    self?.showAlert("Telegram 로그아웃을 완료하지 못했습니다. 앱은 계속 열려 있습니다.")
                }
            }
        }
    }

    private func launchBackend(_ runtime: RuntimeConfig) throws {
        var descriptor: Int32 = -1
        var pid: pid_t = 0
        let result = runtime.supervisorURL.path.withCString { supervisorPath in
            runtime.nodeURL.path.withCString { nodePath in
                runtime.backendURL.path.withCString { entryPath in
                    runtime.workingDirectoryURL.path.withCString { workingDirectory in
                        chatkjbSpawnBackend(
                            supervisorPath,
                            nodePath,
                            entryPath,
                            workingDirectory,
                            &descriptor,
                            &pid
                        )
                    }
                }
            }
        }
        guard result == 0, descriptor >= 3, pid > 1 else {
            throw ShellError.invalidRuntime("GUI 백엔드 프로세스를 만들지 못했습니다.")
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        handle.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.controlQueue.async { self?.consumeControlData(data) }
        }
        let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in self?.reapUnexpectedBackend(pid) }
        source.resume()
        controlHandle = handle
        backendPid = pid
        backendSource = source
        startupTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            guard let self, !self.backendReady else { return }
            self.smokeDiagnostic("STARTUP_TIMEOUT")
            self.failAndTerminate("GUI 백엔드 시작 시간이 초과되었습니다. 외장 볼륨을 사용한다면 macOS 파일 접근 권한을 확인해 주십시오.")
        }
    }

    private func consumeControlData(_ data: Data) {
        guard !controlProtocolRejected else { return }
        if data.isEmpty {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.terminating, self.backendPid != nil else { return }
                self.smokeDiagnostic("CONTROL_EOF")
                self.failAndTerminate("백엔드 제어 연결이 닫혔습니다.")
            }
            return
        }
        controlBuffer.append(data)
        guard controlBuffer.count <= 65_536 else {
            rejectControl("CONTROL_OVERSIZE", "백엔드 제어 메시지가 너무 큽니다.")
            return
        }
        while let newline = controlBuffer.firstIndex(of: 0x0a) {
            let line = controlBuffer.prefix(upTo: newline)
            controlBuffer.removeSubrange(...newline)
            guard !line.isEmpty, line.count <= 16_384 else {
                rejectControl("CONTROL_LINE_INVALID", "백엔드 제어 메시지가 올바르지 않습니다.")
                return
            }
            guard
                let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                let type = object["type"] as? String
            else {
                rejectControl("CONTROL_JSON_INVALID", "백엔드 제어 메시지가 올바르지 않습니다.")
                return
            }
            DispatchQueue.main.async { [weak self] in self?.handleControlEvent(type: type, object: object) }
        }
    }

    private func rejectControl(_ diagnostic: String, _ message: String) {
        guard !controlProtocolRejected else { return }
        controlProtocolRejected = true
        controlBuffer.removeAll(keepingCapacity: false)
        DispatchQueue.main.async { [weak self] in
            self?.smokeDiagnostic(diagnostic)
            self?.failAndTerminate(message)
        }
    }

    private func rejectControlEvent(_ diagnostic: String = "CONTROL_EVENT_INVALID") {
        smokeDiagnostic(diagnostic)
        failAndTerminate("백엔드 제어 메시지가 올바르지 않습니다.")
    }

    private func handleControlEvent(type: String, object: [String: Any]) {
        switch type {
        case "heartbeat":
            guard Set(object.keys) == Set(["type"]) else {
                rejectControlEvent("CONTROL_HEARTBEAT_INVALID")
                return
            }
            return
        case "ready":
            guard
                Set(object.keys) == Set(["type", "origin", "bootstrapUrl"]),
                !backendReady,
                let originValue = object["origin"] as? String,
                let bootstrap = object["bootstrapUrl"] as? String,
                let url = verifiedBootstrapURL(bootstrap),
                originValue == "http://127.0.0.1:\(url.port!)"
            else {
                smokeDiagnostic("READY_INVALID")
                failAndTerminate("백엔드 준비 정보가 올바르지 않습니다.")
                return
            }
            allowedOrigin = (url.scheme!, url.host!, url.port!)
            bootstrapURL = url
            startupTimer?.invalidate()
            startupTimer = nil
            backendReady = true
            statusLabel.stringValue = "터미널 화면을 준비하는 중입니다…"
            pageTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
                guard let self, !self.ready else { return }
                self.smokeDiagnostic("PAGE_TIMEOUT")
                self.failAndTerminate("터미널 화면을 불러오지 못했습니다. 앱을 다시 열어 주십시오.")
            }
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
        case "qr":
            guard Set(object.keys) == Set(["type", "token", "expiresAt"]) else {
                rejectControlEvent("CONTROL_QR_KEYS_INVALID")
                return
            }
            guard let token = object["token"] as? String else {
                rejectControlEvent("CONTROL_QR_TOKEN_TYPE_INVALID")
                return
            }
            guard token.range(of: "^[A-Za-z0-9_-]{46}$", options: .regularExpression) != nil else {
                rejectControlEvent("CONTROL_QR_TOKEN_CHARACTERS_INVALID")
                return
            }
            let standardToken = token.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "/") + "=="
            guard
                let decodedToken = Data(base64Encoded: standardToken),
                decodedToken.count == 34,
                decodedToken.base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "") == token
            else { rejectControlEvent("CONTROL_QR_ENCODING_INVALID"); return }
            guard let expiresAt = object["expiresAt"] as? NSNumber else {
                rejectControlEvent("CONTROL_QR_EXPIRY_TYPE_INVALID")
                return
            }
            let nowMilliseconds = Date().timeIntervalSince1970 * 1_000
            guard
                expiresAt.doubleValue > nowMilliseconds - 1_000,
                expiresAt.doubleValue < nowMilliseconds + 600_000
            else { rejectControlEvent("CONTROL_QR_EXPIRY_RANGE_INVALID"); return }
            showQrCode(token: token, expiresAt: expiresAt.doubleValue)
        case "auth_state":
            let allowedStates: Set<String> = [
                "signed_out", "connecting", "waiting_qr", "waiting_password",
                "ready", "reconnecting", "error"
            ]
            let keys = Set(object.keys)
            guard
                keys.isSubset(of: Set(["type", "state", "errorCode"])),
                keys.contains("type"),
                keys.contains("state"),
                let state = object["state"] as? String,
                allowedStates.contains(state),
                object["errorCode"] == nil || (
                    (object["errorCode"] as? String)?.range(
                        of: "^[A-Z][A-Z0-9_]{1,63}$",
                        options: .regularExpression
                    ) != nil
                )
            else { rejectControlEvent("CONTROL_AUTH_INVALID"); return }
            if state != "waiting_qr" { closeQrPanel() }
            if smokeTest && (state == "signed_out" || state == "ready") {
                smokeAuthReady = true
                FileHandle.standardOutput.write(Data("CHATKJB_GUI_SMOKE_AUTH_\(state.uppercased())\n".utf8))
                completeSmokeIfReady()
            }
        case "fatal":
            guard
                Set(object.keys) == Set(["type", "code"]),
                let code = object["code"] as? String,
                code.range(of: "^[A-Z][A-Z0-9_]{1,63}$", options: .regularExpression) != nil
            else { rejectControlEvent("CONTROL_FATAL_INVALID"); return }
            smokeDiagnostic("BACKEND_FATAL")
            failAndTerminate("Telegram 사용자 연결을 시작하지 못했습니다.")
        default:
            rejectControlEvent("CONTROL_EVENT_UNKNOWN")
        }
    }

    private func verifiedBootstrapURL(_ value: String) -> URL? {
        guard
            value.count <= 512,
            let url = URL(string: value),
            url.scheme == "http",
            url.host == "127.0.0.1",
            let port = url.port,
            (1...65_535).contains(port),
            url.user == nil,
            url.password == nil,
            url.path == "/bootstrap",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            components.queryItems?.count == 1,
            let capability = components.queryItems?.first,
            capability.name == "cap",
            capability.value?.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { return nil }
        return url
    }

    private func isAllowedOrigin(_ url: URL?) -> Bool {
        guard let url, let origin = allowedOrigin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    private func showQrCode(token: String, expiresAt: Double) {
        closeQrPanel()
        let value = "tg://login?token=\(token)"
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return }
        filter.setValue(Data(value.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard
            let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
            let cgImage = CIContext().createCGImage(output, from: output.extent)
        else { return }

        let imageView = NSImageView(frame: NSRect(x: 24, y: 24, width: 350, height: 350))
        imageView.image = NSImage(cgImage: cgImage, size: NSSize(width: 350, height: 350))
        imageView.imageScaling = .scaleProportionallyUpOrDown
        let panel = qrPanel ?? NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 398, height: 398),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = "Telegram QR 로그인"
        panel.level = .floating
        panel.contentView = imageView
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        window.addChildWindow(panel, ordered: .above)
        qrPanel = panel
        qrExpiryTimer = Timer.scheduledTimer(
            withTimeInterval: max(0.1, expiresAt / 1_000 - Date().timeIntervalSince1970),
            repeats: false
        ) { [weak self] _ in self?.closeQrPanel() }
    }

    private func closeQrPanel() {
        qrExpiryTimer?.invalidate()
        qrExpiryTimer = nil
        guard let panel = qrPanel else { return }
        window?.removeChildWindow(panel)
        panel.orderOut(nil)
        qrPanel = nil
    }

    private func stopBackend() {
        startupTimer?.invalidate()
        startupTimer = nil
        pageTimer?.invalidate()
        pageTimer = nil
        controlHandle?.readabilityHandler = nil
        try? controlHandle?.close()
        controlHandle = nil
        backendSource?.cancel()
        backendSource = nil
        guard let pid = backendPid else { return }
        backendPid = nil
        let processGroup = -pid
        _ = kill(processGroup, SIGTERM)
        let deadline = Date().addingTimeInterval(5)
        var status: Int32 = 0
        var reaped = waitpid(pid, &status, WNOHANG) == pid
        while !reaped && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
            reaped = waitpid(pid, &status, WNOHANG) == pid
        }
        if !reaped {
            _ = kill(processGroup, SIGKILL)
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        }
    }

    private func reapUnexpectedBackend(_ pid: pid_t) {
        guard backendPid == pid else { return }
        backendSource?.cancel()
        backendSource = nil
        controlHandle?.readabilityHandler = nil
        try? controlHandle?.close()
        controlHandle = nil
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
        terminateRemainingProcessGroup(pid)
        backendPid = nil
        backendStoppedUnexpectedly()
    }

    private func terminateRemainingProcessGroup(_ groupLeader: pid_t) {
        let processGroup = -groupLeader
        if kill(processGroup, 0) == -1 && errno == ESRCH { return }
        _ = kill(processGroup, SIGTERM)
        let deadline = Date().addingTimeInterval(5)
        while Date() < deadline {
            if kill(processGroup, 0) == -1 && errno == ESRCH { return }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        _ = kill(processGroup, SIGKILL)
    }

    private func backendStoppedUnexpectedly() {
        guard !unexpectedFailureShown else { return }
        unexpectedFailureShown = true
        ready = false
        closeQrPanel()
        failAndTerminate("ChatKJB 백엔드가 종료되었습니다. 앱을 다시 열어 주십시오.")
    }

    private func failAndTerminate(_ message: String) {
        guard !terminating else { return }
        terminating = true
        showAlert(message)
        NSApp.terminate(nil)
    }

    private func showAlert(_ message: String) {
        guard !noninteractive else { return }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "ChatKJB Terminal"
        alert.informativeText = message
        alert.runModal()
    }

    private func smokeDiagnostic(_ code: String) {
        guard smokeTest || diagnosticTest else { return }
        FileHandle.standardOutput.write(Data("CHATKJB_GUI_SMOKE_\(code)\n".utf8))
    }

    private func completeSmokeIfReady() {
        guard smokeTest, smokePageReady, smokeAuthReady else { return }
        FileHandle.standardOutput.write(Data("CHATKJB_GUI_SMOKE_READY\n".utf8))
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) {
        cancelPendingDownloadDestinations()
        NSApp.terminate(nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isAllowedOrigin(webView.url), webView.url?.path == "/", webView.url?.query == nil else { return }
        pageTimer?.invalidate()
        pageTimer = nil
        ready = true
        statusLabel.isHidden = true
        guard smokeTest, !smokeValidationStarted else { return }
        smokeValidationStarted = true
        webView.evaluateJavaScript(
            """
            (() => {
              const shell = document.querySelector("#app-shell");
              const terminal = document.querySelector("#terminal");
              const composer = document.querySelector("#composer");
              const viewport = document.querySelector("#message-viewport");
              const rect = shell?.getBoundingClientRect();
              const style = shell ? getComputedStyle(shell) : null;
              return Boolean(
                shell && terminal && composer && viewport && rect && style
                && rect.width >= 700 && rect.height >= 500
                && terminal.getBoundingClientRect().width > 400
                && viewport.getBoundingClientRect().height > 100
                && style.display !== "none" && style.visibility !== "hidden"
              );
            })();
            """
        ) { [weak self] value, error in
            DispatchQueue.main.async {
                if error == nil, (value as? Bool) == true {
                    self?.smokePageReady = true
                    self?.completeSmokeIfReady()
                } else {
                    self?.smokeDiagnostic("DOM_INVALID")
                    NSApp.terminate(nil)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleWebFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleWebFailure(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        smokeDiagnostic("WEB_CONTENT_TERMINATED")
        failAndTerminate("터미널 화면 프로세스가 종료되었습니다. 앱을 다시 열어 주십시오.")
    }

    private func handleWebFailure(_ error: Error) {
        let failure = error as NSError
        if failure.domain == NSURLErrorDomain && failure.code == NSURLErrorCancelled { return }
        smokeDiagnostic("NAVIGATION_FAILED")
        failAndTerminate("터미널 화면을 불러오지 못했습니다. 앱을 다시 열어 주십시오.")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        if navigationAction.shouldPerformDownload,
           navigationAction.navigationType == .linkActivated,
           url?.scheme == "blob" {
            decisionHandler(.download)
            return
        }
        if let url, bootstrapURL == url {
            bootstrapURL = nil
            decisionHandler(.allow)
            return
        }
        if isAllowedOrigin(url), url?.path == "/", url?.query == nil {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated,
           let url,
           url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if isAllowedOrigin(url) { webView.load(navigationAction.request) }
        else if navigationAction.navigationType == .linkActivated,
                url.scheme == "http" || url.scheme == "https" { NSWorkspace.shared.open(url) }
        return nil
    }

    // WKWebView는 이 델리게이트가 없으면 window.alert/confirm을 조용히 무시한다.
    // 토픽 삭제 등 확인 대화상자가 바로 false가 되어 동작하지 않던 원인이었다.
    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        if noninteractive {
            completionHandler()
            return
        }
        let alert = NSAlert()
        alert.messageText = "ChatKJB Terminal"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window) { _ in
            completionHandler()
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        if noninteractive {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = "확인"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let forbidden = CharacterSet.controlCharacters.union(CharacterSet(
            charactersIn: "/\\:\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"
        ))
        let normalized = suggestedFilename.precomposedStringWithCanonicalMapping
        let cleaned = normalized.unicodeScalars.map { forbidden.contains($0) ? "-" : String($0) }.joined()
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        let safeName = trimmed.isEmpty || trimmed == "." || trimmed == ".."
            ? "ChatKJB-download"
            : String(trimmed.prefix(180))
        let panel = NSSavePanel()
        panel.nameFieldStringValue = safeName
        let identifier = ObjectIdentifier(download)
        var completed = false
        let finish: (URL?) -> Void = { [weak self] destination in
            guard !completed else { return }
            completed = true
            self?.pendingDownloadDestinations.removeValue(forKey: identifier)
            completionHandler(destination)
        }
        guard let parentWindow = window else {
            finish(nil)
            return
        }
        pendingDownloadDestinations[identifier] = finish
        panel.beginSheetModal(for: parentWindow) { response in
            finish(response == .OK ? panel.url : nil)
        }
    }

    private func cancelPendingDownloadDestinations() {
        let completions = Array(pendingDownloadDestinations.values)
        pendingDownloadDestinations.removeAll()
        for completion in completions {
            completion(nil)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        pendingDownloadDestinations.removeValue(forKey: ObjectIdentifier(download))?(nil)
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        pendingDownloadDestinations.removeValue(forKey: ObjectIdentifier(download))?(nil)
        downloads.removeValue(forKey: ObjectIdentifier(download))
        showAlert("파일 다운로드를 완료하지 못했습니다.")
    }
}

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--config-self-test" {
    do {
        try ConfigurationStore.runSelfTest(root: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
        FileHandle.standardOutput.write(Data("CHATKJB_GUI_CONFIG_SELF_TEST_OK\n".utf8))
        exit(0)
    } catch {
        exit(1)
    }
} else if CommandLine.arguments.count == 5 && CommandLine.arguments[1] == "--backend-supervisor" {
    let result = CommandLine.arguments[2].withCString { nodePath in
        CommandLine.arguments[3].withCString { entryPath in
            CommandLine.arguments[4].withCString { workingDirectory in
                chatkjbRunBackendSupervisor(nodePath, entryPath, workingDirectory, 3)
            }
        }
    }
    exit(result)
} else {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    application.run()
}
