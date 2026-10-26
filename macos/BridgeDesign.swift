import AppKit
import QuickLookThumbnailing
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Tokens

/// NearBridge 设计语言：系统蓝为主色，成功也用蓝色；不使用任何绿色。
enum NB {
    static let blue = Color(nsColor: .systemBlue)
    static let orange = Color(nsColor: .systemOrange)
    static let red = Color(nsColor: .systemRed)

    /// 信息 App 式的接收气泡灰。
    static let incoming = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedWhite: 0.23, alpha: 1)
            : NSColor(calibratedRed: 0.914, green: 0.914, blue: 0.922, alpha: 1)
    })
    static let outgoing = LinearGradient(colors: [rgb(0x3D94FF), rgb(0x0A72F5)], startPoint: .top, endPoint: .bottom)
    static let card = Color(nsColor: .controlBackgroundColor)
    static let canvas = Color(nsColor: .textBackgroundColor)
    static let hairline = Color.primary.opacity(0.09)

    struct Tone {
        let top: Color
        let bottom: Color
        var gradient: LinearGradient { LinearGradient(colors: [top, bottom], startPoint: .top, endPoint: .bottom) }
    }

    /// 与手机端 Theme.ets 的 TONES 顺序完全一致，同一快捷指令在两端同色。
    static let tones: [Tone] = [
        Tone(top: rgb(0x4DA3FF), bottom: rgb(0x0A6CFF)),
        Tone(top: rgb(0x7D7AFF), bottom: rgb(0x4C3FE0)),
        Tone(top: rgb(0xC77DFF), bottom: rgb(0x8A3FD9)),
        Tone(top: rgb(0xFF7EB3), bottom: rgb(0xF0407A)),
        Tone(top: rgb(0xFF8A70), bottom: rgb(0xEC4A3B)),
        Tone(top: rgb(0xFFB35C), bottom: rgb(0xFF7A00)),
        Tone(top: rgb(0x6CCBFF), bottom: rgb(0x1C8FE8)),
        Tone(top: rgb(0xA3A9B5), bottom: rgb(0x5F6673))
    ]
    static let phoneTone = tones[0]
    static let flowTone = tones[1]

    static func tone(for key: String) -> Tone { tones[stableHash(key) % tones.count] }

    /// h = (h * 31 + utf16) % 1000003，与手机端一致。
    static func stableHash(_ key: String) -> Int {
        var hash = 0
        for unit in key.utf16 { hash = (hash * 31 + Int(unit)) % 1_000_003 }
        return hash
    }

    /// 按名称关键词挑选快捷指令图标；关键词表与手机端 glyphFor 一致。
    static func symbol(forWorkflow name: String) -> String {
        let table: [(String, [String])] = [
            ("camera.fill", ["截图", "截屏", "拍", "相机", "照片"]),
            ("music.note", ["音乐", "播放", "歌", "音量", "静音", "声音"]),
            ("moon.fill", ["睡眠", "休眠", "勿扰", "专注", "晚安", "夜"]),
            ("lock.fill", ["锁", "离开"]),
            ("doc.text.fill", ["文档", "笔记", "备忘", "记录", "写"]),
            ("arrow.up.forward.app.fill", ["打开", "网页", "浏览", "链接", "启动"]),
            ("doc.on.clipboard.fill", ["剪贴板", "复制", "粘贴"]),
            ("arrow.down.circle.fill", ["下载", "保存", "备份"]),
            ("sun.max.fill", ["亮度", "灯", "屏幕", "显示器"])
        ]
        for (symbol, words) in table where words.contains(where: { name.contains($0) }) { return symbol }
        return "bolt.fill"
    }

    static func rgb(_ hex: UInt32) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    static func isLink(_ text: String?) -> URL? {
        guard let raw = text?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.contains(where: \.isWhitespace),
              let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        return url
    }

    static func isVisual(_ path: String?) -> Bool {
        guard let path = path, let type = UTType(filenameExtension: (path as NSString).pathExtension) else { return false }
        return type.conforms(to: .image) || type.conforms(to: .movie) || type.conforms(to: .pdf)
    }
}

// MARK: - Time

enum NBTime {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()
    private static let zh = Locale(identifier: "zh_CN")

