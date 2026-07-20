---
id: verify-collect-per-cli
title: 验证·每个 CLI 的采集可查（per-CLI 矩阵）
status: passed
feature: collect
verifier: "node scripts/loop/verify/collect-per-cli.mjs"
created: 2026-07-21
last_run: 2026-07-21 01:04:26
---

## 1. 目标 (Goal)

对本机已装的每一个可采集 CLI，逐一验证 `ymesh sessions --source <X>` 能查到真实数据；产出 per-CLI 采集矩阵，覆盖各种情况（有 session / 无 session / 需登录 / C 级不采）。

## 2. 上下文 (Context)

读 src/detect/agents.ts（检测规则）、src/adapters/registry.ts（32 CLI + coverage）、specs/adapter-spec.md §6（D1–D10，D1=能否采集）。脚本 `scripts/loop/verify/collect-per-cli.mjs` 用 `ymesh mcp call agents` 拿已装清单，逐个查询。

## 3. 行动约束 (Action)

只查询、不改数据。C 级（chatgpt/cursor/trae/trae-cn 仅发现或仅挂载）跳过并记录"不采集"。无 session 的 CLI 记"⚠ 可查但无数据"（非错误，说明该 CLI 本机未用或需登录）。

## 4. 观察与反馈 (Observation)

verifier 产出 `tasks/loops/reports/collect-per-cli.md` 矩阵。exit 0 = 所有可采 CLI 都能查询（返回合法 JSON）；exit 1 = 有 CLI 查询报错（暴露采集 bug）。
边界情况必须在矩阵里体现：有数据✅ / 无数据⚠ / 需登录⚠ / 不采集—。aider 与 crush 是 per-project 无全局目录（resolveSessionDir=undefined），属正常"无全局 session"。

## Prompt

你是验证 loop 执行者，用 sub-agent 执行。跑 collect-per-cli.mjs 产出矩阵；若某 CLI 报错，用 sub-agent 排查该 CLI 的 importer（src/<cli>/）并修复，再跑直到全部可查。把矩阵结果汇报，标清每个 CLI 的真实采集状态。不许撒谎。
