---
id: build-tool-calls-schema
title: 构建·结构化工具调用入 store（B 方案根治）
status: draft
feature: retrospective
verifier: "bash -c 'npx vitest run src/store src/retrospective src/claude src/codex src/hermes src/cass src/trae-cli src/trae-ide && npm run typecheck && node scripts/docs/check-features.mjs'"
created: 2026-07-26
last_run:
---

## 1. 目标 (Goal)

**根因修复 issue #1**：当前 5 个 adapter（claude/codex/trae-cli/hermes/cass）的 importer 在采集时显式排除 tool_use / function_call / tool_calls 字段，导致 yondermesh DB 永久丢失结构化工具调用信息，retrospective generator 拿到的 `toolCallCount` 永远是 0。

**B 方案**：扩 store schema 加 `message_tool_calls` 表 + 改 `SessionMessageInput` 类型 + 改 5 个 adapter importer 把工具调用塞进去 + 加 `ymesh reimport` 命令补历史数据 + 更新 generator 消费新表。

### 达标标准（acceptance criteria）

**A. store schema 扩展**
- A1. 新增表 `message_tool_calls`：
  ```sql
  CREATE TABLE IF NOT EXISTS message_tool_calls (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id   INTEGER NOT NULL,  -- FK messages.id
    session_id   TEXT NOT NULL,
    call_seq     INTEGER NOT NULL,  -- 同一条消息内第几次调用（0-based）
    tool_name    TEXT NOT NULL,
    tool_input   TEXT,              -- JSON string of arguments
    FOREIGN KEY (message_id) REFERENCES messages(id),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX idx_mtc_message ON message_tool_calls(message_id);
  CREATE INDEX idx_mtc_session ON message_tool_calls(session_id);
  ```
- A2. 不动 `messages` 表结构（避免 12M 行 ALTER）
- A3. schema.ts `MIGRATION_COLUMNS` 不需新增（新表用 CREATE IF NOT EXISTS）
- A4. 老库（已有 messages）跑 daemon/scan 时新表自动建（幂等）

**B. SessionStore API 扩展**
- B1. `SessionMessageInput` 加可选字段 `toolCalls?: ToolCallInput[]`
- B2. `ToolCallInput` 类型：`{ callSeq: number; toolName: string; toolInput?: string }`
- B3. `SessionMessage`（读取类型）加可选字段 `toolCalls?: ToolCall[]`
- B4. `getMessages(sessionId)` 返回时 LEFT JOIN `message_tool_calls` 聚合
- B5. upsert 时先写 messages 拿 id，再批量 INSERT message_tool_calls（事务内）
- B6. 单测：mock store 写入 + 读取，断言 toolCalls 往返一致

**C. 5 个 adapter importer 改造**
- C1. **claude**（`src/claude/importer.ts:461`）：content 数组里 `block.type === 'tool_use'` 不再丢弃，提取 `{ name, input }` 填 `toolCalls`
- C2. **codex**（`src/codex/importer.ts:654`）：`payload.type === 'function_call'` 不再排除，提取 `{ name, arguments }` 填 `toolCalls`
- C3. **trae-cli**（`src/trae-cli/importer.ts`）：读取 `agent_steps[].tool_calls` 字段，提取 `{ name, arguments }`
- C4. **hermes**（`src/hermes/importer.ts:248`）：SELECT 加 `tool_calls` / `tool_name` 列，`role='tool'` 行的 content + tool_name 填到对应 assistant 消息的 toolCalls
- C5. **cass**（`src/cass/importer.ts`）：`role='tool'` 行入库时关联到前一条 assistant 消息的 toolCalls
- C6. **trae-ide**（`src/trae-ide/extractor.ts`）：保持现状（actions[] 是 AI 摘要非原始 tool_call），但 `actions[]` 拼进 content 时不变；仅 `tool_call_count` 用 `actions.length` 填
- C7. 每个 adapter 单测覆盖：有 tool_use / 无 tool_use / 多 tool_use 三种用例

**D. ymesh reimport 命令**
- D1. `ymesh reimport --source <name> [--limit <n>] [--dry-run]`：重新扫描指定 source 的全部 session，把工具调用补进 `message_tool_calls` 表
- D2. 幂等：重复跑不会重复插入（按 message_id + call_seq UNIQUE）
- D3. 实测：`ymesh reimport --source claude --limit 5` 后，5 个 session 的 `toolCallCount > 0`
- D4. 默认 `--dry-run` 安全；非 dry-run 加 `--yes` 确认

