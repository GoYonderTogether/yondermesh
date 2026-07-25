// 阻止 Windows release 构建时弹出额外的控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// 真正的启动逻辑放在 lib.rs，便于跨平台（含未来移动端）复用
fn main() {
    yondermesh_desktop_lib::run()
}
