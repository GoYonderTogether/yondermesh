---
id: fe-board
title: 构建·左栏任务看板（fe-board · 核心颠覆页）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npx vitest run src/features/board && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 09:34:40
---
## 1. 目标 (Goal)







实现左栏任务看板：连 `/api/tasks`，按项目/任务类别分组展示进行中任务卡片（状态 live/idle/stopped/failed + Agent + 最后活动 + 设备来源），悬停看 Agent 摘要。**这是看板，不是 session 列表**——用户只看进展，管家替其操作。依赖 build-task-aggregation + fork-yonder-shell。

## 2. 上下文 (Context)







读 docs/product-frontend.md §3/§4/§5（布局 + 颠覆原则 + 卡片字段）、desktop/web 的 ui 组件（Card/DataTable/Badge）、/api/tasks 返回结构（src/tasks/）。

## 3. 行动约束 (Action)







只新建 desktop/web/src/features/board/（组件 + hook + 测试）。复用 @ymesh/ui。不准改引擎。写 vitest 组件测试（mock /api/tasks，断言渲染卡片 + 状态色 + 悬停摘要）。

## 4. 观察与反馈 (Observation)







verifier：`cd desktop/web && npx vitest run src/features/board && npm run build` 全绿。断言：按项目分组、状态色正确、悬停摘要显示、空态处理。

## Prompt







你是 loop 执行者，用 sub-agent 执行。读看板设计 + /api/tasks 结构 → 实现 board 组件 + hook + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
