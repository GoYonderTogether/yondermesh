---
id: fe-loops-dashboard
title: 构建·把 loop 看板迁进 app（fe-loops-dashboard）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npx vitest run src/features/loops && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 03:27:42
---
## 1. 目标 (Goal)



把现有 `scripts/loop/dashboard.html`（loop 看板）迁进 React app：loop 列表 + 实时状态 + 建 loop/编辑/复制提示词/扫描，全部在 app 内。后端复用现有 scripts/loop/server.mjs 的 API（或并入 src/web/）。依赖 fork-yonder-shell。

## 2. 上下文 (Context)



读 scripts/loop/dashboard.html（现有实现，迁移源）、scripts/loop/server.mjs（API）、docs/product-frontend.md。

## 3. 行动约束 (Action)



新建 desktop/web/src/features/loops/（迁移为 React 组件 + hook + 测试）。不准改 scripts/loop/ 逻辑（只迁移 UI）。复用 @ymesh/ui。

## 4. 观察与反馈 (Observation)



verifier：`cd desktop/web && npx vitest run src/features/loops && npm run build` 全绿。断言：loop 列表渲染、状态色、新建/保存/扫描交互（mock API）。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读 scripts/loop/dashboard.html → 迁移为 React feature + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
