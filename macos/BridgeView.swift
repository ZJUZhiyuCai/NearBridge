import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct BridgeView: View {
    @ObservedObject var model: BridgeModel
    @State private var dragOver = false
    @State private var filter = "all"
    @State private var search = ""
    @State private var revoke = false
    @State private var discardAction = false
    @State private var webPairingRequested = false
    @State private var addedShortcuts: Set<String> = []
    @State private var addingShortcuts: Set<String> = []
    @State private var shortcutSearch = ""

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(spacing: 0) {
                if let pending = model.state?.pending { pairingBanner(pending) }
                if (model.pendingAction != nil || model.actionStorageError), !model.actionSending {
                    HStack(spacing: 12) {
                        Text(model.actionStorageError ? "无法读取待确认操作" : model.pendingAction!.label).font(.system(size: 13))
                        Spacer()
                        Button("重试确认") { model.retryPendingAction() }.disabled(model.actionStorageError)
                        Button("结束重试") { discardAction = true }
                    }
                    .padding(14).background(NB.blue.opacity(0.08))
                }
                Group {
                    switch currentTab {
                    case "workflow": workflowPane
                    case "device": devicePane
                    default: transferPane
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(NB.canvas)
            .overlay(alignment: .bottom) { toast }
        }
        .frame(minWidth: 760, minHeight: 540)
        .tint(NB.blue)
        .onDrop(of: [UTType.fileURL], isTargeted: $dragOver) { model.acceptDrop($0) }
        .overlay { if dragOver { dropOverlay } }
        .animation(.easeOut(duration: 0.18), value: dragOver)
        .animation(.easeOut(duration: 0.25), value: model.state?.pending?.id)
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: model.notice)
        .animation(.easeOut(duration: 0.25), value: activeQueue.count)
        .alert("操作未完成", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("知道了", role: .cancel) { model.error = nil }
        } message: { Text(model.error ?? "") }
        .confirmationDialog("结束重试不会撤销已经执行的操作。请先检查结果；再次点按将发起新操作。", isPresented: $discardAction, titleVisibility: .visible) {
            Button("已检查，结束重试", role: .destructive) { model.discardPendingAction() }
        }
        .sheet(isPresented: $model.showingShortcuts) { shortcutsSheet }
        .sheet(isPresented: $model.showingNativePairing) { nativePairingSheet }
        .task(id: model.notice) {
            guard model.notice != nil else { return }
            try? await Task.sleep(nanoseconds: 2_800_000_000)
            if !Task.isCancelled { model.notice = nil }
        }
    }

    // MARK: - Derived state

    private enum Presence { case starting, unavailable, unpaired, online, away }

    private var presence: Presence {
        guard let state = model.state else { return .starting }
        if !model.serviceAvailable { return .unavailable }
        if !state.paired { return .unpaired }
        return state.device?.connected == true ? .online : .away
    }
    private var paired: Bool { model.state?.paired == true }
    private var phoneName: String { model.state?.device?.name ?? "手机" }
    private var version: String { model.state?.version ?? "" }
    private var currentTab: String { ["workflow", "device"].contains(model.tab) ? model.tab : "transfer" }
    private var activeQueue: [QueuedFile] { model.queue.filter { $0.phase != "done" } }
    private var canSend: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.busy }

    private var presenceTitle: String {
        switch presence {
        case .starting: return "正在启动"
        case .unavailable: return "服务未连接"
        case .unpaired: return "未连接手机"
        case .online: return "已连接"
        case .away: return "不在线"
        }
    }
    private var presenceColor: Color {
        switch presence {
        case .online: return NB.blue
        case .unpaired, .unavailable: return NB.orange
        case .starting, .away: return Color.secondary.opacity(0.6)
        }
    }
    private var qrImage: NSImage? {
        guard let encoded = model.pairing?.qr?.components(separatedBy: ",").last, let data = Data(base64Encoded: encoded) else { return nil }
        return NSImage(data: data)
    }
    private var webQRImage: NSImage? {
        guard let encoded = model.webPairingInfo?.qr?.components(separatedBy: ",").last,
              let data = Data(base64Encoded: encoded) else { return nil }
        return NSImage(data: data)
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 3) {
            phoneCard.padding(.bottom, 12)
            sidebarRow(tab: "transfer", title: "互传", symbol: "arrow.up.arrow.down", tone: NB.tones[6], badge: activeQueue.count)
            sidebarRow(tab: "workflow", title: "快捷指令", symbol: "bolt.fill", tone: NB.flowTone, badge: 0)
            Spacer(minLength: 20)
            VStack(alignment: .leading, spacing: 6) {
                Label("加密直连", systemImage: "lock.fill")
                Label("⌃⌥空格 唤出窗口", systemImage: "keyboard")
                Text(version.isEmpty ? "NearBridge" : "NearBridge \(version)").foregroundStyle(.tertiary)
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 14)
        .frame(width: 216)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(NBVisualEffect())
    }

    private var phoneCard: some View {
        let selected = currentTab == "device"
        return Button { model.tab = "device" } label: {
            HStack(spacing: 10) {
                ZStack(alignment: .bottomTrailing) {
                    NBGlyphTile(symbol: paired ? "iphone.gen3" : "iphone.gen3.radiowaves.left.and.right", tone: NB.phoneTone, size: 38)
                    NBDot(color: selected && presence == .online ? .white : presenceColor, size: 11)
                        .overlay(Circle().stroke(selected ? NB.blue : Color(nsColor: .windowBackgroundColor), lineWidth: 2))
                        .offset(x: 3, y: 3)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(paired ? phoneName : "连接手机").font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(presenceTitle).font(.system(size: 11)).opacity(0.75).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? NB.blue : Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(model.connection)
    }

    private func sidebarRow(tab: String, title: String, symbol: String, tone: NB.Tone, badge: Int) -> some View {
        let selected = currentTab == tab
        return Button { model.tab = tab } label: {
            HStack(spacing: 9) {
                NBGlyphTile(symbol: symbol, tone: tone, size: 22)
                Text(title).font(.system(size: 13, weight: .medium))
                Spacer(minLength: 4)
                if badge > 0 {
                    Text("\(badge)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(selected ? Color.white.opacity(0.25) : Color.primary.opacity(0.08), in: Capsule())
                }
            }
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(.horizontal, 7).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? NB.blue : Color.clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Shared pieces

    private func paneHeader<Trailing: View>(_ title: String, subtitle: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 26, weight: .bold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 12)
            trailing()
        }
        .padding(.horizontal, 24)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }

    private func pairingBanner(_ pending: PairRequest) -> some View {
        HStack(spacing: 14) {
            NBGlyphTile(symbol: "iphone.gen3.radiowaves.left.and.right", tone: NB.phoneTone, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(pending.name) 想连接这台 Mac").font(.system(size: 14, weight: .semibold))
                Text("确认是你自己的手机再允许。允许后可以互传，并运行你开放的快捷指令。")
                    .font(.callout).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 12)
            Button("拒绝") { model.action("/api/pair/reject", body: ["id": pending.id]) }.controlSize(.large)
            Button("允许") { model.action("/api/pair/approve", body: ["id": pending.id]) }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(NB.blue.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(NB.blue.opacity(0.3)))
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    @ViewBuilder private var toast: some View {
        if let notice = model.notice {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(NB.blue)
                Text(notice).font(.system(size: 13, weight: .medium)).lineLimit(2)
                Button { model.notice = nil } label: {
                    Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(NB.hairline))
            .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
            .padding(.bottom, currentTab == "transfer" && paired ? 72 : 22)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var dropOverlay: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous).fill(.ultraThinMaterial)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(NB.blue, style: StrokeStyle(lineWidth: 2.5, dash: [9, 6]))
            VStack(spacing: 14) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 92, height: 92)
                    .background(Circle().fill(NB.outgoing))
                    .shadow(color: NB.blue.opacity(0.4), radius: 16, y: 6)
                Text(paired ? "松手，发到 \(phoneName)" : "松手，交给 NearBridge").font(.system(size: 22, weight: .bold))
                Text(presence == .away ? "手机现在不在线，文件会先排队" : "支持多个文件；文件夹会自动打包为 ZIP")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(spacing: 12) {
            Text("\(number)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(NB.blue))
            Text(text).font(.system(size: 13))
        }
    }

    private var onboarding: some View {
        ScrollView {
            VStack(spacing: 22) {
                ZStack {
                    NBPulse().frame(width: 116, height: 116)
                    Circle().fill(NB.canvas).frame(width: 100, height: 100).shadow(color: .black.opacity(0.1), radius: 12, y: 4)
                    Image(systemName: "laptopcomputer.and.iphone").font(.system(size: 40, weight: .light)).foregroundStyle(NB.blue)
                }
                .frame(height: 200)
                VStack(spacing: 6) {
                    Text("连接你的手机").font(.system(size: 26, weight: .bold))
                    Text("配对一次，以后打开就能互传、遥控 Mac。").foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 13) {
                    step(1, "手机和这台 Mac 连同一个 Wi‑Fi")
                    step(2, "在手机 NearBridge 点“扫码连接”")
                    step(3, "扫这里的配对码，再回到 Mac 点“允许”")
                }
                .padding(18)
                .frame(width: 360, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(NB.card))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(NB.hairline))
                Button { model.nativePairing() } label: {
                    Label("显示配对码", systemImage: "qrcode").frame(minWidth: 170)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                webPairing
            }
            .padding(32)
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var webPairing: some View {
        if webPairingRequested, let image = webQRImage {
            VStack(spacing: 8) {
                Image(nsImage: image).resizable().interpolation(.none)
                    .frame(width: 180, height: 180)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white))
                Text("此二维码用于网页备用端。原生 App 请用“显示配对码”。").font(.caption).foregroundStyle(.secondary)
                Button("刷新二维码") { model.loadPairing(refresh: true) }.buttonStyle(.link)
            }
        } else {
            Button(webPairingRequested ? "正在获取网页备用端二维码…" : "使用网页备用端…") {
                webPairingRequested = true
                model.loadPairing()
            }
            .buttonStyle(.link)
        }
    }

    // MARK: - Transfer

    private var transferSubtitle: String {
        switch presence {
        case .starting, .unavailable: return model.connection
        case .unpaired: return "配对后，文件和文字在两台设备间只要一步"
        case .online: return "\(phoneName) 已连接 · 拖文件到窗口任意位置即可发送"
        case .away: return "\(phoneName) 不在线 · 发出的内容会排队，手机打开 NearBridge 后收取"
        }
    }

    private var transferPane: some View {
        VStack(spacing: 0) {
            paneHeader("互传", subtitle: transferSubtitle) { if paired { feedTools } }
            if !paired {
                onboarding
            } else {
                feed
                if !activeQueue.isEmpty { queueCard }
                composer
            }
        }
    }

    private var feedTools: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索", text: $search).textFieldStyle(.plain)
                if !search.isEmpty {
                    Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.plain).foregroundStyle(.tertiary)
                }
            }
            .font(.callout)
            .padding(.horizontal, 8).padding(.vertical, 5)
            .frame(width: 170)
            .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            Menu {
                Picker("显示", selection: $filter) {
                    Text("全部").tag("all")
                    Text("手机发来").tag("phone")
                    Text("Mac 发出").tag("mac")
                }
                .pickerStyle(.inline)
            } label: {
                Image(systemName: filter == "all" ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                    .font(.system(size: 15))
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("筛选记录")
            Button { model.action("/api/mac/inbox") } label: { Image(systemName: "folder").font(.system(size: 14)) }
                .buttonStyle(.borderless)
                .help("打开收件文件夹")
        }
    }

    private var feedItems: [BridgeItem] {
        (model.state?.items ?? [])
            .filter { item in
                (filter == "all" || item.source == filter)
                    && (search.isEmpty || (item.name ?? item.text ?? "").localizedCaseInsensitiveContains(search))
            }
            .sorted { $0.createdAt < $1.createdAt }
    }

    private var feed: some View {
        let items = feedItems
        return Group {
            if items.isEmpty {
                feedEmpty
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                                if index == 0 || NBTime.dayKey(items[index - 1].createdAt) != NBTime.dayKey(item.createdAt) {
                                    Text(NBTime.dayTitle(item.createdAt))
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(.secondary)
                                        .padding(.top, index == 0 ? 4 : 18)
                                        .padding(.bottom, 6)
                                }
                                NBMessageRow(item: item, phoneName: phoneName, model: model)
                            }
                            Color.clear.frame(height: 10).id("feed-bottom")
                        }
                        .padding(.vertical, 6)
                    }
                    .onAppear { proxy.scrollTo("feed-bottom", anchor: .bottom) }
                    .onChange(of: items.last?.id) { _ in
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("feed-bottom", anchor: .bottom) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var feedEmpty: some View {
        let filtered = !search.isEmpty || filter != "all"
        return VStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .strokeBorder(NB.blue.opacity(0.4), style: StrokeStyle(lineWidth: 1.5, dash: [6, 5]))
                    .frame(width: 150, height: 108)
                Image(systemName: filtered ? "magnifyingglass" : "tray.and.arrow.down.fill")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(NB.blue)
            }
            Text(filtered ? "没有找到匹配的记录" : "拖到这里，发到手机").font(.system(size: 18, weight: .semibold))
            if !filtered {
                Text("也可以在下方输入文字或发送剪贴板。\n手机发来的照片、文件和文字会出现在这里。")
                    .multilineTextAlignment(.center)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button("选择文件…") { model.chooseFiles() }.buttonStyle(.borderedProminent).controlSize(.large)
            }
        }
        .padding(30)
    }

    private var queueCard: some View {
        let active = activeQueue
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("准备发往手机").font(.system(size: 12, weight: .semibold))
                Text("\(active.count)").font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "info.circle")
                    .foregroundStyle(.tertiary)
                    .help("进度是交给本机 NearBridge 服务的进度；手机真正收到后，记录里会显示“手机已收取”。")
            }
            ScrollView {
                VStack(spacing: 8) { ForEach(active) { queueRow($0) } }
            }
            .frame(height: min(CGFloat(active.count) * 44 - 8, 140))
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(NB.hairline))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func queueStatus(_ item: QueuedFile) -> String {
        switch item.phase {
        case "failed": return item.error ?? "没发出去，可以重试"
        case "sending": return "准备中 \(Int((item.progress * 100).rounded()))% · \(byteString(item.offset)) / \(byteString(item.size))"
        case "paused": return "已暂停 · \(byteString(item.offset)) / \(byteString(item.size))"
        default: return item.error ?? "排队中 · \(byteString(item.size))"
        }
    }

    private func queueRow(_ item: QueuedFile) -> some View {
        HStack(spacing: 10) {
            NBRing(value: item.progress, failed: item.phase == "failed", paused: item.phase == "paused")
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.system(size: 12.5, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Text(queueStatus(item))
                    .font(.system(size: 11))
                    .foregroundStyle(item.phase == "failed" ? NB.orange : Color.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if item.phase == "sending" {
                roundIcon("pause.circle.fill", help: "暂停，保留进度") { model.pause(item.id) }
            } else {
                roundIcon(item.phase == "failed" ? "arrow.clockwise.circle.fill" : "play.circle.fill", help: item.phase == "failed" ? "重试" : "继续") { model.retry(item.id) }
                roundIcon("xmark.circle.fill", help: "取消待发文件") { model.cancel(item.id) }
            }
        }
        .frame(height: 36)
    }

    private func roundIcon(_ symbol: String, help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 19)).symbolRenderingMode(.hierarchical).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .help(help)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            Button { model.chooseFiles() } label: {
                Image(systemName: "plus")
                    .font(.system(size: 14, weight: .semibold))
                    .frame(width: 30, height: 30)
                    .background(Circle().fill(Color.primary.opacity(0.07)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help("选择文件…（⌘O）")
            .keyboardShortcut("o", modifiers: .command)

            TextField("发给 \(phoneName)", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 13.5))
                .lineLimit(1...6)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(NB.canvas))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.primary.opacity(0.14)))
                .onSubmit { if canSend { model.sendText() } }

            Button { model.sendClipboard() } label: {
                Label("剪贴板", systemImage: "doc.on.clipboard")
                    .font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 11)
                    .frame(height: 30)
                    .background(Capsule().fill(Color.primary.opacity(0.07)))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("把 Mac 剪贴板里的文字发到手机（只在点按时读取）")

            Button { model.sendText() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(canSend ? NB.blue : Color.secondary.opacity(0.35))
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .keyboardShortcut(.return, modifiers: .command)
            .help("发送（⌘↩）")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    // MARK: - Workflows

    private var workflowPane: some View {
        let flows = model.state?.workflows ?? []
        let jobs = Array((model.state?.jobs ?? []).prefix(8))
        return ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                paneHeader("快捷指令", subtitle: "手机上的按钮，Mac 上的动作") {
                    Button { model.loadShortcuts() } label: { Label("添加…", systemImage: "plus") }.controlSize(.large)
                }
                if flows.isEmpty {
                    workflowEmpty
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 196, maximum: 280), spacing: 16)], alignment: .leading, spacing: 18) {
                        ForEach(flows) { flow in NBWorkflowTile(flow: flow, model: model) }
                    }
                    .padding(.horizontal, 24)
                    .padding(.top, 4)
                }
                if !jobs.isEmpty {
                    Text("最近运行")
                        .font(.system(size: 15, weight: .semibold))
                        .padding(.horizontal, 24)
                        .padding(.top, 28)
                        .padding(.bottom, 8)
                    VStack(spacing: 0) {
                        ForEach(jobs) { job in
                            jobRow(job)
                            if job.id != jobs.last?.id { Divider().padding(.leading, 46) }
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(NB.card))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(NB.hairline))
                    .padding(.horizontal, 24)
                }
            }
            .padding(.bottom, 28)
        }
    }

    private var workflowEmpty: some View {
        VStack(spacing: 14) {
            HStack(spacing: -10) {
                NBGlyphTile(symbol: "camera.fill", tone: NB.tones[3], size: 54).rotationEffect(.degrees(-8))
                NBGlyphTile(symbol: "bolt.fill", tone: NB.tones[1], size: 64).zIndex(1)
                NBGlyphTile(symbol: "music.note", tone: NB.tones[5], size: 54).rotationEffect(.degrees(8))
            }
            .padding(.bottom, 6)
            Text("让手机一键指挥 Mac").font(.system(size: 18, weight: .semibold))
            Text("从“快捷指令”App 里挑几个，它们会变成手机首页上的彩色按钮。")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("添加快捷指令…") { model.loadShortcuts() }.buttonStyle(.borderedProminent).controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }

    private func jobLabel(_ status: String) -> String {
        switch status {
        case "succeeded": return "已完成"
        case "running": return "运行中"
        case "queued", "pending": return "等待中"
        case "failed": return "未完成"
        default: return status
        }
    }

    private func jobRow(_ job: WorkflowJob) -> some View {
        HStack(spacing: 12) {
            Group {
                switch job.status {
                case "succeeded": Image(systemName: "checkmark.circle.fill").foregroundStyle(NB.blue)
                case "running", "queued", "pending": ProgressView().controlSize(.small)
                default: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(NB.orange)
                }
            }
            .font(.system(size: 16))
            .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(job.name).font(.system(size: 13, weight: .medium))
                if let message = job.message, !message.isEmpty {
                    Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            Text(jobLabel(job.status)).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    // MARK: - Device

    private func tipRow(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 14, weight: .medium)).foregroundStyle(NB.blue).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
    }

    private var devicePane: some View {
        VStack(spacing: 0) {
            paneHeader("手机", subtitle: paired ? "\(phoneName) · 已配对" : "还没有配对的手机") { EmptyView() }
            if !paired {
                onboarding
            } else {
                Form {
                    Section {
                        HStack(spacing: 14) {
                            NBGlyphTile(symbol: "iphone.gen3", tone: NB.phoneTone, size: 52)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(phoneName).font(.system(size: 17, weight: .semibold))
                                HStack(spacing: 6) {
                                    NBDot(color: presenceColor)
                                    Text(presence == .unavailable ? "连接服务暂时不可用" : (presence == .online ? "已连接" : "不在线 · 手机打开 NearBridge 后自动连接"))
                                }
                                .font(.callout)
                                .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 6)
                        LabeledContent("连接详情") {
                            Text(model.connection).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                        }
                    }
                    Section {
                        Toggle("手机发来的文字，自动拷贝到 Mac 剪贴板", isOn: Binding(
                            get: { model.state?.settings?.copyIncomingText ?? false },
                            set: { model.action("/api/settings", body: ["copyIncomingText": $0]) }
                        ))
                    } header: { Text("接收") }
                    Section {
                        Toggle(isOn: Binding(get: { model.bluetoothEnabled }, set: { if $0 != model.bluetoothEnabled { model.toggleBluetooth() } })) {
                            HStack(spacing: 6) {
                                Text("允许手机用蓝牙连接")
                                NBBadge(text: "测试版")
                            }
                        }
                        .accessibilityLabel("允许手机用蓝牙连接")
                        LabeledContent("蓝牙状态") { Text(model.bluetoothStatus).foregroundStyle(.secondary) }
                    } header: {
                        Text("蓝牙直连")
                    } footer: {
                        Text("在手机的“连接与设置”里选择这台蓝牙 Mac。自动模式优先使用局域网，连不上时尝试蓝牙；选择“仅蓝牙”后所有内容只走蓝牙。蓝牙适合文字、快捷指令和小文件。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Section {
                        tipRow("hand.draw", "拖进窗口", "文件或文件夹都行，文件夹会自动打包为 ZIP")
                        tipRow("filemenu.and.cursorarrow", "Finder 右键 → 服务 → 发送到 NearBridge", "不打开窗口也能发")
                        tipRow("keyboard", "⌃⌥空格", "随时唤出 NearBridge 窗口")
                        tipRow("menubar.rectangle", "关掉窗口也不断开", "菜单栏继续保持连接")
                    } header: { Text("随手发送") }
                    Section {
                        Button("重新配对手机…") { model.nativePairing() }
                        DisclosureGroup("网页备用端") {
                            VStack(spacing: 8) {
                                Text("网页客户端仍可使用，原生 App 更顺手。").font(.caption).foregroundStyle(.secondary)
                                webPairing
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                        }
                    } header: {
                        Text("配对")
                    } footer: {
                        Text("重新配对会迁移当前配对并保留历史记录；旧网页会话将退出。").font(.caption).foregroundStyle(.secondary)
                    }
                    Section {
                        Button("解除配对…", role: .destructive) { revoke = true }
                    } footer: {
                        Text(version.isEmpty ? "NearBridge · 加密直连" : "NearBridge \(version) · 加密直连").font(.caption).foregroundStyle(.tertiary)
                    }
                }
                .formStyle(.grouped)
                .confirmationDialog("解除与 \(phoneName) 的配对？", isPresented: $revoke, titleVisibility: .visible) {
                    Button("解除配对", role: .destructive) { model.action("/api/device/revoke"); model.pairing = nil }
                    Button("取消", role: .cancel) { }
                } message: {
                    Text("解除后，手机将失去连接权限；已存到 Mac 的文件保留。")
                }
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Sheets

    private func expiryText(_ info: PairingInfo, now: Date) -> String {
        let raw = info.expiresAt
        guard raw > 1_000_000_000 else { return "配对码 5 分钟内有效" }
        let seconds = raw > 100_000_000_000 ? raw / 1000 : raw
        let left = Int(seconds - now.timeIntervalSince1970)
        if left <= 0 { return "配对码已过期，点“刷新”换一个" }
        return String(format: "%d:%02d 后失效", left / 60, left % 60)
    }

    private func miniStep(_ number: Int, _ text: String) -> some View {
        HStack(spacing: 6) {
            Text("\(number)")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 17, height: 17)
                .background(Circle().fill(NB.blue))
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
        }
    }

    private var nativePairingSheet: some View {
        VStack(spacing: 18) {
            if let pending = model.state?.pending {
                VStack(spacing: 14) {
                    ZStack {
                        NBPulse().frame(width: 92, height: 92)
                        NBGlyphTile(symbol: "iphone.gen3", tone: NB.phoneTone, size: 72)
                    }
                    .frame(height: 170)
                    Text("\(pending.name) 想连接这台 Mac").font(.system(size: 20, weight: .bold)).multilineTextAlignment(.center)
                    Text("确认是你自己的手机再允许。").foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button { model.action("/api/pair/reject", body: ["id": pending.id]) } label: { Text("拒绝").frame(minWidth: 90) }
                            .controlSize(.large)
                        Button {
                            Task {
                                if await model.action("/api/pair/approve", body: ["id": pending.id]).value {
                                    model.showingNativePairing = false
                                }
                            }
                        } label: { Text("允许连接").frame(minWidth: 110) }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.large)
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            } else {
                VStack(spacing: 4) {
                    Text("用手机扫一扫").font(.system(size: 22, weight: .bold))
                    Text("打开手机 NearBridge，点“扫码连接”").foregroundStyle(.secondary)
                }
                ZStack {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Color.white)
                        .shadow(color: .black.opacity(0.12), radius: 18, y: 6)
                    if let image = qrImage {
                        Image(nsImage: image).resizable().interpolation(.none).padding(18)
                    } else {
                        ProgressView().environment(\.colorScheme, .light)
                    }
                }
                .frame(width: 290, height: 290)
                if let info = model.pairing {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(expiryText(info, now: context.date)).font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 16) {
                    miniStep(1, "打开 App")
                    miniStep(2, "扫码")
                    miniStep(3, "在 Mac 点允许")
                }
                Text("确认后会迁移当前配对，保留历史记录；旧网页会话将退出。")
                    .font(.caption).foregroundStyle(.tertiary).multilineTextAlignment(.center)
            }
            HStack {
                Button("刷新") { model.nativePairing() }
                Spacer()
                Button("完成") { model.showingNativePairing = false }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(28)
        .frame(width: 440)
        .animation(.easeOut(duration: 0.25), value: model.state?.pending?.id)
    }

    private var shortcutsSheet: some View {
        let workflowIDs = Set((model.state?.workflows ?? []).map(\.id))
        let list = model.shortcuts.filter { shortcutSearch.isEmpty || $0.name.localizedCaseInsensitiveContains(shortcutSearch) }
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                NBGlyphTile(symbol: "bolt.fill", tone: NB.flowTone, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text("添加快捷指令").font(.system(size: 20, weight: .bold))
                    Text("添加后，它会成为手机上的一个按钮。").foregroundStyle(.secondary)
                }
            }
            if model.shortcuts.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "square.stack.3d.up").font(.system(size: 30, weight: .light)).foregroundStyle(.secondary)
                    Text("还没有快捷指令").font(.headline)
                    Text("先在 Mac 的“快捷指令”App 里创建一个，再回来添加。").font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 36)
            } else {
                HStack(spacing: 5) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索快捷指令", text: $shortcutSearch).textFieldStyle(.plain)
                }
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                List(list) { shortcut in
                    HStack(spacing: 10) {
                        NBGlyphTile(symbol: NB.symbol(forWorkflow: shortcut.name), tone: NB.tone(for: shortcut.id), size: 24)
                        Text(shortcut.name).lineLimit(1)
                        Spacer()
                        if addedShortcuts.contains(shortcut.id) || workflowIDs.contains("shortcut-\(shortcut.id)") {
                            Label("已添加", systemImage: "checkmark").labelStyle(.titleAndIcon).font(.callout).foregroundStyle(NB.blue)
                        } else {
                            Button(addingShortcuts.contains(shortcut.id) ? "添加中…" : "添加") {
                                addingShortcuts.insert(shortcut.id)
                                Task {
                                    if await model.action("/api/mac/workflows/shortcut", body: ["id": shortcut.id], success: "已添加“\(shortcut.name)”，手机上会出现这个按钮").value {
                                        addedShortcuts.insert(shortcut.id)
                                    }
                                    addingShortcuts.remove(shortcut.id)
                                }
                            }
                            .disabled(addingShortcuts.contains(shortcut.id))
                        }
                    }
                    .padding(.vertical, 3)
                }
                .listStyle(.inset)
                .frame(height: 280)
            }
            HStack {
                Button("打开“快捷指令”App") {
                    if let url = URL(string: "shortcuts://") { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(.link)
                Spacer()
                Button("完成") { model.showingShortcuts = false; shortcutSearch = "" }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 500)
    }
}

// MARK: - Message row

private struct NBMessageRow: View {
    let item: BridgeItem
    let phoneName: String
    let model: BridgeModel

    private var outgoing: Bool { item.source == "mac" }
    private var link: URL? { item.kind == "text" ? NB.isLink(item.text) : nil }
    private var bubble: RoundedRectangle { RoundedRectangle(cornerRadius: 18, style: .continuous) }
    private var bubbleFill: AnyShapeStyle { outgoing ? AnyShapeStyle(NB.outgoing) : AnyShapeStyle(NB.incoming) }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if outgoing { Spacer(minLength: 90) }
            VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
                content.contextMenu { menu }
                meta
            }
            if !outgoing { Spacer(minLength: 90) }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 5)
    }

    @ViewBuilder private var content: some View {
        if item.kind == "text" {
            if let url = link { linkCard(url) } else { textBubble }
        } else if let path = item.localPath, NB.isVisual(path) {
            visualCard(path)
        } else {
            fileCard
        }
    }

    private var textBubble: some View {
        Text(item.text ?? "")
            .font(.system(size: 13.5))
            .lineSpacing(2)
            .textSelection(.enabled)
            .foregroundStyle(outgoing ? Color.white : Color.primary)
            .padding(.horizontal, 13)
            .padding(.vertical, 8)
            .background(bubble.fill(bubbleFill))
            .frame(maxWidth: 440, alignment: outgoing ? .trailing : .leading)
    }

    private func linkCard(_ url: URL) -> some View {
        Button { openLink() } label: {
            HStack(spacing: 10) {
                Image(systemName: "globe")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(outgoing ? Color.white : NB.blue)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(outgoing ? Color.white.opacity(0.2) : NB.blue.opacity(0.12)))
                VStack(alignment: .leading, spacing: 2) {
                    Text(url.host ?? url.absoluteString).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(url.absoluteString).font(.system(size: 11)).opacity(0.75).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 4)
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .bold)).opacity(0.6)
            }
            .foregroundStyle(outgoing ? Color.white : Color.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(width: 320, alignment: .leading)
            .background(bubble.fill(bubbleFill))
            .contentShape(bubble)
        }
        .buttonStyle(.plain)
        .help("在 Mac 打开链接")
    }

    private func visualCard(_ path: String) -> some View {
        NBThumbnail(path: path, side: 360, fill: true)
            .frame(width: 240, height: 180)
            .background(NB.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(NB.hairline))
            .contentShape(Rectangle())
            .onTapGesture(count: 2) { open(path) }
            .onDrag { provider(path) }
            .help("\(item.name ?? "")\n双击打开，可直接拖到 Finder")
    }

    private var fileCard: some View {
        HStack(spacing: 11) {
            Group {
                if let path = item.localPath {
                    NBThumbnail(path: path, side: 64)
                } else {
                    Image(systemName: "doc.fill").font(.system(size: 26)).foregroundStyle(.secondary)
                }
            }
            .frame(width: 34, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name ?? "文件").font(.system(size: 13, weight: .medium)).lineLimit(2).truncationMode(.middle)
                if let size = item.size { Text(byteString(size)).font(.system(size: 11)).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(width: 280, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(NB.card))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(outgoing ? NB.blue.opacity(0.35) : NB.hairline))
        .contentShape(Rectangle())
        .onTapGesture(count: 2) {
            if let path = item.localPath { open(path) } else { model.reveal(item) }
        }
        .onDrag {
            if let path = item.localPath { return provider(path) }
            return NSItemProvider()
        }
        .help("双击打开，可直接拖到 Finder")
    }

    private var meta: some View {
        HStack(spacing: 8) {
            if outgoing {
                actions
                Text(NBTime.clock(item.createdAt))
                if item.receivedAt != nil {
                    Label("手机已收取", systemImage: "checkmark").labelStyle(.titleAndIcon).foregroundStyle(NB.blue)
                } else {
                    Text("等待手机收取")
                }
            } else {
                Text("\(phoneName) · \(NBTime.clock(item.createdAt))")
                if item.kind != "text", NB.isVisual(item.localPath), let size = item.size { Text(byteString(size)) }
                actions
            }
        }
        .font(.system(size: 11))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 6)
    }

    @ViewBuilder private var actions: some View {
        HStack(spacing: 8) {
            if item.kind == "text" {
                Button("拷贝") { copy() }
                if link != nil { Button("打开") { openLink() } }
            } else {
                if let path = item.localPath { Button("打开") { open(path) } }
                Button("在 Finder 中显示") { model.reveal(item) }
            }
        }
        .buttonStyle(.link)
        .font(.system(size: 11, weight: .medium))
    }

    @ViewBuilder private var menu: some View {
        if item.kind == "text" {
            Button("拷贝") { copy() }
            if link != nil { Button("在 Mac 打开链接") { openLink() } }
        } else {
            if let path = item.localPath {
                Button("打开") { open(path) }
                Button("拷贝文件") { copyFile(path) }
            }
            Button("在 Finder 中显示") { model.reveal(item) }
        }
    }

    private func copy() { model.action("/api/mac/clipboard/copy", body: ["id": item.id], success: "已拷贝到 Mac 剪贴板") }
    private func openLink() { model.action("/api/mac/open-link", body: ["id": item.id]) }
    private func open(_ path: String) { NSWorkspace.shared.open(URL(fileURLWithPath: path)) }
    private func provider(_ path: String) -> NSItemProvider { NSItemProvider(contentsOf: URL(fileURLWithPath: path)) ?? NSItemProvider() }
    private func copyFile(_ path: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([URL(fileURLWithPath: path) as NSURL])
        model.showNotice("文件已拷贝，可在 Finder 中粘贴")
    }
}

