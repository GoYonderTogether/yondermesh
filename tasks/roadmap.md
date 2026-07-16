# yondermesh 收敛与落地路线图

> 日期：2026-07-16 · 状态：active · 执行器：codex exec + glm-5.2
> 配套：`docs/product-strategy.md`（为什么）、`docs/doc-atlas.md`（漂移证据）、`specs/README.md`（spec 治理）
> 本文是唯一的执行清单。每个任务带**执行步骤**与**验收条件**，验收不过不算完成。

## 0. 诊断与原则

**一句话诊断**：文档不是落后于代码，而是超前于代码——README/官网描绘的是完全体（5 能力、28 CLI、E2E 同步），代码实际交付的是「采集 + 查询 + 挂载 + 23 CLI 同步注入」。

**三条铁律**：
1. **承诺 = 事实**。文档只描述有测试、能跑通的能力；未实现的标 `planned`，代码在但没发版的标 `preview`。
2. **分层清晰**。适配层（每个 CLI 的私有知识）、能力层（CLI 无关的业务）、接口层（CLI + MCP 薄壳）三层解耦，接口层与能力层禁止直接 import `src/<cli>/`。
3. **可验收**。每个任务有明确的验收命令或断言，`npm test` + `npm run typecheck` 是所有代码任务的地板。

**讲人话**：不造新词。已有概念沿用（session / 采集 / 挂载 / 注入 / 接力）。禁止发明"上下文总线""协作中枢"之外的新隐喻。

## 状态图例

`[ ]` 待办 · `[~]` 进行中 · `[x]` 完成且验收通过 · `[!]` 阻塞

每个任务的固定结构：**目标 / 执行步骤 / 验收条件 / 依赖 / 影响文件**。

## 里程碑总览

| 里程碑 | 主题 | 代码风险 | 任务 |
|---|---|---|---|
| **M0** | 真相对齐：文档降到事实 | 无（仅改文档） | T0.1–T0.4 |
| **M1** | 架构分层 + MCP 工具收敛 | 中（重构，行为不变） | T1.1–T1.4 |
| **M2** | 空壳功能重新规划（SDD 可验收） | 高（新实现或明确降级） | T2.1–T2.3 |
| **M3** | send 旗舰补齐 + spec-kit + 五轴 TDD | 中 | T3.1–T3.4 |
| **M4** | CI 护栏防复发 | 低 | T4.1–T4.3 |

执行顺序：M0 先行（消除对外风险）→ M1（打好分层地基）→ M2/M3 并行 → M4 收口。

---

## M0 — 真相对齐（仅改文档，零代码风险，最先做）

### [x] T0.1 能力状态标签体系 + README 降承诺
- **目标**：README / README.zh-CN 里每个能力带 `shipped | preview | planned` 标签，与代码事实一致。
- **执行步骤**：
  1. 在 README 顶部加图例：`shipped`=有测试有版本；`preview`=代码在、未发版；`planned`=未实现。
  2. 逐能力打标：Collect=shipped、Query=shipped、Mount=shipped、Hand off=shipped、Send=preview（未发版且缺 claude/codex）、Sync=planned、Daily briefing=planned。
  3. 路线图段：把 M1 里的 "cross-device sync" 和 "daily briefing" 从 `[x]` 移出，单列为 planned。
  4. README.zh-CN 同步；**删除中文版 line 3 "第一个" 这一不可证强断言**。
- **验收条件**：README 中不存在标为 shipped 但代码为 TODO 的能力；`grep -n "planned\|preview\|shipped" README.md` 三档齐全；zh 版无"第一个"。
- **依赖**：无。
- **影响文件**：`README.md`、`README.zh-CN.md`。

### [x] T0.2 清除幽灵工具名 + config.yaml 降级
- **目标**：所有对外文档不再出现代码里不存在的 MCP 工具名，config.yaml 不再冒充可用配置。
- **执行步骤**：
  1. 全仓搜 `recall_recent_work` / `whats_on_device` / `handoff_task`，在 CHANGELOG、site/index.md 等处替换为真实工具（`search_sessions` / `list_active_sessions` / `get_session_handoff`）。
  2. `README.md` 与 `site/reference/config.md` 的 `config.yaml`（devices/sync/mcp/briefing）标注 "planned — 当前 daemon 使用内置默认值，尚不解析 config.yaml"；把代码真实存在的配置字段（reconcileIntervalMs / debounceMs / skipCass / skipClaude / skipCodex / autoMount，见 `src/daemon/config.ts`）补成一张"当前生效配置"表。
