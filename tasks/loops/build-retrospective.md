---
id: build-retrospective
title: 构建·单 session 复盘 + 一键提 issue
status: draft
feature: retrospective
verifier: "bash -c 'npx vitest run src/retrospective && npm run typecheck && node scripts/docs/check-features.mjs && ymesh retrospective --help >/dev/null 2>&1 && ymesh issue --help >/dev/null 2>&1'"
created: 2026-07-26
last_run:
---

## 1. 目标 (Goal)

实现"agent 任务做完后自动复盘 + 把复盘产物作为 user story 提交到 GitHub issue"的完整闭环。
复盘产物必须满足三段式结构：**事实层（deterministic，零 LLM）** → **叙事层（agent LLM 润色）** → **issue 提交层（shell-out 到 `gh` CLI）**。

### 达标标准（acceptance criteria）

**A. `src/retrospective/redact.ts` — 纯函数脱敏**
- A1. 输入字符串，输出脱敏后字符串；永不抛错（try/catch 兜底返回原串）
- A2. 必脱敏的模式：
  - env 变量名（`*_TOKEN` / `*_KEY` / `*_SECRET` / `*_PASSWORD` / `*_API_KEY`）
  - `.env` 行（`KEY=VALUE` 形式，VALUE 长度 ≥ 8 时整段替换为 `<redacted>`）
  - API key 前缀模式：`sk-` / `ghp_` / `gho_` / `ghs_` / `ghr_` / `AKIA` / `xoxb-` / `AIza` 后跟至少 16 个字符
  - macOS 绝对路径中的 home 目录：`/Users/<name>/` → `~/`，`/home/<name>/` → `~/`
  - 邮箱（RFC 5322 简化版）
  - macOS 绝对路径下 `.ssh` / `.aws` / `.gnupg` 后整段截断
- A3. 不误伤 ymesh session id / git commit hash / IPv4 / 公开 URL
- A4. 纯函数 + 无 I/O + 可单测

**B. `src/retrospective/generator.ts` — 复盘数据组装（deterministic）**
- B1. 输入：`{ sessionId, store }`，输出 `RetrospectiveFact` 结构
- B2. 必含字段：
  - `originalNeed`：首条真实 user 消息（剥 task-notification / file-list 头）
  - `toolCalls`：工具调用次数 + 工具名列表（按调用顺序）
  - `toolCallCount`：总数
  - `detours`：命中 `DEFAULT_FAILURE_PATTERNS` 的消息片段 + 位置（seq）+ 命中模式
  - `stuckSegments`：复用 `derive/stuck.ts` 检测的卡住段（可选，未启用则空数组）
  - `sessionMeta`：source / cwd / projectPath / startedAt / lastSeenAt / messageCount
  - `firstUserMessageAt`：首条 user 消息时间戳
  - `durationSec`：lastSeenAt - startedAt
- B3. 不调用 LLM；不写文件；只读 store

**C. `src/retrospective/narrative.ts` — markdown 骨架**
- C1. 输入 `RetrospectiveFact`，输出 markdown 字符串
- C2. 模板必须含 5 段：背景 / 工具调用路径 / 弯路 / 用户故事模板 / 抽象能力建议
- C3. 用户故事段落预留 `<FILL: ...>` 槽位，agent LLM 填充

**D. CLI `ymesh retrospective`**
- D1. `ymesh retrospective [--session <id>] [--output <path>] [--json] [--no-redact]`
- D2. 默认 session = `resolveSelfSession`（env `YONDERMESH_SELF_SESSION_ID` → cwd 匹配）
- D3. 默认输出到 stdout（markdown）；`--json` 输出 `RetrospectiveFact` JSON
- D4. `--output <path>` 写文件
- D5. 失败时 exit 1 + stderr 透传错误（遵循 ARCHITECTURE §III.5）