    static func date(_ raw: String) -> Date? { fractional.date(from: raw) ?? plain.date(from: raw) }

    static func clock(_ raw: String) -> String {
        guard let date = date(raw) else { return "" }
        return date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(zh))
    }

    static func dayKey(_ raw: String) -> String {
        guard let date = date(raw) else { return "" }
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return "\(parts.year ?? 0)-\(parts.month ?? 0)-\(parts.day ?? 0)"
    }

    static func dayTitle(_ raw: String) -> String {
        guard let date = date(raw) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "今天" }
        if calendar.isDateInYesterday(date) { return "昨天" }
        let sameYear = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
        let style = sameYear
            ? Date.FormatStyle().month(.defaultDigits).day().weekday(.abbreviated).locale(zh)
            : Date.FormatStyle().year().month(.defaultDigits).day().locale(zh)
        return date.formatted(style)
    }
}

// MARK: - Components

/// 侧边栏毛玻璃。
struct NBVisualEffect: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .sidebar

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .followsWindowActiveState
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) { view.material = material }
}

/// 系统设置式的彩色圆角图标。
struct NBGlyphTile: View {
    let symbol: String
    let tone: NB.Tone
    var size: CGFloat = 22

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(tone.gradient, in: RoundedRectangle(cornerRadius: size * 0.27, style: .continuous))
    }
}

/// 小号胶囊徽标，例如“测试版”。
struct NBBadge: View {
    let text: String
    var color: Color = NB.blue

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.13), in: Capsule())
    }
}

/// 环形进度：蓝色进行中，橙色失败。
struct NBRing: View {
    let value: Double
    var failed = false
    var paused = false

    var body: some View {
        let color = failed ? NB.orange : NB.blue
        ZStack {
            Circle().stroke(Color.primary.opacity(0.1), lineWidth: 3)
            Circle()
                .trim(from: 0, to: max(0.03, min(1, value)))
                .stroke(color, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: failed ? "exclamationmark" : (paused ? "pause.fill" : "arrow.up"))
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(color)
        }
        .frame(width: 28, height: 28)
        .animation(.easeOut(duration: 0.25), value: value)
    }
}

/// 状态小圆点。
struct NBDot: View {
    let color: Color
    var size: CGFloat = 7

    var body: some View { Circle().fill(color).frame(width: size, height: size) }
}

/// 未配对时的“呼吸”外圈。
struct NBPulse: View {
    let color: Color
    @State private var animate = false

    init(color: Color = NB.blue) { self.color = color }

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .stroke(color.opacity(0.35), lineWidth: 1.2)
                    .scaleEffect(animate ? 1.9 : 0.9)
                    .opacity(animate ? 0 : 1)
                    .animation(.easeOut(duration: 2.6).repeatForever(autoreverses: false).delay(Double(index) * 0.85), value: animate)
            }
        }
        .onAppear { animate = true }
    }
}

// MARK: - Thumbnails

@MainActor
enum NBThumbnails {
    private static let cache = NSCache<NSString, NSImage>()

    static func load(_ path: String, side: CGFloat) async -> NSImage? {
        let key = "\(path)#\(Int(side))" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let request = QLThumbnailGenerator.Request(
            fileAt: URL(fileURLWithPath: path),
            size: CGSize(width: side, height: side),
            scale: NSScreen.main?.backingScaleFactor ?? 2,
            representationTypes: .thumbnail
        )
        guard let image = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).nsImage else { return nil }
        cache.setObject(image, forKey: key)
        return image
    }
}

/// QuickLook 缩略图，失败时回落到 Finder 图标。
struct NBThumbnail: View {
    let path: String
    let side: CGFloat
    let fill: Bool
    @State private var image: NSImage?

    init(path: String, side: CGFloat, fill: Bool = false) {
        self.path = path
        self.side = side
        self.fill = fill
    }

    var body: some View {
        Group {
            if let image = image {
                if fill { Image(nsImage: image).resizable().scaledToFill() } else { Image(nsImage: image).resizable().scaledToFit() }
            } else {
                Image(nsImage: NSWorkspace.shared.icon(forFile: path)).resizable().scaledToFit().padding(fill ? side * 0.25 : 0)
            }
        }
        .task(id: path) { image = await NBThumbnails.load(path, side: side) }
    }
}