- **验收条件**：`grep -rn "recall_recent_work\|whats_on_device\|handoff_task" README* CHANGELOG.md site/ scripts/` 零命中；config.md 有 planned 标注 + 真实字段表。
- **依赖**：无。
- **影响文件**：`CHANGELOG.md`、`site/index.md`、`site/reference/config.md`、`README.md`（+ zh 镜像）。

### [x] T0.3 数字与命令口径统一
- **目标**：适配器数、工具数、命令清单三处一致，且不再手写。
- **执行步骤**：
  1. 统计 `src/*/` 真实适配器目录数（排除 detect/mailbox/sdk/trigger/mount/store/mcp/daemon/install/extract/briefing/sync/bin/limited/index.ts）作为权威数字，README/CHANGELOG/help 统一。
  2. `ARCHITECTURE.md:42` 命令清单补全 `send / agents / waiting / launch / inject / transfer`（对齐 `src/bin/ymesh.ts` main() switch）。
  3. CHANGELOG "4 new skills" 改为实际 5 个。
- **验收条件**：README 适配器数 == help 输出数 == `ls -d src/*/ | 过滤后计数`；ARCHITECTURE 命令清单是 main() switch 的超集校验通过。
- **依赖**：无。
- **影响文件**：`README.md`（+zh）、`ARCHITECTURE.md`、`CHANGELOG.md`、`src/bin/ymesh.ts`（help 文本，如需）。

### [x] T0.4 站点首页与能力叙事对齐
- **目标**：site/index.md 反映五能力（含 Send），Sync 卡标 planned。
- **执行步骤**：补 Send 卡片；Sync 卡加 planned 徽标；Query 卡工具名换成真实工具；hero slogan 统一为"Self-hosted Agent Context Bus"（定义）+ 叙事一句。
- **验收条件**：`npm run --prefix site docs:build`（或等价）通过；index.md 五能力齐全无幽灵工具名。
- **依赖**：T0.1、T0.2。
- **影响文件**：`site/index.md`、`site/zh/index.md`。

---

## M1 — 架构分层 + MCP 工具收敛（重构，行为不变，先写测试锁行为）

### 三层架构目标（本里程碑的北极星）

```
接口层  src/bin/ymesh.ts (CLI)  ·  src/mcp/ (MCP server)     ← 薄壳：解析入参、调能力层、格式化输出
  │  禁止 import src/<cli>/*
能力层  src/store · src/mailbox · src/trigger · src/mount     ← CLI 无关业务；通过"适配器注册表"拿 CLI 能力
  │  只依赖注册表接口，不 import 具体 CLI
适配层  src/adapters/registry.ts + src/<cli>/{importer,wrapper,inject}.ts  ← 每个 CLI 的私有知识集中登记
```

核心不变式：**接口层和能力层永不出现 `import ... from '../<cli>/...'`**；所有 CLI 具体能力经 `src/adapters/registry.ts` 的统一注册表获取（当前散落在 `tools.ts` 的 `WRAPPER_LOADERS`、`registry.ts` 的 `CLI_REGISTRY`、`cmdScan` 的 27 段 try/catch）。

### [x] T1.1 建立统一适配器注册表
- **目标**：一个 `src/adapters/registry.ts` 汇总每个 CLI 的 importer / wrapper / inject / mount 能力与元信息，取代三处分散登记。
- **执行步骤**：
  1. 定义 `AdapterDescriptor { id, displayName, coverage, importer?, wrapperLoader?, injectLoader?, mountCapabilities, channels[] }`。
  2. 用一份数组登记所有 CLI（数据可从现有 `WRAPPER_LOADERS` + `CLI_REGISTRY` + `cmdScan` 归并）。
  3. 提供 `getAdapter(id)` / `listAdapters()` / `listImporters()` / `loadWrapper(id)`。
- **验收条件**：新注册表单测覆盖 getAdapter/listAdapters；`npm run typecheck` 过；**不改变** `ymesh scan`/`mount`/`send` 现有行为（回归测试通过）。
- **依赖**：无。
- **影响文件**：新增 `src/adapters/registry.ts`、`tests/adapters-registry.test.ts`。

