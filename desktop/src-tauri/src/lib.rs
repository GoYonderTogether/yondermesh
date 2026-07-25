// Yondermesh 桌面端壳层入口：创建窗口、托盘、防休眠、开机自启。
//
// 零 TCC（与 yonder 同路线，见 docs/product-frontend.md §7）：
//   - tray 用 Tauri tray-icon（非原生 NSStatusItem）
//   - 开机自启走 LaunchAgent plist（非 AppleScript，避免弹终端）
//   - 防休眠用 caffeinate -i（系统自带，零权限）
//   - entitlements 只 JIT 两条；不申 accessibility/automation/full-disk
//
// 已剥离 yonder 业务（bridge/db/sync/session_*/mcp/ota/dispatch/team_builder/keys/prefs/context_menu），
// 只保留壳 + tray + power + autostart。业务命令由前端通过 ymesh CLI / MCP 自行接入。

mod power;
#[cfg(desktop)]
mod tray;

use power::SleepGuard;
use std::sync::Arc;

/// 应用启动入口，由 main.rs 调用
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 桌面端（macOS/Windows/Linux）挂 updater/process/dialog/autostart 插件。
    // 移动端不挂（crate 显式排除 iOS/Android）。
    // macOS 自启走 LaunchAgent（零 TCC，非 AppleScript）。
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ));
    }

    // 防休眠控制器（后台常驻配套）：以 Arc 形式 manage，便于任务生命周期 RAII 守卫共享
    let sleep_guard = Arc::new(SleepGuard::default());

    builder
        .manage(sleep_guard.clone())
        // 仅注册壳层自身命令：防休眠模式读写。yonder 业务命令已全部删除。
        .invoke_handler(tauri::generate_handler![
            power::sleep_guard_get,
            power::sleep_guard_set,
        ])
        .setup(move |app| {
            let _ = &app;
            // 后台 gateway 常驻（仅桌面）：建系统状态栏托盘。
            // 托盘是「点叉隐藏窗口」后唯一的可见入口 + 真正退出通道。
            #[cfg(desktop)]
            {
                tray::build_tray(app.handle())?;
                // 防休眠默认从内存态恢复（off）；持久化由前端通过 settings 自行管理。
            }
            Ok(())
        })
        // 点叉不退出：拦截主窗口关闭请求 → 仅隐藏窗口；后台 gateway 继续运行。
        // 真正退出走托盘「退出」。仅桌面端启用（移动端无窗口关闭语义）。
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(desktop))]
            {
                let _ = (window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("运行 Yondermesh 桌面端时出错")
        // macOS：Dock 图标被点（无可见窗口时）触发 Reopen → 重新显示主窗口。
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app_handle);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}
