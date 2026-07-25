---
id: verify-collect-db
title: 验证·采集真的落库
status: passed
feature: collect
verifier: "bash -c 'DB=~/.yondermesh/yondermesh.db; test -f \"$DB\" && [ \"$(sqlite3 \"$DB\" \"SELECT COUNT(*) FROM sessions WHERE retention=\\\"live\\\";\")\" -gt 0 ] && [ \"$(sqlite3 \"$DB\" \"SELECT COUNT(*) FROM messages;\")\" -gt 0 ] && [ \"$(sqlite3 \"$DB\" \"SELECT COUNT(*) FROM scan_runs;\")\" -gt 0 ] && [ \"$(sqlite3 \"$DB\" \"SELECT COUNT(*) FROM sessions WHERE retention=\\\"live\\\" AND (current_revision_id IS NULL OR length(current_revision_id)=0);\")\" -eq 0 ] && [ \"$(sqlite3 \"$DB\" \"SELECT COUNT(*) FROM sessions WHERE retention=\\\"live\\\" AND length(id)!=64;\")\" -eq 0 ]'"
created: 2026-07-21
last_run: 2026-07-25 03:04:53
---
## 1. 目标 (Goal)














证明"采集"不是空壳：本地 SQLite 真的有 session、有 message、有 scan 记录。这是整个底座的真实性地基。

## 2. 上下文 (Context)














读 src/store/schema.ts（7 张表）、src/store/session-store.ts（ingestSession 入库逻辑）、src/daemon/config.ts（DB 落在 ~/.yondermesh/yondermesh.db）。

## 3. 行动约束 (Action)














只读 DB 验证；不准改数据。若失败，用 sub-agent 排查 src/store、src/adapters、daemon 的采集链路并修复，再验证。

## 4. 观察与反馈 (Observation)














verifier 断言三件事：① DB 文件存在；② `sessions` 表 retention='live' 的行数 >0；③ `messages` 表 >0；④ `scan_runs` 表 >0（说明扫描真跑过）。
不变式：`sessions.id` = sha256(JSON.stringify([device_id, source_instance_id, native_session_id]))，64 字符 hex；每条 session 在 `session_revisions` 至少 1 条，`current_revision_id` 非空。

## Prompt














你是一个验证 loop 执行者，用 sub-agent 做任务执行。跑 verifier 命令；通过则报告"采集确证真实落库"并附 sessions/messages/scan_runs 计数；失败则用 sub-agent 排查采集链路（schema/store/adapters/daemon）修复后重验，直到通过。不许撒谎声称通过。