**E. CLI `ymesh issue create`**
- E1. `ymesh issue create --title <t> [--body <text>] [--body-file <path>] [--label <l>...] [--repo <owner/name>] [--dry-run]`
- E2. 默认 repo：从 `git remote get-url origin` 推断
- E3. 内部 `execSync('gh issue create ...')`，失败透传 stderr，exit 1
- E4. `--dry-run`：打印将执行的 `gh` 命令但不执行
- E5. `--body-file -`：从 stdin 读 body

**F. 真实数据验证**
- F1. 用 `~/.yondermesh/yondermesh.db` 中至少 5 个真实调用过 ymesh 命令的 session 跑 `ymesh retrospective --json`，全部不崩
- F2. 其中至少 1 个 session 的 `detours` 字段非空（命中失败模式）
- F3. 脱敏后字符串不含原 home 路径（grep 不到 `/Users/zoran`）

**G. doc-sync & features.yaml**
- G1. `npm run sync --prefix site` 重新生成 `site/reference/cli.md`（en + zh）含新命令
- G2. `docs/features.yaml` 新增 `retrospective` + `issue-submit` 两条，状态 `shipped`
- G3. `node scripts/docs/check-features.mjs` 打印"通过"
- G4. `node scripts/docs/check-drift.mjs` 通过

## 2. 上下文 (Context)

读以下文件理解模式：
- `src/briefing/generator.ts` + `src/briefing/generator.test.ts` — generator + 单测模式
- `src/bin/ymesh.ts` `cmdBriefing`（第 2336 行）+ `cmdHandoff`（第 1482 行）— CLI 命令模式
- `src/derive/prior-attempts.ts` `DEFAULT_FAILURE_PATTERNS`（第 106 行）— 失败模式正则
- `src/mcp/codex-handoff.ts` — handoff 数据结构
- `src/store/session-store.ts` — `getMessages(sessionId)` / `getSession(id)`
- `src/bin/ymesh.ts` `cmdUpdate`（第 1787 行）— `execSync` shell-out 模式
- `docs/features.yaml` — feature SSOT
- `ARCHITECTURE.md` §III.5（Failure is never silent）/ §III.6（deterministic-first kernel）
- `tasks/loops/build-briefing.md` — loop 写法参考
- `tasks/loops/verify-handoff.md` — 真实数据 verifier 写法参考

## 3. 行动约束 (Action)

**允许改：**
- 新建 `src/retrospective/{redact,generator,narrative,index}.ts` + `*.test.ts`
- `src/bin/ymesh.ts` 追加 `cmdRetrospective` + `cmdIssueCreate` + 在 `switch` 加 case + 在 `cmdHelp` 加帮助文本
- `docs/features.yaml` 追加 2 条
- `site/reference/cli.md` + `site/reference/cli.zh-CN.md`（通过 `npm run sync --prefix site` 生成，不手改）

**禁止改：**
- store schema
- daemon 协议
- MCP server 注册（MCP 工具留作下一轮 loop，本轮只做 CLI）
- 任何 adapter

**约束：**
- 零 LLM（kernel 不变式）
- `redact.ts` 必须纯函数 + 永不抛错
- `generator.ts` 只读 store
- `ymesh issue create` 失败必须 stderr 透传

## 4. 观察与反馈 (Observation)

### 测试集：真实本地 session

测试集来源：`~/.yondermesh/yondermesh.db` 中调用过 ymesh 命令的 session（约 20+ 条，含 claude-code/codex/trae-ide 三种 source）。

获取测试集 ID：
```bash
sqlite3 ~/.yondermesh/yondermesh.db \
  "SELECT DISTINCT s.id FROM sessions s JOIN messages m ON m.session_id=s.id \
   WHERE m.content LIKE '%ymesh %' OR m.content LIKE '%yondermesh%' \
   ORDER BY s.started_at DESC LIMIT 10;"
```

### verifier

