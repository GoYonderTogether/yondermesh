---
id: build-portrait
title: 构建·使用画像（portrait）
status: draft
feature: portrait
verifier: "bash -c 'npx vitest run src/briefing && npm run typecheck'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

新建使用画像计算模块：从 SessionStore 聚合出"你最常用哪个 agent / 哪个项目 / 高峰时段 / 调研 vs 写代码占比"等指标，输出结构化 portrait JSON。现状：零代码（src/briefing/ 下无 portrait 相关）。

## 2. 上下文 (Context)

读 docs/product-frontend.md §5（画像字段）、src/briefing/generator.ts（同目录）、src/store/session-store.ts（按 source/cwd/时段聚合）、src/store/schema.ts（message_count/started_at/last_seen_at/model 等字段）。

## 3. 行动约束 (Action)

在 src/briefing/ 下新建 portrait.ts + 测试。复用 store 查询，不准改 schema。输出供前端 /api/portrait 与看板悬停摘要用。

## 4. 观察与反馈 (Observation)

verifier：`npx vitest run src/briefing` 全绿 + typecheck。断言：portrait JSON 含 topAgent/topProject/peakHour/workBreakdown，数值与 store 交叉一致。

## Prompt

你是 loop 执行者，用 sub-agent 执行。读 store 聚合能力 → 实现 portrait.ts + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
