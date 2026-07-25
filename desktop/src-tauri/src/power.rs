//! 桌面端「防止休眠」能力（后台 gateway 常驻配套）。
//!
//! 设计：macOS 优先，三端留接口。
//! - macOS：spawn 系统自带 `caffeinate -i` 子进程持有「阻止系统空闲休眠」断言，
//!   kill 即释放——复用系统能力，无需引入第三方 crate，零 TCC。
//! - Windows/Linux：暂为 no-op 桩（接口已留，后续可接
//!   SetThreadExecutionState / systemd-inhibit）。
//!
//! 两级防休眠（与前端「通用」下拉框对应）：
//! - Off       关闭
//! - WhileTask 有任务时防止休眠（运行中任务计数 > 0 时持有断言）
//! - Always    永久防止自动休眠（app 存活期间一直持有）
//!
//! 持久化：yondermesh 壳层不持有 SQLite；模式存内存，前端可通过 settings 自行落库。
//! yonder 原版的 Db 依赖已剥离，调用方（lib.rs setup）不再调 restore_from_settings。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};

/// 防休眠级别。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum SleepGuardMode {
    #[default]
    Off,
    WhileTask,
    Always,
}

impl SleepGuardMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SleepGuardMode::Off => "off",
            SleepGuardMode::WhileTask => "while_task",
            SleepGuardMode::Always => "always",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "while_task" => SleepGuardMode::WhileTask,
            "always" => SleepGuardMode::Always,
            _ => SleepGuardMode::Off,
        }
    }
}

/// 防休眠控制器：单例 managed state（以 `Arc<SleepGuard>` 形式 manage）。
#[derive(Default)]
pub struct SleepGuard {
    mode: Mutex<SleepGuardMode>,
    /// 运行中任务计数：由 ActiveTaskGuard 维护，独立于可能泄漏的 TaskRegistry。
    /// yondermesh 壳层暂无业务任务入口，计数恒为 0；保留接口供后续业务接入。
    active: AtomicUsize,
    /// 当前持有的「防休眠」子进程（仅 macOS）。None = 未持有。
    #[cfg(target_os = "macos")]
    holder: Mutex<Option<std::process::Child>>,
}

impl SleepGuard {
    /// 按当前模式 + 任务计数判断是否应持有断言。
    fn want_hold(&self) -> bool {
        match *self.mode.lock().unwrap() {
            SleepGuardMode::Off => false,
            SleepGuardMode::Always => true,
            SleepGuardMode::WhileTask => self.active.load(Ordering::SeqCst) > 0,
        }
    }

    /// 让实际持有状态对齐 want_hold（幂等，可反复调用）。
    fn apply(&self) {
        let want = self.want_hold();
        #[cfg(target_os = "macos")]
        {
            let mut holder = self.holder.lock().unwrap();
            if want {
                if holder.is_none() {
                    // caffeinate -i：阻止系统「空闲自动休眠」；进程存活即断言生效，kill 即释放
                    match std::process::Command::new("caffeinate").arg("-i").spawn() {
                        Ok(child) => *holder = Some(child),
                        Err(e) => eprintln!("[power] 启动 caffeinate 失败: {e}"),
                    }
                }
            } else if let Some(mut child) = holder.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            // 桩：Windows/Linux 后续实现（接口已留）
            let _ = want;
        }
    }

    pub fn mode(&self) -> SleepGuardMode {
        *self.mode.lock().unwrap()
    }

    /// 设置模式并立即对齐持有状态。
    pub fn set_mode(&self, mode: SleepGuardMode) {
        *self.mode.lock().unwrap() = mode;
        self.apply();
    }

    /// 任务启动时增计数（yondermesh 壳层暂不调用，保留给后续业务接入）。
    #[allow(dead_code)]
    fn task_started(&self) {
        self.active.fetch_add(1, Ordering::SeqCst);
        self.apply();
    }

    /// 任务结束时减计数（带下溢保护）。
    #[allow(dead_code)]
    fn task_ended(&self) {
        let _ = self
            .active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                if v > 0 {
                    Some(v - 1)
                } else {
                    None
                }
            });
        self.apply();
    }
}

/// RAII：构造即 task_started，drop 即 task_ended。
/// move 进任务的 spawn 闭包，任意返回路径（正常 EOF / 取消 / 出错）在 future 结束时释放计数。
/// yondermesh 壳层暂无业务任务入口，保留给后续业务接入。
#[allow(dead_code)]
pub struct ActiveTaskGuard(Arc<SleepGuard>);

#[allow(dead_code)]
impl ActiveTaskGuard {
    pub fn new(guard: Arc<SleepGuard>) -> Self {
        guard.task_started();
        Self(guard)
    }
}

impl Drop for ActiveTaskGuard {
    fn drop(&mut self) {
        self.0.task_ended();
    }
}

// ───────────────────────── Tauri commands ─────────────────────────

/// 读取当前防休眠模式（off | while_task | always）。
#[tauri::command]
pub fn sleep_guard_get(guard: State<'_, Arc<SleepGuard>>) -> String {
    guard.mode().as_str().to_string()
}

/// 设置防休眠模式（仅内存态；持久化由前端通过 settings 自行管理）。
#[tauri::command]
pub fn sleep_guard_set(app: AppHandle, mode: String) -> Result<(), String> {
    let m = SleepGuardMode::parse(&mode);
    app.state::<Arc<SleepGuard>>().set_mode(m);
    Ok(())
}
