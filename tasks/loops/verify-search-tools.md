---
id: verify-search-tools
title: 验证·查询工具返回真实数据
status: passed
feature: search
verifier: "bash -c 'TS=$(ymesh mcp call overview \"{}\" 2>/dev/null | jq \".totalSessions\"); [ \"$TS\" -gt 0 ] && ymesh mcp call list_active \"{}\" 2>/dev/null | jq -e \".totalActive != null\" && ymesh mcp call search_sessions \"{\\\"limit\\\":5}\" 2>/dev/null | jq -e \"length > 0\" && [ \"$TS\" -eq \"$(sqlite3 ~/.yondermesh/yondermesh.db \"SELECT COUNT(*) FROM sessions WHERE retention=\\\"live\\\";\")\" ]'"
created: 2026-07-21
last_run: 2026-07-20 17:52:53
---
## 1. 目标 (Goal)










证明 MCP 查询工具（overview / list_active / search_sessions）返回结构正确、数据真实，且计数与 SQLite 一致——不是空壳或假数据。

## 2. 上下文 (Context)










读 specs/mcp-spec.md、src/mcp/server.ts（核心 8 工具）、src/store/types.ts（SessionStats/ActiveSummary 结构）。三个工具：overview→总数、list_active→活跃、search_sessions→按条件检索。

## 3. 行动约束 (Action)










只查询。若计数与 SQLite 对不上，用 sub-agent 排查 src/mcp/server.ts 的统计逻辑修复，再验。

## 4. 观察与反馈 (Observation)










verifier 断言：① overview.totalSessions >0；② list_active 返回 totalActive 字段；③ search_sessions 返回非空数组。
交叉校验（loop 内执行）：`overview.totalSessions` 应与 `sqlite3 ... "SELECT COUNT(*) FROM sessions;"` 一致（或仅差 live/archived 口径）；search_sessions 按 `source`/`project_path`/`topology`/`since` 过滤应返回正确子集。

## Prompt










你是验证 loop 执行者，用 sub-agent 执行。跑三个 MCP 查询工具 + 与 SQLite 计数交叉核对；不一致则用 sub-agent 排查 server.ts 统计逻辑修复后重验。汇报每个工具返回的结构与计数。不许撒谎。
