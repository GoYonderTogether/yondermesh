---
id: fork-yonder-shell
title: 构建·fork yonder 壳到 desktop/
status: draft
feature: ""
verifier: "bash -c 'cd desktop/web && npm run build'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

把 yonder 前端的 5 块（packages/ui · web/styles+shell+通用 hooks · src-tauri conf/entitlements/capabilities/lib/tray/power · notarize 脚本 · vite 配置）fork 到 yondermesh 的 `desktop/`，改名 `@yonder/*`→`@ymesh/*`、重品牌，能 `npm run dev` 起来 + tray 显示 + 零授权弹窗。是所有 fe-* loop 的前置。

## 2. 上下文 (Context)

读 docs/product-frontend.md §2/§6/§7（架构 + 复用清单 + 零-TCC）。源在 /Users/zoran/Documents/projects/yonder/（apps/web、apps/desktop/src-tauri、packages/ui、scripts/notarize-mac.sh）。

## 3. 行动约束 (Action)

只新建 desktop/（web/ + src-tauri/）。剥离 yonder 业务（features/contracts/bridge.rs 业务命令全删），保留壳 + ui + tray + power + autostart。entitlements/capabilities 原样（零-TCC）。

## 4. 观察与反馈 (Observation)

verifier：`cd desktop/web && npm run build` 成功。dev 起来后 tray 图标出现、无系统授权弹窗（人工核验记入报告）。

## Prompt

你是 loop 执行者，用 sub-agent 执行。按 docs/product-frontend.md §6 搬运清单 fork 5 块到 desktop/、改名重品牌、删 yonder 业务、接 hello 页 → 跑 verifier（build 过）→ 通过则停，失败继续。不许撒谎。
