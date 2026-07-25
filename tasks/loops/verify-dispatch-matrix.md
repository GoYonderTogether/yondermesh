---
id: verify-dispatch-matrix
title: 验证·每 CLI 的派发双向能力矩阵
status: passed
feature: dispatch
verifier: "node scripts/loop/verify/dispatch-matrix.mjs"
created: 2026-07-21
last_run: 2026-07-25 05:29:43
---
## 1. 目标 (Goal)



















调研每个已装、可 trigger 的 CLI 的投递与回话能力，产出双向能力矩阵：哪些双向完整（cli-spawn/http-api/ws-rpc）、哪些只能投递读不到回复（tmux/applescript 的 IDE 类）、哪些需登录、哪些无 trigger 通道。

## 2. 上下文 (Context)



















读 src/trigger/adapter.ts（IDE_CLIS/HTTP_API_CLIS/WS_RPC_CLIS/CLI_LAUNCH_COMMANDS + getCapability）、src/trigger/types.ts（6 通道）。脚本 `scripts/loop/verify/dispatch-matrix.mjs` 对每个已装可 trigger CLI 跑一次 send。

## 3. 行动约束 (Action)



















每个 CLI 只发一条无害消息（"回复 ok"）。矩阵产出即通过——个别 CLI 失败是调研结果（揭示单向/需登录），不是本 loop 失败。无 trigger 通道的（cass/omp/gsd-pi/cursor/trae/trae-cn）跳过记录。

## 4. 观察与反馈 (Observation)



















verifier 产出 `tasks/loops/reports/dispatch-matrix.md`，每 CLI 记：通道 / 投递✅❌ / 回话✅⚠。exit 0 = 矩阵覆盖所有可 trigger CLI。
预期分类：cli-spawn(http/ws)-类 22 个能拿完整 response；IDE 类 4 个（trae-ide/windsurf/cursor-ide/chatgpt）delivered 但回话依赖辅助功能权限。

## Prompt



















你是验证 loop 执行者，用 sub-agent 执行。跑 dispatch-matrix.mjs 产出矩阵；若某 CLI 异常报错（非"未认证/单向"的正常情况），用 sub-agent 排查该通道 adapter 修复后重跑。汇报每个 CLI 的双向能力归类。不许撒谎。
