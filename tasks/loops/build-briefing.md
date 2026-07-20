---
id: build-briefing
title: 构建·每日汇总（briefing）
status: draft
feature: briefing
verifier: "bash -c 'npx vitest run src/briefing && npm run typecheck'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

实现 `BriefingGenerator.generate()`：基于 SessionStore 多维切分（按 source/cwd/时段/成败）渲染真实晨报——完成数/成功率/卡住待办/跨设备汇总。接 daemon 调度（每小时）+ 加 `ymesh briefing generate` 命令。现状是 TODO stub（generator.ts:66-85 返回空壳）。

## 2. 上下文 (Context)

读 src/briefing/generator.ts（现有 stub）、src/store/session-store.ts（getSessionStats/querySessions/getActiveSessionsSummary）、src/daemon/index.ts（调度接入点）、src/bin/ymesh.ts cmdStateSync（数据组装参考）、docs/features.yaml（briefing 现状）。

## 3. 行动约束 (Action)

只改 src/briefing/ + 在 daemon/ymesh.ts 接线。不准改 store schema。写 vitest 测试（mock store，断言产出结构 + 计数一致）。

## 4. 观察与反馈 (Observation)

verifier：`npx vitest run src/briefing` 全绿 + typecheck 过。断言：晨报含完成数/成功率/待办，数字 = store 实际值；不漏报失败 session。

## Prompt

你是 loop 执行者，用 sub-agent 执行。读 generator.ts stub + store 方法 → 实现真实 generate() + 测试 + daemon 调度 + CLI → 跑 verifier → 通过则停，失败继续。不许撒谎。