**E. retrospective generator 升级**
- E1. `extractToolCalls` 优先用 `messages[i].toolCalls` 字段（结构化），fallback 到原来的 content 正则扫描
- E2. `toolCallCount` = 结构化 toolCalls 总数
- E3. 单测：mock 一条含 toolCalls 的消息，断言 generator 输出 toolCallCount > 0

**F. 真实数据验证**
- F1. `ymesh reimport --source claude --limit 5` 后跑 `ymesh retrospective --json`，5 个 session 中至少 3 个 `toolCallCount > 0`
- F2. codex / hermes 同样验证
- F3. trae-ide 用 `actions[]` 计数，至少 1 个 session `toolCallCount > 0`

**G. doc-sync & features.yaml**
- G1. `npm run sync --prefix site` 重新生成 cli.md（含 `ymesh reimport`）
- G2. `docs/features.yaml` 的 `retrospective` 条目加注"v2 含结构化工具调用"
- G3. `node scripts/docs/check-features.mjs` 通过

## 2. 上下文 (Context)

读以下文件理解现状：
- `src/store/schema.ts:74-85` — messages 表 schema
- `src/store/schema.ts:233-253` — MIGRATION_COLUMNS 模式
- `src/store/types.ts:29,53-57` — MessageRole / SessionMessageInput
- `src/store/session-store.ts` — upsert + getMessages 实现
- `src/claude/importer.ts:445-471` — extractDisplayText（排除 tool_use）
- `src/codex/importer.ts:650-673` — extractDisplayText（排除 function_call）
- `src/hermes/importer.ts:248-253,360-372` — SQL + extractMessages
- `src/cass/importer.ts:282-292,343-363` — normalizeRole
- `src/trae-cli/importer.ts:154-199` — extractChatMessages
- `src/trae-ide/extractor.ts:249-272` — actions[] 拼接
- `src/retrospective/generator.ts:233-267` — extractToolCalls（content 正则）
- `ARCHITECTURE.md §III` — 不变式（schema 不在其中）
- `tasks/loops/build-retrospective.md` — 上一轮 loop 上下文

## 3. 行动约束 (Action)

**允许改：**
- `src/store/{schema,types,session-store}.ts` + 单测
- `src/{claude,codex,hermes,cass,trae-cli,trae-ide}/importer.ts` 或 `extractor.ts` + 单测
- `src/retrospective/generator.ts` 升级 extractToolCalls + 单测
- `src/bin/ymesh.ts` 加 `cmdReimport` + case + help
- `site/reference/cli.md`（自动生成）
- `docs/features.yaml`

**禁止改：**
- daemon 协议
- MCP server 注册
- 其他 adapter（amp/aider/continue/...共 22 个）—— 它们保留 stub，importer 不动；本轮只做 5 个有真实数据的
- `messages` 表结构（避免 12M 行 ALTER）

**约束：**
- 零 LLM
- reimport 必须幂等
- 失败透传 stderr
- 不破坏现有 adapter 测试

## 4. 观察与反馈 (Observation)

### 测试集：5 个真实 source 的 session

```bash
sqlite3 ~/.yondermesh/yondermesh.db <<'SQL'
SELECT s.source, s.id, s.native_session_id, s.message_count
FROM sessions s
WHERE s.source IN ('claude','claude-code','codex','hermes','cass','trae-cli','trae-ide')
  AND s.message_count > 5
ORDER BY s.started_at DESC
LIMIT 10;
SQL
```

### verifier

