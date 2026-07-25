---
id: fe-steward-chat
title: 构建·中栏管家多模态对话窗口（fe-steward-chat）
status: passed
feature: 
verifier: "bash -c 'cd desktop/web && npx vitest run src/features/steward && npm run build'"
created: 2026-07-21
last_run: 2026-07-25 03:32:50
---
## 1. 目标 (Goal)



实现中栏管家对话窗口：与主 Agent 多模态交互，按类型渲染产出——md/code（代码块）、png/svg（图预览）首版先行；html/xml 后续。管家在此接收需求、汇报安排。依赖 fork-yonder-shell。

## 2. 上下文 (Context)



读 docs/product-frontend.md §3/§5（管家窗口 + 多模态）、desktop/web 的 ui 组件（可参考 yonder messages feature 骨架但剥离业务）。

## 3. 行动约束 (Action)



新建 desktop/web/src/features/steward/（消息列表 + 多模态渲染器 + 输入框 + 测试）。首版渲染 md/code + png/svg。复用 @ymesh/ui。不准改引擎。

## 4. 观察与反馈 (Observation)



verifier：`cd desktop/web && npx vitest run src/features/steward && npm run build` 全绿。断言：md 代码块渲染、png/svg 预览、消息流正确、输入提交。

## Prompt



你是 loop 执行者，用 sub-agent 执行。读管家窗口设计 → 实现对话 + 多模态渲染 + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