### [x] T1.2 接口层/能力层去除对 src/<cli> 的直接依赖
- **目标**：`cmdScan` / `tools.ts` / `trigger/adapter.ts` 改为经 T1.1 注册表取 CLI 能力。
- **执行步骤**：cmdScan 遍历 `listImporters()`；tools.ts 的 `WRAPPER_LOADERS` 改用 `loadWrapper(id)`；trigger 的 wrapper 解析走注册表。
- **验收条件**：`grep -rn "from '\.\./[a-z-]*/wrapper" src/mcp src/trigger src/bin` 零命中（除注册表本身）；全测试通过；`ymesh scan` 采集的 source 数不回退。
- **依赖**：T1.1。
- **影响文件**：`src/bin/ymesh.ts`、`src/mcp/tools.ts`、`src/trigger/adapter.ts`。

### [x] T1.3 MCP 工具收敛（25 → 精简正交集）
- **目标**：消除新旧两套（13 legacy + 12 `yondermesh_*`）重复，给出单一、正交、LLM 友好的工具集 + 明确废弃表。
- **背景（当前 25 个，重叠严重）**：
  - 查询重叠：`search_sessions` ≈ `yondermesh_query_sessions`；`get_session_detail` ≈ `yondermesh_get_session`；`get_overview` / `get_session_relations` / `list_active_sessions` / `who_is_working` / `who_is_waiting`。
  - 控制重叠：`yondermesh_launch_agent` + `yondermesh_inject_session` + `yondermesh_send` 三者语义交叠；`yondermesh_transfer_session` + `get_session_handoff`。
  - 消息重叠：`post_message`/`get_messages`（v2）vs `yondermesh_mailbox_*`（v2）vs `yondermesh_send`（v3）。
- **建议目标集（约 8 个，最终以 T1.3 的设计评审为准）**：
  1. `search_sessions`（合并 query_sessions，含拓扑/来源/项目/时间过滤 + search 关键字，须真正实现 search）
  2. `get_session`（合并 detail + relations + live）
  3. `list_active`（合并 list_active_sessions + who_is_working + who_is_waiting）
  4. `overview`（全局统计）
  5. `handoff`（生成接力包，合并 get_session_handoff）
  6. `send`（同步注入，合并 launch/inject/transfer 到 mode 参数：new/running/stopped/transfer；补 claude/codex）
  7. `mailbox`（异步留言读写，合并 post/get/reply/check）
  8. `agents`（列出适配器与挂载状态，合并 list_agents + mount_status）
- **执行步骤**：先写 `specs/mcp-spec.md`（工具契约 + 废弃时间表：旧名保留一个版本并在 description 标 `deprecated, use X`）→ 实现合并 handler → 旧工具变薄 alias 转发 → 更新测试。
- **验收条件**：`listTools()` 返回精简集；每个旧工具名仍可调用但标 deprecated；`tests/mcp-*.test.ts` 全绿；`specs/mcp-spec.md` 有完整契约。
- **依赖**：T1.1。
- **影响文件**：`src/mcp/server.ts`、`src/mcp/tools.ts`、`specs/mcp-spec.md`、`tests/mcp-*.test.ts`。

### [ ] T1.4 MCP server 单一装配点
- **目标**：`server.ts` 不再内联定义 13 个 legacy 工具，全部工具统一来自注册表（`MCP_TOOLS`），server 只负责 JSON-RPC 传输 + 路由 + mailbox piggyback hint。
- **执行步骤**：把 legacy 工具迁进 `tools.ts` 的 `MCP_TOOLS`（或标 deprecated 的兼容层），`listTools`/`callTool` 单一来源。
- **验收条件**：`server.ts` 无内联工具定义；MCP 握手（initialize/tools/list/tools/call）测试通过；本机 `codex mcp` / claude 可正常列出工具。
- **依赖**：T1.3。
- **影响文件**：`src/mcp/server.ts`、`src/mcp/tools.ts`。

---

## M2 — 空壳功能重新规划（每个先写 SDD 可验收文档，再决定实现或降级）

