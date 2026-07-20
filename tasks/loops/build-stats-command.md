---
id: build-stats-command
title: 构建·工作统计命令（ymesh stats）
status: draft
feature: stats
verifier: "bash -c 'ymesh stats --json | jq -e \".totalSessions > 0\"'"
created: 2026-07-21
last_run: 
---

## 1. 目标 (Goal)

加 `ymesh stats` 命令 + 多维切片（按天/项目/模型），输出结构化 JSON。现状：底层 SessionStore.getSessionStats 可用（经 status/state 间接出），但无独立命令、无多维切片。

## 2. 上下文 (Context)

读 src/store/session-store.ts（getSessionStats）、src/bin/ymesh.ts cmdState/cmdStateSync（852-951、1801-1833，现有统计输出）、docs/features.yaml（stats 现状）。

## 3. 行动约束 (Action)

在 store 加 getStatsByDay/getStatsByProject/getStatsByModel 聚合方法（只读）+ ymesh.ts 加 cmdStats + switch case + help。不准改 schema。写测试。

## 4. 观察与反馈 (Observation)

verifier：`ymesh stats --json | jq -e '.totalSessions>0'` exit 0。多维切片（--by day/project/model）计数与 store 一致。

## Prompt

你是 loop 执行者，用 sub-agent 执行。读 store 统计能力 → 加多维聚合 + cmdStats + 测试 → 跑 verifier → 通过则停，失败继续。不许撒谎。
