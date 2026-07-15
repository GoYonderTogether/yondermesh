// yondermesh macOS 菜单栏 app
// 编译: swiftc -o YondermeshMenuBar -framework Cocoa YondermeshMenuBar.swift
// 运行: 作为 .app bundle 的主二进制

import Cocoa

// ─── 配置 ────────────────────────────────────────────────
let plistLabel = "com.yondermesh.daemon"
let daemonPlistPath = "\(NSHomeDirectory())/Library/LaunchAgents/\(plistLabel).plist"

// ─── 状态栏图标 ────────────────────────────────────────────
// 用 NSImage 绘制一个简单的 "Y" 图标（16x16 points, 32x32 pixels @2x）
func makeYondermeshIcon(active: Bool) -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let image = NSImage(size: size)
    image.lockFocus()

    // 背景：圆角矩形
    let rect = NSRect(origin: .zero, size: size)
    let path = NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4)
    if active {
        NSColor.controlAccentColor.setFill()
    } else {
        NSColor.tertiaryLabelColor.setFill()
    }
    path.fill()

    // "Y" 文字
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 11, weight: .bold),
        .foregroundColor: NSColor.white,
    ]
    let text = "Y" as NSString
    let textSize = text.size(withAttributes: attrs)
    let textRect = NSRect(
        x: (size.width - textSize.width) / 2,
        y: (size.height - textSize.height) / 2 - 1,
        width: textSize.width,
        height: textSize.height
    )
    text.draw(in: textRect, withAttributes: attrs)

    image.unlockFocus()
    image.isTemplate = false
    return image
}

// ─── daemon 状态检测 ─────────────────────────────────────────
func getDaemonStatus() -> (running: Bool, pid: Int?) {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["list", plistLabel]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = pipe
    do {
        try task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8) ?? ""
        if output.contains("Could not find") || output.isEmpty {
            return (false, nil)
        }
        if let pidMatch = output.range(of: #""PID"\s*=\s*(\d+)"#, options: .regularExpression) {
            let pidStr = String(output[pidMatch]).replacingOccurrences(of: #""PID"\s*=\s*"#, with: "", options: .regularExpression)
            return (true, Int(pidStr))
        }
        return (false, nil)
    } catch {
        return (false, nil)
    }
}

// ─── 启动 daemon ─────────────────────────────────────────────
func startDaemon() {
    let loadTask = Process()
    loadTask.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    loadTask.arguments = ["load", daemonPlistPath]
    try? loadTask.run()
    loadTask.waitUntilExit()

    let startTask = Process()
    startTask.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    startTask.arguments = ["start", plistLabel]
    try? startTask.run()
    startTask.waitUntilExit()
}

// ─── 主菜单栏控制器 ─────────────────────────────────────────
class MenuBarController: NSObject {
    var statusItem: NSStatusItem!
    var timer: Timer?

    func setup() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        updateStatus()

        // 每 15 秒刷新状态
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.updateStatus()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func updateStatus() {
        let (running, pid) = getDaemonStatus()
        let icon = makeYondermeshIcon(active: running)
        statusItem.button?.image = icon
        statusItem.button?.image?.size = NSSize(width: 18, height: 18)

        let menu = NSMenu()

        // 标题
        let titleItem = NSMenuItem(title: "yondermesh", action: nil, keyEquivalent: "")
        titleItem.isEnabled = false
        menu.addItem(titleItem)

        // 状态行
        let statusText = running
            ? (pid != nil ? "Daemon 运行中 (PID \(pid!))" : "Daemon 运行中")
            : "Daemon 未运行"
        let statusItem2 = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
        statusItem2.isEnabled = false
        menu.addItem(statusItem2)

        menu.addItem(.separator())

        // daemon 未运行时显示"启动 daemon"
        if !running {
            let startItem = NSMenuItem(title: "启动 daemon", action: #selector(startDaemonAction), keyEquivalent: "s")
            startItem.target = self
            menu.addItem(startItem)
            menu.addItem(.separator())
        }

        // 退出 ymesh
        let quitItem = NSMenuItem(title: "退出 ymesh", action: #selector(quitYmesh), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    @objc func startDaemonAction() {
        startDaemon()
        // 短暂延迟后刷新状态
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.updateStatus()
        }
    }

    @objc func quitYmesh() {
        // 1. 停止 daemon（unload 阻止 KeepAlive 重启）
        let stopTask = Process()
        stopTask.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        stopTask.arguments = ["unload", daemonPlistPath]
        try? stopTask.run()
        stopTask.waitUntilExit()

        // 2. 退出菜单栏 app
        NSApp.terminate(nil)
    }
}

// ─── App 入口 ────────────────────────────────────────────────
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 不在 Dock 显示
app.run()

class AppDelegate: NSObject, NSApplicationDelegate {
    var controller: MenuBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller = MenuBarController()
        controller!.setup()
    }
}
