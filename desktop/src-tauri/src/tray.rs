//! 桌面端系统状态栏（托盘）图标 + 菜单，及「消息免打扰」内存态。
//!
//! 后台 gateway 常驻：点叉不退出（窗口隐藏，宿主进程不受影响），
//! 托盘提供唯一的「可见入口 + 真正退出」通道。
//!
//! 菜单：打开 / 消息免打扰(可勾选) / 退出。
//! 「免打扰」通过 emit 事件交前端处理（前端是通知器的单一真相源）。
//!
//! yonder 原版的 Db / prefs 依赖已剥离：DND 改为内存态 bool，
//! 持久化由前端通过 settings 自行管理。

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// 持有 DND 勾选项句柄，便于前端改动「消息免打扰」时同步托盘勾选态。
static DND_ITEM: Mutex<Option<CheckMenuItem<Wry>>> = Mutex::new(None);

/// 内存态 DND 开关（yondermesh 壳层不持久化；前端可通过 settings 自己管）。
static DND_ENABLED: Mutex<bool> = Mutex::new(false);

/// 显示并聚焦主窗口（托盘「打开」/ 左键点击 / macOS Reopen 共用）。
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 同步托盘勾选项（前端改 DND 时可调用，保持托盘与设置一致）。
pub fn set_dnd_checked(checked: bool) {
    if let Some(item) = DND_ITEM.lock().unwrap().as_ref() {
        let _ = item.set_checked(checked);
    }
}

/// 构建托盘图标 + 菜单（仅桌面端 setup 调用一次）。
pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "打开").build(app)?;
    let dnd = CheckMenuItemBuilder::with_id("dnd", "消息免打扰")
        .checked(*DND_ENABLED.lock().unwrap())
        .build(app)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 Yondermesh").build(app)?;

    let menu = MenuBuilder::new(app)
        .items(&[&open, &dnd, &sep, &quit])
        .build()?;

    // 句柄存全局，供前端改 DND 时同步勾选
    *DND_ITEM.lock().unwrap() = Some(dnd);

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("默认窗口图标缺失"))
        .tooltip("Yondermesh")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "dnd" => {
                // CheckMenuItem 点击后自身已翻转勾选；据内存旧值算新值并广播给前端
                let next = !*DND_ENABLED.lock().unwrap();
                *DND_ENABLED.lock().unwrap() = next;
                set_dnd_checked(next);
                let _ = app.emit("tray://dnd", next);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
