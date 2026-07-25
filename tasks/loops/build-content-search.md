---
id: build-content-search
title: 构建·消息正文搜索（SQLite FTS5）
status: passed
feature: 
verifier: "bash -c 'npx vitest run content-search && npm run typecheck'"
created: 2026-07-21
last_run: 2026-07-25 09:29:26
---
## 1. 目标 (Goal)









`search_sessions` 的 search 参数当前只匹配元数据（`=` / 前缀 LIKE），**不搜消息正文**——roadmap T2.4.1 称“四问①召回的地板”。本 loop 给 `messages.content` 建 SQLite **FTS5** 索引，让 search 真正命中正文。deterministic，零 LLM——对应 roadmap T2.4.1。

## 2. 上下文 (Context)









每次循环先读：`ARCHITECTURE.md` §II Session storage + §III.6、`src/store/schema.ts`（`messages` 表 `content` 列，确认当前**无 FTS5 虚拟表**）、`src/store/session-store.ts`（消息写入路径，FTS 同步触发点）、`src/store/index.ts`（`querySessions` 加 keyword 参数）、`src/store/types.ts`（`SessionQuery`）、`src/mcp/tools.ts`（`search_sessions` handler 是否已透传 search）、`tasks/roadmap.md` T2.4.1。

## 3. 行动约束 (Action)









改 `src/store/schema.ts`（**新增** `messages_fts` 虚拟表 + 同步触发器，**不改现有 sessions/messages 列与已有索引**）+ `src/store/session-store.ts`（写入时同步 FTS）+ `src/store/index.ts`（`querySessions` 增 `keyword` → FTS MATCH）+ 新建 `tests/content-search.test.ts`。接口层（`src/mcp/tools.ts` 的 `search_sessions`）若已透传 search 参数则**仅确认链路通、不改**。零新依赖（better-sqlite3 原生支持 FTS5）。**不准动** `src/derive`、`src/briefing`、`src/trigger`。

## 4. 观察与反馈 (Observation)









verifier：`npx vitest run content-search` 全绿（fixture：写入含特定正文的 messages → `querySessions({ keyword })` 命中、不含的不命中、中文 / 大小写 / 前缀匹配口径在测试里写明）+ typecheck。检查者 sub-agent：① 确认 FTS 不影响现有采集回归（跑等价于 verify-collect-db 的断言：总 session / message 数不回退）；② 确认元数据过滤（source/project/since）与 keyword 正文搜索**可组合 AND**；③ 确认旧库（无 FTS 表）启动时能自动补建而不崩。

## Prompt









你是 loop 执行者，必须用 sub-agent（Agent 工具）执行，不要自己一口气写完。

【目标】给 messages.content 建 SQLite FTS5 索引，让 querySessions({keyword}) 真正搜正文（当前只有元数据 =/LIKE）。deterministic，零 LLM。
【上下文】每次循环先读：src/store/schema.ts（无 FTS5）+ session-store.ts（写入路径）+ index.ts（querySessions）+ types.ts（SessionQuery）+ mcp/tools.ts（search_sessions 透传）+ roadmap T2.4.1。
【约束】改 schema.ts（只加 messages_fts 虚拟表 + 触发器，不改现有列/索引）+ session-store.ts（写入同步）+ index.ts（keyword→MATCH）+ tests/content-search.test.ts。零新依赖。不动 derive/briefing/trigger。
【完成判据】`npx vitest run content-search` 全绿 + typecheck；检查者 sub-agent 确认①采集不回归（总数不回退）②元数据与正文搜索可组合 ③旧库自动补建 FTS。
【验证命令】`npx vitest run content-search && npm run typecheck` 必须 exit 0。

规则：未通过就把错误输出当新上下文继续修，直到验证全绿才停。注意只加 FTS、不改现有表列。不许撒谎声称通过。
