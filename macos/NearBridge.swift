import AppKit
import Foundation
import SwiftUI
import Carbon

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var service: Process?
    private var logHandle: FileHandle?
    private let baseURL = URL(string: "http://127.0.0.1:53318")!
    private var openAfterStart = !CommandLine.arguments.contains("--background")
    private var window: NSWindow?
    private var contextMenu: NSMenu!
    private var hotKey: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var discovery: NetService?
    private let model = BridgeModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        setupMainMenu()
        if let other = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "local.nearbridge.mac").first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
            other.activate(options: []); NSApp.terminate(nil); return
        }
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = NSImage(systemSymbolName: "arrow.left.arrow.right", accessibilityDescription: "NearBridge")
        statusItem.button?.title = " NB"
        statusItem.button?.toolTip = "NearBridge · Mac 与鸿蒙互联"
        let menu = NSMenu()
        add("打开 NearBridge", action: #selector(openDashboard), to: menu, key: "o")
        add("发送文件…", action: #selector(sendFiles), to: menu)
        add("发送 Mac 剪贴板到手机", action: #selector(sendClipboard), to: menu)
        add("打开收件目录", action: #selector(openInbox), to: menu)
        menu.addItem(NSMenuItem.separator())
        add("重启连接服务", action: #selector(restartService), to: menu)
        add("查看运行日志", action: #selector(openLog), to: menu)
        add("网页备用入口", action: #selector(openWeb), to: menu)
        menu.addItem(NSMenuItem.separator())
        add("退出 NearBridge", action: #selector(quit), to: menu, key: "q")
        contextMenu = menu
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusClicked)
        statusItem.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        NSApp.servicesProvider = self
        NSUpdateDynamicServices()
        registerHotKey()
        model.onChange = { [weak self] in
            guard let self else { return }
            self.statusItem.button?.toolTip = "NearBridge · \(self.model.connection)"
        }
        model.start()
        checkExisting()
    }

    private func add(_ title: String, action: Selector, to menu: NSMenu, key: String = "") {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        menu.addItem(item)
    }

    private var dataDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/NearBridge")
    }

    private func checkExisting() {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["app"] as? String == "NearBridge" {
                    self.publishDiscovery()
                    if self.openAfterStart { self.openDashboard() }
                } else { self.startService() }
            }
        }.resume()
    }

    private func startService() {
        guard let bridge = Bundle.main.resourceURL?.appendingPathComponent("bridge") else { return }
        let candidates = [Bundle.main.resourceURL?.appendingPathComponent("node").path ?? "", "/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            alert("没有找到 Node.js", "这个自用版本需要 Node.js 22 或以上。源码目录中的 README 有启动说明。")
            return
        }
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let logURL = dataDirectory.appendingPathComponent("mac-app.log")
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            logHandle = try FileHandle(forWritingTo: logURL)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [bridge.appendingPathComponent("src/main.mjs").path]
            process.currentDirectoryURL = bridge
            process.standardOutput = logHandle
            process.standardError = logHandle
            process.terminationHandler = { [weak self] task in
                DispatchQueue.main.async {
                    guard let self, self.service === task else { return }
                    self.service = nil
                    self.statusItem.button?.title = " NB !"
                    if task.terminationStatus != 0 { self.alert("连接服务没有启动", "可能已有服务占用端口。可以从菜单查看日志；现有收件记录不会被删除。") }
                }
            }
            service = process
            try process.run()
            waitForService(attempt: 0)
        } catch { alert("启动失败", error.localizedDescription) }
    }

    private func waitForService(attempt: Int) {
        guard attempt < 25 else { alert("服务启动时间较长", "请从菜单查看运行日志。首次启动会生成本地 HTTPS 证书。"); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self else { return }
            URLSession.shared.dataTask(with: self.baseURL.appendingPathComponent("health")) { [weak self] data, _, _ in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any], object["app"] as? String == "NearBridge" {
                        self.statusItem.button?.title = " NB"
                        self.publishDiscovery()
                        if self.openAfterStart { self.openAfterStart = false; self.openDashboard() }
                    } else { self.waitForService(attempt: attempt + 1) }
                }
            }.resume()
        }
    }

    private func post(_ route: String, completion: (() -> Void)? = nil) {
        var request = URLRequest(url: URL(string: route, relativeTo: baseURL)!)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "X-NearBridge")
        request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) { completion?(); return }
                let object = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                self.alert("操作未完成", object?["error"] as? String ?? error?.localizedDescription ?? "请确认连接服务正在运行。")
            }
        }.resume()
    }

    @objc private func openDashboard() {
        if window == nil {
            let view = NSHostingView(rootView: BridgeView(model: model))
            view.sizingOptions = []
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 690), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            created.title = "NearBridge"
            created.contentView = view
            created.isReleasedWhenClosed = false
            created.minSize = NSSize(width: 700, height: 610)
            created.setFrameAutosaveName("NearBridgeNativeWindow")
            created.center()
            window = created
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { await model.refresh() }
    }
    @objc private func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            if let button = statusItem.button { contextMenu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 4), in: button) }
        } else { openDashboard() }
    }
    @objc private func sendFiles() { openDashboard(); model.chooseFiles() }
    @objc private func openWeb() { NSWorkspace.shared.open(baseURL) }
    @objc private func sendClipboard() { openDashboard(); model.sendClipboard() }
    @objc private func openInbox() { post("/api/mac/inbox") }
    @objc private func openLog() { NSWorkspace.shared.open(dataDirectory.appendingPathComponent("mac-app.log")) }
    @objc private func restartService() {
        guard let task = service else {
            alert("当前服务由终端或另一个实例启动", "请从原启动位置停止服务，再重新打开 NearBridge。这个菜单不会结束其他进程。")
            return
        }
        service = nil
        if task.isRunning {
            task.terminationHandler = { [weak self] _ in
                DispatchQueue.main.async { self?.logHandle?.closeFile(); self?.startService() }
            }
            task.terminate()
        } else { logHandle?.closeFile(); startService() }
    }
    @objc private func quit() { NSApp.terminate(nil) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { openDashboard(); return true }
    func application(_ application: NSApplication, open urls: [URL]) { openDashboard(); model.enqueue(urls) }
    @objc func sendToPhone(_ pasteboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString?>) {
        openDashboard()
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty { model.enqueue(urls) }
        else if let text = pasteboard.string(forType: .string) { model.draft = text; model.sendText() }
    }
    private func registerHotKey() {
        var event = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, context -> OSStatus in
            guard let context else { return OSStatus(eventNotHandledErr) }
            let delegate = Unmanaged<AppDelegate>.fromOpaque(context).takeUnretainedValue()
            DispatchQueue.main.async { delegate.openDashboard() }
            return noErr
        }, 1, &event, Unmanaged.passUnretained(self).toOpaque(), &eventHandler)
        let status = RegisterEventHotKey(49, UInt32(controlKey | optionKey), EventHotKeyID(signature: 0x4E425247, id: 1), GetApplicationEventTarget(), 0, &hotKey)
        if status != noErr { model.showNotice("全局快捷键被占用，可从菜单栏打开 NearBridge") }
    }
    private func setupMainMenu() {
        let main = NSMenu()
        let appMenu = NSMenu(title: "NearBridge")
        let servicesMenu = NSMenu(title: "服务")
        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        servicesItem.submenu = servicesMenu; appMenu.addItem(servicesItem); NSApp.servicesMenu = servicesMenu
        appMenu.addItem(.separator())
        add("退出 NearBridge", action: #selector(quit), to: appMenu, key: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)
        let file = NSMenu(title: "文件")
        add("发送文件…", action: #selector(sendFiles), to: file, key: "o")
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let fileItem = NSMenuItem(); fileItem.submenu = file; main.addItem(fileItem)
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)
        NSApp.mainMenu = main
    }
    private func publishDiscovery() {
        guard discovery == nil else { return }
        let service = NetService(domain: "local.", type: "_nearbridge._tcp.", name: Host.current().localizedName ?? "NearBridge Mac", port: 53320)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        service.setTXTRecord(NetService.data(fromTXTRecord: ["version": Data(version.utf8)]))
        service.publish()
        discovery = service
    }
    func applicationWillTerminate(_ notification: Notification) {
        model.stop()
        discovery?.stop()
        if let hotKey { UnregisterEventHotKey(hotKey) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
        service?.terminationHandler = nil
        if service?.isRunning == true { service?.terminate() }
        logHandle?.closeFile()
    }
    private func alert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "知道了")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

@main struct NearBridgeMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
