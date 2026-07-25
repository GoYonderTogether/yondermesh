---
id: verify-trigger-reply-adapter
title: 验证·trigger 层 ReplyAdapter 纯函数（补零单测）
status: passed
feature: 
verifier: "bash -c 'npx vitest run reply-adapter && npm run typecheck'"
created: 2026-07-21
last_run: 2026-07-25 05:29:48
---
## 1. 目标 (Goal)







trigger 层体量大却几乎零断言（roadmap T3.2 记约 1748 行）。`ReplyAdapter.extractReply` 是**纯函数、无副作用**（stripAnsi → 各 CLI filter → generic filter → collapseBlankLines），必须用真单测锁住各分支。本 loop **只补测试**，默认不改产品代码；仅当测试暴露真实 bug 时才窄修并记明根因——对应 roadmap T3.2。

## 2. 上下文 (Context)







每次循环先读：`ARCHITECTURE.md` §II Trigger 段（ReplyAdapter 四步管线 + `ReplyResult.source` 派生规则）、`src/trigger/reply-adapter.ts`（`extractReply` / `stripAnsi` / `applyCliSpecificFilter` / `applyGenericFilter` / `collapseBlankLines`）、`src/trigger/types.ts`（`ReplyResult { text, source, latencyMs }`）、`src/trigger/adapter.ts`（3 模式路由 stopped/running/new，用 `FakeTriggerAdapter` 可测）、`tasks/roadmap.md` T3.2、`tests/`（确认当前无 reply-adapter / trigger 测试）。

## 3. 行动约束 (Action)







只新建 `tests/reply-adapter.test.ts`（锁纯函数各分支）+ `tests/trigger.test.ts`（3 模式路由，注入 `FakeTriggerAdapter`）。**不准改** `src/trigger/` 产品代码，除非测试暴露真实 bug——此时仅窄修该分支并在 commit/汇报写明根因。**不准动** `src/store`、`src/mcp`、`src/mailbox`。零新依赖。

## 4. 观察与反馈 (Observation)







verifier：`npx vitest run reply-adapter` 全绿 + typecheck。覆盖度断言：① stripAnsi 去除 CSI/OSC 转义；② applyCliSpecificFilter 各分支（如 hermes `Warning: Unknown toolsets`、claude `Tip:`）；③ applyGenericFilter 去 log 前缀（warn/debug/info/error…）+ 启动 banner（Welcome/Booting/Starting…）；④ collapseBlankLines（3+ 连续空行→2、首尾 trim）；⑤ `delivered=false` 或 cleaned 为空时返回空串且不抛；⑥ `ReplyResult.source` 派生正确（http-api/ws-rpc→`api`、tmux/applescript→`tmux-capture`、cli-spawn/stdin→`stdout`）。检查者 sub-agent：确认 trigger 相关用例合计 >15 个且覆盖 `applyCliSpecificFilter` 的每个 CLI 分支（对齐 T3.2 验收）。

## Prompt







你是验证 loop 执行者，必须用 sub-agent（Agent 工具）执行，不要自己一口气写完。

【目标】给 trigger 层 ReplyAdapter（纯函数）补真单测，锁住 stripAnsi / 各 CLI filter / generic filter / collapseBlankLines / source 派生各分支；trigger 3 模式路由用 FakeTriggerAdapter。
【上下文】每次循环先读：ARCHITECTURE §II Trigger + src/trigger/reply-adapter.ts + types.ts + adapter.ts + roadmap T3.2 + tests/ 现状。
【约束】只新建 tests/reply-adapter.test.ts + tests/trigger.test.ts。不改 src/trigger 产品代码，除非测试暴露真 bug（窄修 + 记根因）。不动 store/mcp/mailbox。
【完成判据】`npx vitest run reply-adapter` 全绿 + typecheck；trigger 用例 >15 个；applyCliSpecificFilter 每个 CLI 分支被覆盖。
【验证命令】`npx vitest run reply-adapter && npm run typecheck` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。不许撒谎声称通过。
