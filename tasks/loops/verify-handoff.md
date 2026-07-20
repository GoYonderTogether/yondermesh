---
id: verify-handoff
title: 验证·接力包可生成
status: passed
feature: handoff
verifier: "bash -c 'SID=$(sqlite3 ~/.yondermesh/yondermesh.db \"SELECT native_session_id FROM sessions WHERE retention=\\\"live\\\" AND source IN (\\\"claude\\\",\\\"claude-code\\\",\\\"codex\\\") ORDER BY last_seen_at DESC LIMIT 1;\"); [ -n \"$SID\" ] && TMP=$(mktemp) && ymesh handoff \"$SID\" --json > \"$TMP\" && jq -e \".recent_messages or .compacted_summaries\" \"$TMP\" && FP=$(jq -r \".file_path\" \"$TMP\") && [ -n \"$FP\" ] && [ -f \"$FP\" ] && rm -f \"$TMP\"'"
created: 2026-07-21
last_run: 2026-07-20 17:54:13
---
## 1. 目标 (Goal)






证明 handoff 能从一条真实 session 生成接力包（recent_messages + compacted_summaries + task_plan），且直读源文件路径正确——可交给另一个 agent 接着干。

## 2. 上下文 (Context)






读 src/mcp/codex-handoff.ts（buildSessionHandoff）、src/bin/ymesh.ts cmdHandoff（位置参数取 session_id）。handoff 直读源文件，不依赖 DB。

## 3. 行动约束 (Action)






只读。若接力包缺字段或源文件读不到，用 sub-agent 排查 codex-handoff.ts 修复，再验。

## 4. 观察与反馈 (Observation)






verifier：取一条 claude/codex 的 live session，`ymesh handoff <id> --json` 必含 recent_messages 或 compacted_summaries。
边界：源文件已删除的 session → exit 1（正常，记录为"源文件不在"）。

## Prompt






你是验证 loop 执行者，用 sub-agent 执行。对若干 claude/codex session 生成 handoff 包，核对其字段完整、源文件路径（~/.claude/projects 或 ~/.codex/sessions）正确、能被另一个 CLI 接着用；不符则用 sub-agent 排查 codex-handoff 修复后重验。不许撒谎。
