---
id: build-task-aggregation
title: 构建·任务看板数据层（task-aggregation）
status: passed
feature: 
verifier: "bash -c 'npx vitest run src/tasks && npm run typecheck'"
created: 2026-07-21
last_run: 2026-07-25 03:48:26
---
## 1. 目标 (Goal)



新建 `src/tasks/`：把 session 按项目/任务类别聚合成"任务卡片"（状态 live/idle/stopped/failed + Agent + 最后活动 + 摘要 + 设备来源），输出供前端看板与 `/api/tasks`。这是左栏任务看板的数据地基——任务为单位，非原始 session 列表。

## 2. 上下文 (Context)



读 docs/product-frontend.md §3/§4/§5（看板颠覆原则 + 卡片字段）、src/store/session-store.ts（按 project_path 聚类）、src/extract/（摘要来源）、src/briefing/portrait（摘要复用）。

## 3. 行动约束 (Action)



新建 src/tasks/（聚合 + 分类规则 + 摘要接入）+ 测试。分类首版：按 project_path 自动归类，管家可调（留 hook）。不准改 store schema。

## 4. 观察与反馈 (Observation)



verifier：`npx vitest run src/tasks` 全绿 + typecheck。断言：任务卡片结构正确（项目/类别/状态/Agent/摘要/设备）、跨设备标记、无重复、覆盖所有 live session。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读看板设计 + store 聚类 → 实现 src/tasks/ 聚合 + 分类 + 摘要 + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
