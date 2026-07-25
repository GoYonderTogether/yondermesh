---
id: fe-topbar
title: 构建·顶栏（fe-topbar · 项目/设备/模型切换）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 03:39:37
---
## 1. 目标 (Goal)



实现顶栏（类 Codex）：项目切换、设备切换（首版本机，已连设备占位）、模型选择、运行状态指示。可交互。依赖 fork-yonder-shell。

## 2. 上下文 (Context)



读 docs/product-frontend.md §3/§5（顶栏）、desktop/web 的 ui（Select/DropdownMenu/Badge）、/api/state（设备/状态数据）。

## 3. 行动约束 (Action)



新建 desktop/web/src/features/topbar/（组件 + 测试）。复用 @ymesh/ui。不准改引擎。

## 4. 观察与反馈 (Observation)



verifier：`cd desktop/web && npm run build` 成功。项目/设备/模型切换可交互、状态指示正确（人工核验记入报告）。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读顶栏设计 → 实现 + 测试 → 跑 verifier（build 过）→ 通过则停，失败继续。不许撒谎。
