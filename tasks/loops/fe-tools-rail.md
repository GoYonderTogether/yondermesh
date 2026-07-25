---
id: fe-tools-rail
title: 构建·右栏工具栏（fe-tools-rail · 终端/任务清单/文件浏览）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 09:34:48
---
## 1. 目标 (Goal)







实现右栏工具栏（类 Codex）：终端、任务清单（看板另一种视图）、文件浏览（限定工作目录）。可折叠分区。依赖 fork-yonder-shell。

## 2. 上下文 (Context)







读 docs/product-frontend.md §3/§5（工具栏）、desktop/web 的 ui（Tabs/ScrollArea/Drawer）。终端首版接本地 shell（Tauri 进程能力，后续接远端设备）。

## 3. 行动约束 (Action)







新建 desktop/web/src/features/tools/（终端 + 任务清单 + 文件浏览 + 测试）。复用 @ymesh/ui。不准改引擎。verifier 首版以 build 过为准（终端 e2e 留后续）。

## 4. 观察与反馈 (Observation)







verifier：`cd desktop/web && npm run build` 成功。三个分区渲染、可折叠、文件浏览限定工作目录（人工核验记入报告）。

## Prompt







你是 loop 执行者，用 sub-agent 执行。读工具栏设计 → 实现三分区 + 测试 → 跑 verifier（build 过）→ 通过则停，失败继续。不许撒谎。