// MARK: - Workflow tile

private struct NBWorkflowTile: View {
    let flow: Workflow
    let model: BridgeModel
    @State private var hover = false

    var body: some View {
        let tone = NB.tone(for: flow.id)
        VStack(alignment: .leading, spacing: 9) {
            Button {
                model.runWorkflow(flow.id)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .top) {
                        Image(systemName: NB.symbol(forWorkflow: flow.name)).font(.system(size: 22, weight: .semibold))
                        Spacer()
                        Image(systemName: "play.fill")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(tone.bottom)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(Color.white.opacity(0.95)))
                    }
                    Spacer(minLength: 14)
                    Text(flow.name).font(.system(size: 15, weight: .semibold)).lineLimit(2).multilineTextAlignment(.leading)
                    Text(flow.description.isEmpty ? " " : flow.description)
                        .font(.system(size: 11.5)).opacity(0.85).lineLimit(2).multilineTextAlignment(.leading)
                }
                .foregroundStyle(.white)
                .padding(14)
                .frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
                .background(tone.gradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: tone.bottom.opacity(hover && flow.enabled ? 0.45 : 0.22), radius: hover ? 12 : 6, y: hover ? 6 : 3)
                .scaleEffect(hover && flow.enabled ? 1.02 : 1)
                .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!flow.enabled || model.actionSending)
            .saturation(flow.enabled ? 1 : 0.05)
            .opacity(flow.enabled ? 1 : 0.6)
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.18), value: hover)
            .help(flow.enabled ? "在 Mac 上运行一次" : "打开“手机可用”后才能运行")

            Toggle(isOn: Binding(get: { flow.enabled }, set: { model.action("/api/mac/workflows/enable", body: ["id": flow.id, "enabled": $0]) })) {
                Text("手机可用").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .toggleStyle(.switch)
            .controlSize(.mini)
            .accessibilityLabel("\(flow.name)，允许手机运行")
            .padding(.horizontal, 4)
            .help("打开后，这个按钮会出现在手机首页")
        }
    }
}