### [ ] T2.1 config.yaml：实现最小可用解析
- **目标**：daemon 真正读取 `~/.yondermesh/config.yaml`（若存在），否则用默认值。范围只覆盖代码已有的字段。
- **执行步骤**：
  1. 写 `docs/sdd/config-loader.md`：字段清单（只含已实现的 reconcileIntervalMs/debounceMs/skip*/autoMount）+ 默认值 + 缺失/损坏时的回退行为 + 验收门。
  2. 用零依赖的极简 YAML 子集解析（或 JSON5 风格），不引入新依赖（遵循项目"不引入新依赖"约定）；无法零依赖则改为 `config.json`。
  3. daemon 启动时加载并 merge 默认值。
- **验收条件**：给定 fixture config 文件，daemon config 字段被正确覆盖；文件缺失时用默认值；损坏时告警但不崩溃；单测覆盖三种情况。**文档 config 字段 == 代码解析字段**。
- **依赖**：无。
- **影响文件**：`src/daemon/config.ts`、`tests/config-loader.test.ts`、`docs/sdd/config-loader.md`、`site/reference/config.md`。

### [ ] T2.2 每日简报：从 TODO 变最小可用
- **目标**：`ymesh briefing`（或 daemon 定时）生成真实简报：N 个 agent、M 台设备（当前恒为本机 1）、K 个任务、按项目/来源分组、卡住的 session 提示。
- **执行步骤**：
  1. 写 `docs/sdd/briefing.md`：数据来源全部是 SessionStore 现有查询（getSessionStats / getActiveSessionsSummary / getSourceBreakdown），"成功率""卡住"用可确定性判定的口径（如"最近 N 小时无更新且最后一条是 assistant 提问"），**不引入 LLM**。
  2. 实现 generator，输出 Markdown 到 `~/.yondermesh/briefings/YYYY-MM-DD.md`。
  3. 加 `ymesh briefing [--date] [--json]` 命令。
- **验收条件**：用本机真实 store 跑出一份非空简报；数字与 `ymesh sessions`/`ymesh status` 交叉核对一致；单测用 fixture store 断言分组正确。README briefing 由 planned 升 shipped。
- **依赖**：无。
- **影响文件**：`src/briefing/generator.ts`、`src/bin/ymesh.ts`、`tests/briefing.test.ts`、`docs/sdd/briefing.md`。

### [ ] T2.3 跨设备同步：明确降级为 planned + 写清 SDD（本轮不实现）
- **目标**：不假装有 sync。文档全面降级，代码空壳加显式"未实现"错误而非静默。
- **执行步骤**：
  1. 写 `docs/sdd/sync.md`：目标架构（E2E 加密、relay 只见密文、outbox 模型）+ 为何本轮不做（单机闭环优先）+ 未来验收门。作为 planned 的正式设计留档。
  2. `src/sync/agent.ts` 的 `sync()` 改为抛 `Error('sync 尚未实现（planned）')`，不再静默 `void this.store`。
  3. README/site 的 sync 全部标 planned，`site/guide/sync.md` 移入 roadmap 页或加显著 planned 横幅。
- **验收条件**：全仓无"sync 已交付"表述；调用 sync 路径给出明确未实现错误；`docs/sdd/sync.md` 存在。
- **依赖**：T0.1。
- **影响文件**：`src/sync/agent.ts`、`docs/sdd/sync.md`、`README.md`（+zh）、`site/guide/sync.md`。

---

## M3 — send 旗舰补齐 + spec-kit + 五轴 TDD

### [ ] T3.1 send 支持 Claude Code 与 Codex（旗舰不可缺）
- **目标**：`ymesh send --cli claude` / `--cli codex` 可用（当前 WRAPPER_LOADERS 缺这俩）。
- **执行步骤**：为 claude/codex 提供 trigger 通道（claude: `claude -p`/`--resume`；codex: `codex exec`/`codex exec resume`），接入注册表 channels。
- **验收条件**：`ymesh send --cli codex --mode new -m "回复 OK"` 真实拿到回复（本机 glm-5.2）；claude 同理（或 skip-when-absent）；单测用 FakeTriggerAdapter 覆盖两者路由。
- **依赖**：T1.1、T1.2。
- **影响文件**：`src/codex/wrapper.ts`、`src/claude/wrapper.ts`（新建/补全）、`src/adapters/registry.ts`、`tests/send-flagship.test.ts`。

