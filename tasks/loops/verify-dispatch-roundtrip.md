---
id: verify-dispatch-roundtrip
title: 验证·跨 agent 派发端到端（发任务+回话+审计）
status: passed
feature: dispatch
verifier: "node scripts/loop/verify/dispatch-roundtrip.mjs"
created: 2026-07-21
last_run: 2026-07-25 03:06:16
---
## 1. 目标 (Goal)







证明派发链路真的通：主 agent 经 `ymesh send` 向另一个 CLI 发"创建文件"任务 → 对方真把文件建出来 → 回话同步返回 → agent_messages 表留两条审计（question + task_update）。这是 dispatch 的命门验证。

## 2. 上下文 (Context)







读 specs/mailbox-v3-spec.md、src/mailbox/core.ts（MailboxCore.send 四步：审计写→TriggerAdapter 投递→ReplyAdapter 清洗→审计写回复）、src/trigger/adapter.ts（6 通道）。脚本 `scripts/loop/verify/dispatch-roundtrip.mjs` 按 DISPATCH_CLI（默认 codex,claude,hermes）依次试。

## 3. 行动约束 (Action)







会真实启动目标 CLI 跑一次任务（创建 /tmp 探针文件）。若全失败，用 sub-agent 排查是哪个环节（投递/回复清洗/审计）并修复，再验。若仅因 CLI 未认证失败，记录"该 CLI 需登录"并换候选。

## 4. 观察与反馈 (Observation)







verifier 断言三件：① delivered=true；② 探针文件真被创建且非空；③ agent_messages 表能按探针路径查到 ≥1 条审计。
通过 = 至少一个已认证 CLI 端到端跑通。失败 = 派发链路有断点或所有候选 CLI 都未认证（暴露真实状态）。

## Prompt







你是验证 loop 执行者，用 sub-agent 执行。跑 dispatch-roundtrip.mjs；失败则用 sub-agent 分环节排查（投递通道 / ReplyAdapter 清洗 / 审计写入）修复后重验。汇报哪个 CLI 跑通、delivered/response/审计的实际结果。不许撒谎。
