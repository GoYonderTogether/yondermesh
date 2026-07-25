---
id: macos-tray-autostart-caffeinate
title: 构建·macOS 状态栏 + 自启 + 防休眠（零-TCC）
status: passed
feature: 
verifier: "bash -c 'cd desktop/src-tauri && cargo build 2>&1 | grep -q Finished && plutil -lint entitlements.macos.plist'"
created: 2026-07-21
last_run: 2026-07-25 09:34:52
---
## 1. 目标 (Goal)





fork yonder 的 tray.rs（Tauri tray-icon）+ lib.rs（on_window_event 拦关闭/Reopen）+ LaunchAgent 自启（非 AppleScript）+ power.rs（caffeinate 防休眠）。entitlements 只 JIT 两条，零 TCC。依赖 fork-yonder-shell。

## 2. 上下文 (Context)





读 docs/product-frontend.md §7（零-TCC）、/Users/zoran/Documents/projects/yonder/apps/desktop/src-tauri/src/{lib,tray,power}.rs、entitlements.macos.plist、capabilities/*.json。

## 3. 行动约束 (Action)





只改 desktop/src-tauri/。tray 菜单文案改 ymesh；entitlements/capabilities 原样（不申 accessibility/automation/full-disk）。删 yonder 业务命令注册。

## 4. 观察与反馈 (Observation)





verifier：`cargo build` Finished + `plutil -lint entitlements.macos.plist` OK。运行核验：tray 显示、点叉隐藏不退出、重启自启、caffeinate 持有、**零系统授权弹窗**（人工记入报告）。

## Prompt





你是 loop 执行者，用 sub-agent 执行。按 docs/product-frontend.md §7 fork tray/lib/power + entitlements → 跑 verifier（build + plist lint）→ 通过则停，失败继续。运行态零弹窗人工核验。不许撒谎。
