---
id: verify-session-detail
title: 验证·session 详情与原始数据可读
status: passed
feature: search
verifier: "node scripts/loop/verify/session-detail.mjs"
created: 2026-07-21
last_run: 2026-07-25 09:50:18
---
## 1. 目标 (Goal)






















证明能读到单条 session 的原始消息：`get_session` 返回 messages 数组、内容非空、revision 链一致；且 `live=true` 能直读源文件。

## 2. 上下文 (Context)






















读 src/mcp/server.ts（refinedGetSession：DB 模式默认、live=true 直读源文件）、src/store/schema.ts（messages.revision_id ↔ sessions.current_revision_id）。

## 3. 行动约束 (Action)






















只读。若 messages 为空或 revision 链断裂，用 sub-agent 排查 session-store.ingestSession 修复，再验。

## 4. 观察与反馈 (Observation)






















verifier：取一条 live session id，`get_session` 返回 messages.length>0。
不变式：messages.revision_id == sessions.current_revision_id；messages.session_id == sessions.id；live=true 模式应直读 `~/.claude/projects/**` 或 `~/.codex/sessions/**` 源文件，返回带 timestamp 的消息。

## Prompt






















你是验证 loop 执行者，用 sub-agent 执行。取若干 live session，分别用 DB 模式与 live=true 模式调 get_session，核对 messages 非空 + revision 链一致 + 源文件路径正确；不符则用 sub-agent 排查 ingest/读取逻辑修复后重验。不许撒谎。