```bash
bash -c '
  set -e
  # 1. 单测
  npx vitest run src/retrospective
  # 2. typecheck
  npm run typecheck
  # 3. features.yaml 校验
  node scripts/docs/check-features.mjs
  # 4. 命令存在性
  ymesh retrospective --help >/dev/null 2>&1
  ymesh issue --help >/dev/null 2>&1
  # 5. 真实数据 smoke test：取 5 个真实 session 跑 retrospective --json，全部 exit 0
  SIDS=$(sqlite3 ~/.yondermesh/yondermesh.db "SELECT DISTINCT s.id FROM sessions s JOIN messages m ON m.session_id=s.id WHERE m.content LIKE \"%ymesh %\" OR m.content LIKE \"%yondermesh%\" ORDER BY s.started_at DESC LIMIT 5;")
  for sid in $SIDS; do
    ymesh retrospective --session "$sid" --json >/dev/null || exit 1
  done
  # 6. 脱敏 smoke：输出不含原 home 路径
  OUT=$(ymesh retrospective --session "$(echo "$SIDS" | head -1)" --json 2>/dev/null)
  echo "$OUT" | grep -q "/Users/zoran" && exit 1 || true
  # 7. issue dry-run
  ymesh issue create --title "test" --body "test" --dry-run >/dev/null 2>&1
  echo "OK"
'
```

### 检查者 sub-agent 对抗审查清单
- redact 是否漏脱敏某种 API key 模式？（手造 5 个反例跑 redact.test.ts）
- generator 在空 session / 仅 1 条消息 / 无 tool_call 三种边界是否崩？
- narrative 输出 markdown 是否含全部 5 段标题？
- `ymesh issue create` 不传 `--title` 时是否给清晰错误？
- `--dry-run` 输出的 `gh` 命令是否真的可执行（copy-paste 到 shell 能跑）？

## Prompt

你是 loop 执行者，必须用 sub-agent 执行，自验证到通过才停。不许撒谎。

执行步骤：

1. **读上下文**：用 sub-agent 读 §2 列出的所有文件，输出模式总结（500 字内）。

2. **实现 redact.ts + 测试**：纯函数脱敏，覆盖 A2 全部模式。先写 `redact.test.ts`（含正例反例各 ≥ 3），再写 `redact.ts` 让测试过。跑 `npx vitest run src/retrospective/redact.test.ts` 到全绿。

3. **实现 generator.ts + 测试**：消费 `SessionStore.getMessages(sessionId)` + `DEFAULT_FAILURE_PATTERNS`，产出 `RetrospectiveFact`。用 `:memory:` store + mock 数据测，覆盖空 session / 1 消息 / 多 tool_call / 命中失败模式 4 个用例。

4. **实现 narrative.ts + 测试**：纯函数把 `RetrospectiveFact` → markdown 5 段骨架，含 `<FILL: ...>` 槽位。

5. **接线 CLI**：在 `src/bin/ymesh.ts` 加 `cmdRetrospective` + `cmdIssueCreate`，遵循 `cmdBriefing` 模式；在 `switch` 加 case；在 `cmdHelp` 加帮助文本。

6. **跑真实数据 smoke**：用 §4 的 SQL 取 5 个真实 session ID，跑 `ymesh retrospective --session <id> --json`，全部 exit 0。检查输出不含 `/Users/zoran`。

7. **issue 命令 dry-run**：`ymesh issue create --title "test" --body "test" --dry-run` 必须打印 `gh issue create ...` 命令但不执行。

8. **doc-sync**：跑 `npm run sync --prefix site` 重新生成 `site/reference/cli.md`（en + zh）。

9. **features.yaml**：追加 `retrospective` + `issue-submit` 两条，`status: shipped`。跑 `node scripts/docs/check-features.mjs` 必须打印"通过"。

10. **跑 verifier**：§4 的 verifier bash 脚本必须打印 `OK`。

11. **检查者 sub-agent 审查**：另起 sub-agent 按 §4 的对抗审查清单逐条验证，发现问题回 step 2 修，直到全过。

每步完成后向主 agent 报告：改了哪些文件 / 测试结果 / 下一步。verifier 全过 + 检查者全过才算 loop 完成。