```bash
bash -c '
  set -e
  # 1. 单测全过
  npx vitest run src/store src/retrospective src/claude src/codex src/hermes src/cass src/trae-cli src/trae-ide
  # 2. typecheck
  npm run typecheck
  # 3. features
  node scripts/docs/check-features.mjs
  # 4. reimport 命令存在
  npx tsx src/bin/ymesh.ts reimport --help >/dev/null 2>&1
  # 5. reimport claude 5 条后跑 retrospective
  SIDS=$(sqlite3 ~/.yondermesh/yondermesh.db "SELECT s.id FROM sessions s WHERE s.source IN (\"claude\",\"claude-code\") AND s.message_count > 10 ORDER BY s.started_at DESC LIMIT 5;")
  COUNT_OK=0
  for sid in $SIDS; do
    OUT=$(npx tsx src/bin/ymesh.ts retrospective --session "$sid" --json 2>/dev/null)
    TCC=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"toolCallCount\",0))" 2>/dev/null || echo 0)
    [ "$TCC" -gt 0 ] && COUNT_OK=$((COUNT_OK+1))
  done
  [ $COUNT_OK -ge 3 ] || { echo "FAIL: only $COUNT_OK/5 sessions have toolCallCount>0"; exit 1; }
  echo "PASS: $COUNT_OK/5 claude sessions have toolCallCount>0"
  # 6. codex 同样
  SIDS_C=$(sqlite3 ~/.yondermesh/yondermesh.db "SELECT s.id FROM sessions s WHERE s.source=\"codex\" AND s.message_count > 5 ORDER BY s.started_at DESC LIMIT 3;")
  COUNT_C=0
  for sid in $SIDS_C; do
    OUT=$(npx tsx src/bin/ymesh.ts retrospective --session "$sid" --json 2>/dev/null)
    TCC=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get(\"toolCallCount\",0))" 2>/dev/null || echo 0)
    [ "$TCC" -gt 0 ] && COUNT_C=$((COUNT_C+1))
  done
  [ $COUNT_C -ge 1 ] || { echo "FAIL: no codex session has toolCallCount>0"; exit 1; }
  echo "PASS: $COUNT_C/3 codex sessions have toolCallCount>0"
  echo "=== ALL OK ==="
'
```

### 检查者 sub-agent 对抗审查清单
- schema 改动是否影响老库（已有 12M messages）？跑 `ymesh status` 必须正常
- reimport 是否真的幂等？连跑两次，message_tool_calls 行数不变
- claude importer 是否还能正常采集不含 tool_use 的旧 session？
- generator 在 messages[i].toolCalls 为 undefined 时 fallback 到正则扫描是否正常？
- 5 个 adapter 测试是否全过（无 regression）？

## Prompt

你是 loop 执行者，必须用 sub-agent 执行，自验证到通过才停。不许撒谎。

执行步骤：

1. **读上下文**：用 sub-agent 读 §2 列出的所有文件，输出"现状摘要 + 改造点清单"（800 字内）。

2. **改 store schema**：在 `src/store/schema.ts` 加 `message_tool_calls` 表 + 2 个索引。不动 messages 表。

3. **改 store types**：在 `src/store/types.ts` 加 `ToolCallInput` / `ToolCall` 类型；`SessionMessageInput` 加 `toolCalls?`；`SessionMessage` 加 `toolCalls?`。

4. **改 session-store.ts**：upsert 时若 messages 含 toolCalls，先 INSERT message 拿 id，再批量 INSERT message_tool_calls（同事务，幂等：INSERT OR IGNORE 按 message_id+call_seq UNIQUE）。getMessages 时 LEFT JOIN 聚合 toolCalls 数组。加单测。

5. **改 5 个 adapter importer**：
   - claude：content 数组遍历时 tool_use 块提取 name+input 填 toolCalls
   - codex：payload.type==='function_call' 提取 name+arguments 填 toolCalls
   - hermes：SQL 加 tool_calls 列；role='tool' 行关联到 assistant
   - cass：role='tool' 行入库时关联前一条 assistant
   - trae-cli：trajectory 的 agent_steps[].tool_calls 字段读取
   每个 adapter 加/改单测覆盖有/无/多 tool_use 三种情况。

6. **改 generator.ts**：extractToolCalls 优先用 messages[i].toolCalls；fallback 到原正则。加单测。

7. **加 ymesh reimport 命令**：cmdReimport + case + help。`--source <name> [--limit <n>] [--dry-run] [--yes]`。内部调用对应 adapter 的 importer 重新扫描。

8. **doc-sync**：`npm run sync --prefix site` 重新生成 cli.md。

9. **features.yaml**：retrospective 条目加注 "v2 含结构化工具调用"。

10. **跑 verifier**：§4 bash 脚本必须打印 `=== ALL OK ===`。

11. **检查者清单**：§4 末尾 5 条对抗审查，逐条验证。

每步向主 agent 简报。verifier 全过 + 检查者全过才算 loop 完成。