### [ ] T3.2 trigger 层补真实单测（当前 1748 行零断言）
- **目标**：`tests/trigger-e2e.test.ts` 从 0 断言脚本变成真单测；覆盖 ReplyAdapter 纯函数各分支 + TriggerAdapter 模式路由（用 Fake）。
- **验收条件**：ReplyAdapter 的 stripAnsi/各 CLI filter/collapseBlankLines 分支覆盖；3 模式路由断言；`npm test` 中 trigger 用例 > 15 个且全绿。
- **依赖**：无。
- **影响文件**：`tests/trigger.test.ts`（新）、`tests/reply-adapter.test.ts`（新）。

### [ ] T3.3 specs/agents/*.yaml 能力档案（Tier-0 四家先行）
- **目标**：claude/codex/hermes/openclaw 各一份机器可读能力档案，取代手维护的 atlas 表格。
- **执行步骤**：按 `specs/README.md §4` 的 schema 写 4 份 yaml；写 `scripts/docs/gen-agents.mjs` 从 yaml 生成 `site/reference/adapters.md` 的 Tier-0 段 + `ymesh doctor` 数据。
- **验收条件**：4 份 yaml schema 校验通过；生成的 adapters.md Tier-0 段与 yaml 一致；`wiring` 字段由脚本扫源码填充（非手写）。
- **依赖**：T1.1。
- **影响文件**：`specs/agents/{claude,codex,hermes,openclaw}.yaml`、`scripts/docs/gen-agents.mjs`。

### [ ] T3.4 五轴验证测试骨架（Tier-0）
- **目标**：为 Tier-0 四家建五轴测试骨架：V1 采集 / V2 删除后存活 / V3 实时增量 / V4 注入生效 / V5 转交续做。
- **执行步骤**：写 `tests/five-axis/<cli>.test.ts` 模板；能自动跑的自动跑，需真实 CLI 的用 skip-when-absent。CLI 支持等级以此测试通过情况标注。
- **验收条件**：四家五轴测试文件存在并在 CI 中运行；至少 V1（采集）对四家全绿。
- **依赖**：T3.3。
- **影响文件**：`tests/five-axis/*.test.ts`。

---

## M4 — CI 护栏（防复发）

### [ ] T4.1 修 gen-adapters.mjs 生成器 bug
- **目标**：排除 detect/mailbox/sdk/trigger 等非适配器目录（白名单/黑名单），修复 factory 遗漏。
- **验收条件**：`adapters.md` 不含非适配器行，含 factory；`check-drift.mjs` 通过。
- **影响文件**：`scripts/docs/gen-adapters.mjs`。

### [ ] T4.2 新增 gen-mcp-docs.mjs 管线
- **目标**：`site/reference/mcp-tools.md` 从 `listTools()` 自动生成，消除漏 8 个工具的问题。
- **验收条件**：生成的 mcp-tools.md == listTools() 工具集；接入 sync-all.mjs。
- **依赖**：T1.3、T1.4。
- **影响文件**：新增 `scripts/docs/gen-mcp-docs.mjs`、`scripts/docs/sync-all.mjs`。

### [ ] T4.3 claims-lint 断言检查
- **目标**：CI 扫描 README/site，拦截三类漂移：已废弃工具名、硬编码适配器数字、shipped 标签指向无测试模块。
- **验收条件**：故意插入一个幽灵工具名，lint 报错；正常文档通过。
- **依赖**：T0.*。
- **影响文件**：新增 `scripts/docs/claims-lint.mjs`、`.github/workflows/docs-check.yml`。

---

## 附：codex + glm-5.2 执行协议

每个任务用一次 `codex exec` 驱动，标准调用：

```bash
codex exec --sandbox workspace-write --skip-git-repo-check \
  -c model="glm-5.2" \
  "读 tasks/roadmap.md 的 <任务号>。只做该任务。完成后运行 npm run typecheck && npm test，
   贴出验收命令的真实输出。不碰其他任务的文件。"
```

规则：
- **一次一个任务**，M0 各任务可连做（纯文档）。代码任务（M1+）逐个验收。
- 每个任务完成后由主控（本 agent）核对验收条件，通过才把 `[ ]` 改 `[x]`。
- 失败两次 → 停下诊断根因，不盲目重试。
- key 硬编码只要不进 git 即可（`specs/adapter-spec.md` 的 key 已在 gitignored 目录，但仍建议轮换）。
- 每个任务一个 commit（遵循 CLAUDE.md：中文 commit message，粒度小）。
