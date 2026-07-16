---
name: new-cli-onboarding
description: >-
  将一个新的 CLI/agent 接入 yondermesh 生态的完整清单与规约。Use when: 用户说
  "接入新 CLI"、"支持新的 agent"、"添加 XXX CLI"、"ymesh 怎么适配新 cli"、
  "怎么写 adapter"、"挂载策略怎么选"、"source 别名怎么加"，或一个新 CLI
  需要同时被采集 session 与被挂载 MCP/skill/插件时。覆盖：session 采集 adapter
  选型、挂载策略矩阵、source 别名、mount registry 注册、测试与文档闭环。
  适用于 maintainer 在 src/ 落地新 CLI 接入；终端用户不需要本 skill。
---

# 接入新 CLI 清单

本 skill 指导如何将一个新的 CLI/agent 接入 yondermesh 生态。yondermesh 对一个
CLI 的"接入"由 **两条独立轴线** 组成，必须分别评估、分别落地：

1. **Session 采集轴**（读）：把该 CLI 在本机产生的 session 收进 yondermesh Vault。
2. **挂载轴**（写）：把 yondermesh 的 MCP / skill / 插件挂到该 CLI，让它能用
   ymesh 能力并向 agent 注入 awareness。

两条轴线互相独立：一个 CLI 可以只采集（如 cass 已覆盖的 cli 不需要再写原生
adapter），也可以只挂载（如 Trae 没有 JSONL 但可以挂 skill-symlink），最好两条
都齐。

## 设计约束（来自项目历史需求）

接入新 CLI 时必须遵守这些从用户需求中提炼的硬约束：

1. **只读采集**：绝不写入 CLI 私有 session 文件 / 私有 DB。cass 以 `readOnly`
   打开，原生 adapter 只扫描 JSONL。违反此约束会破坏架构 §2 关键取舍。
2. **用户不需要知道 cass 是什么**：用户视角只看到 ymesh 扫出的 session 归属于
   哪个真实 CLI（claude / codex / cursor...），不暴露 cass 这个内部 provider 名。
   落地：`source` 字段写底层 agent slug（已归一化的 canonical 名），而不是 cass。
3. **跨源去重**：同一物理 session 被 cass (coverage=B) 与原生 adapter (coverage=A)
   各导入一次时，必须能通过 `sessionMatchKey` 判定为重复，不重复入库。
4. **非侵入式挂载**：MCP / skill / 插件挂载必须可幂等安装、可幂等卸载，不破坏
   CLI 自身配置文件原有内容（always-on 用边界标记段落、mcp-* 只动自己的键）。
5. **安装即自动注册 + 可热更新**：新安装/已安装用户在新 session 启动时即生效；
   skill 通过 `releases/current` symlink 切换实现热更新；MCP/always-on 需重挂载
   才生效（无热更新机制时由 `ymesh mount --refresh` 触发）。
6. **通用目录挂载**：所有 CLI 都应能挂 skill-symlink（最通用），其次才是 MCP /
   always-on（依赖 CLI 自身能力）。

## 接入清单

按顺序完成以下 6 项。每项有明确的"是否需要"判断与文件落点。

### 1. Session 采集 — 原生 adapter 选型

**判断**：该 CLI 是否已经在 cass 的 `agents.slug` 表里？

- **是** → cass importer 会自动以 coverage=B 导入（广覆盖、归一化消息、不可原生
  恢复）。**不需要**写原生 adapter。但仍需在 `src/store/source-aliases.ts` 注册
  slug → canonical 别名（见第 3 步）。
- **否** → 需要写原生 adapter（coverage=A，原生恢复级），放在 `src/<cli>/importer.ts`。

**原生 adapter 必备要素**（参考 `src/claude/importer.ts` / `src/codex/importer.ts`）：

- 默认 rootPath：`~/.<cli>/(sessions|projects|...)`，并通过 `<CLI>_<ROOT>_DIR` /
  `rootPath` 选项允许覆盖。
- 注册 `coverage='A'` 的 source instance。
- 调用 `store.registerSourceInstance` / `startScanRun` / `ingestSession` /
  `finishScanRun`，失败时 `finishScanRun({status:'failed', error})` 后再抛。
- **只读**：`fs.readFileSync` / `new DatabaseSync(path, {readOnly:true})`，绝不写。
- **流式**：单次只在内存持有一个 session / 一个 conversation 的消息，不一次性
  加载全部。
- **幂等**：依赖 `SessionStore.ingestSession` 的 content_hash 判定；脏行跳过、
  无有效消息的文件跳过、不抛。
- **provenance**：`source` 字段写 canonical 名（如 `claude`/`codex`），不是 cass
  slug；`nativeSessionId` 取该 CLI 自己的稳定 session id（UUID 优先，便于跨源
  matchKey 匹配 cass）。
- **消息提取**：只取 user/assistant 的可显示文本；排除 thinking / tool_use /
  tool_result / function_call / system prompt / 思维链。
- **关系**：subagent → parent 的 `spawned_by` 仅在父 session 同次扫描入库时建立；
  父未入库不猜测关系。
- **schema 校验**（cass 类）：缺表/缺列时给清晰错误并中断，写 `assertCassSchema`。

### 2. 挂载策略矩阵

**判断**：该 CLI 支持哪些非侵入式挂载方式？逐项检查：

| 现象 | 注册的策略 | extensionTypes | resolve 提供键 |
|---|---|---|---|
| 有 `~/.<cli>/mcp.json` 或 `settings.json` 含 `mcpServers` | `mcp-json` | `mcp-server` | `configPath` |
| 有 `~/.<cli>/config.toml` 含 `[mcp_servers.*]`（Codex 风格） | `mcp-toml` | `mcp-server` | `configPath` |
| 有 `claude mcp add/remove` 类 CLI 命令管理 MCP | `claude-mcp` | `mcp-server` | `cliBinary`, `home` |
| 有 `~/.<cli>/skills/` 目录或可创建 | `skill-symlink` | `skill` | `skillsDir` |
| 有全局指令文件（`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.<cli>rules`） | `always-on` | `plugin` | `instructionFile` |
| 以上都没有 | 该 CLI 仅作采集对象，不挂载（与 cass-only CLI 类似） | — | — |

**通用目录挂载**：如果该 CLI 支持读取 `~/.<cli>/skills/`，**必须**注册
`skill-symlink`（这是最通用的非侵入挂载，所有 skill 自动可用）。即使该 CLI 没
有 MCP 能力，只挂 skill-symlink 也是有效接入。

**Trae 类 CLI 注意**：不读取全局指令文件（没有 always-on 注入机制）时，必须依赖
`skill-symlink` + 一个 awareness skill（参考 `skills/trae-awareness/SKILL.md`）让
agent 在 skill 列表里发现 ymesh。新增此类 CLI 时同步新增一个对应的 awareness skill。

### 3. Source 别名注册

在 `src/store/source-aliases.ts` 的 `SOURCE_MAP` 中追加该 CLI 的所有别名 → canonical。
canonical 名通常等于 `registry.ts` 中的 `id`，但 source 归一化是按"逻辑 CLI 名"
而非"安装 id"（例如 `claude-code` 与 `claude` 都归一化为 `claude`）。

需要覆盖的别名形态：

- canonical 自身（`'<cli>'` → `'<cli>'`）
- 连字符 / 下划线 / 无分隔变体（`claude-code` / `claude_code` / `claudecode`）
- cass agents.slug 表里出现的形态（实测，决定 cass 导入时 source 字段的值）
- 大小写变体（normalizeSource 已 lower-case，但别名表必须用小写键）

未注册的 slug 会以原样写入 `source`，导致 `--source` 过滤不到数据，是历史痛点
（req [51]）。

### 4. Mount Registry 注册

在 `src/mount/registry.ts` 的 `CLI_REGISTRY` 数组追加一项 `CliTarget`：

```ts
{
  id: '<cli>',                       // 与 source-aliases canonical 一致
  displayName: '<CLI Display Name>',
  homeDir: '.<cli>',                 // ~ 下的配置目录
  detect: (home) => existsSync(join(home, '.<cli>')),
  capabilities: [ /* 第 2 步选出的策略 */ ],
}
```

每个 capability 的 `resolve` 必须返回该策略实现需要的键（见上表）。`detect`
应基于稳定路径（通常是配置目录本身），不要基于正在运行的进程。

**`unsupported` 策略**：当一个 CLI 不支持某种扩展类型时，不需要在 capabilities
里写 `unsupported` —— `MountStrategyType` 中的 `'unsupported'` 是 status 显示/
统计过滤用的占位值，由 mount runner 在运行时填充，不在 registry 注册。

### 5. 测试

**单元测试**（`<cli>.importer.test.ts` / `mount.<cli>.test.ts`）：

- importer：用一个 fixture JSONL/DB 跑完整 import，断言 inserted/updated/unchanged/
  skipped 计数；测试脏行跳过、无消息文件跳过、subagent 关系建立、父未入库不猜测关系。
- importer 幂等：连续 import 两次，第二次 `inserted=0, unchanged=N`。
- importer 只读：mock fs 断言无写调用到 CLI 私有路径。
- mount：对每个 capability 跑 mount/unmount/isMounted 三件套，断言幂等（重复
  mount 不产生重复段落 / 重复键）。

**端到端测试**：

- 真实 fixture（脱敏后的真实 session 文件）跑 importer，对比入库内容。
- `ymesh scan` 后 `ymesh sessions list --source <cli>` 能查到数据。
- `ymesh mount --cli <cli>` 后 `ymesh status` 显示 mounted=true；`ymesh unmount`
  后回到 false；原 CLI 配置文件内容除 ymesh 段外不变（diff 验证）。

**跨源去重测试**：

- 同一 session 被 cass 与原生 adapter 各导入一次，`sessionMatchKey` 相同，
  `ymesh sessions list` 不出现重复条目。

### 6. 文档

- `README.md`：在"已支持 CLI"列表加入该 CLI，标注采集方式（cass / 原生 adapter）
  与挂载策略。
- `docs/architecture.md` §2.2 覆盖等级表：如该 CLI 走原生 adapter，补一行
  coverage=A。
- 如果是 awareness 类 CLI（无 always-on），新增 `skills/<cli>-awareness/SKILL.md`。
- 本 skill 的"已接入 CLI 参考表"同步追加一行。

## 决策树

新 CLI 进来后按此顺序判断，每步 yes/no 决定下一步动作：

```
A. cass agents.slug 表里已有该 CLI？
   ├─ YES → cass 已 coverage=B 采集；跳到 D（不写原生 adapter）
   └─ NO  → 进入 B

B. 该 CLI 在本机有 JSONL / SQLite 形式的 session 文件？
   ├─ YES → 写原生 adapter (src/<cli>/importer.ts, coverage=A)
   │        注册 source instance；source 字段用 canonical 名
   └─ NO  → 该 CLI 不可采集；只做挂载（C 起步）

C. 跨源去重：原生 adapter 与 cass 都会扫到同一 session？
   └─ YES → nativeSessionId 用 UUID 形态，sessionMatchKey 自动判定重复；
            在 source-aliases.ts 把 cass slug 与 canonical 都映射到同一 canonical

D. 该 CLI 支持 MCP？
   ├─ 配置文件是 JSON 含 mcpServers 键 → 注册 mcp-json
   ├─ 配置文件是 TOML 含 [mcp_servers.*] → 注册 mcp-toml
   └─ 有 `claude mcp add` 类 CLI 命令    → 注册 claude-mcp

E. 该 CLI 有 ~/.<cli>/skills/ 目录或可创建？
   └─ YES → 注册 skill-symlink（强烈建议所有支持目录的 CLI 都加）

F. 该 CLI 读取全局指令文件（AGENTS.md / CLAUDE.md / .<cli>rules）？
   ├─ YES → 注册 always-on
   └─ NO  → 新增 skills/<cli>-awareness/SKILL.md 让 agent 在 skill 列表里发现 ymesh

G. 完成第 3-6 步（source-aliases / registry / 测试 / 文档）
```

## 已接入 CLI 参考表

当前 8 个已注册 CLI（来源 `src/mount/registry.ts`）：

| CLI id | homeDir | 采集方式 | 挂载策略 | source canonical |
|---|---|---|---|---|
| `codex` | `.codex` | 原生 adapter (A) + cass (B) | mcp-toml, skill-symlink, always-on (`AGENTS.md`) | `codex` |
| `claude-code` | `.claude` | 原生 adapter (A) + cass (B) | claude-mcp, always-on (`CLAUDE.md`) | `claude` |
| `cursor` | `.cursor` | cass (B) | mcp-json (`mcp.json`), skill-symlink, always-on (`.cursorrules`) | `cursor` |
| `gemini` | `.gemini` | cass (B) | mcp-json (`settings.json`), always-on (`GEMINI.md`) | `gemini` |
| `windsurf` | `.windsurf` | cass (B) | mcp-json (`mcp_config.json`), skill-symlink, always-on (`.windsurfrules`) | `windsurf` |
| `trae` | `.trae` | 无采集（无 JSONL） | skill-symlink only（无 always-on → 见 `trae-awareness` skill） | `trae` |
| `trae-cn` | `.trae-cn` | 无采集 | skill-symlink only | `trae` |
| `continue` | `.continue` | cass (B) | skill-symlink only | `continue` |

**采集 adapter 源文件**：

- `src/cass/importer.ts` — coverage=B，按 `agents.slug` 拆出真实 CLI（claude/codex/
  cursor/gemini/windsurf/continue/kimi/copilot/aider/opencode/openclaw/hermes 等）。
- `src/claude/importer.ts` — coverage=A，扫 `~/.claude/projects/**/*.jsonl`，解析
  root/subagent/sidechain。
- `src/codex/importer.ts` — coverage=A，扫 `~/.codex/sessions/**/rollout-*.jsonl`，
  按 session_meta 切分 + 跨文件按 nativeId 聚合。

**未注册但 cass 已能扫到的 CLI**（出现在 `source-aliases.ts` 但未在 registry）：
`opencode`、`hermes`、`kimi`、`copilot`、`openclaw`、`aider`。这些是"仅采集、未挂载"
的 CLI；用户如需挂载，按本 skill 决策树从 D 步起步。

## 检查清单（接入完必跑）

新 CLI 接入完成后，逐项跑一遍验证：

### 采集轴

- [ ] `npx tsx src/bin/ymesh.ts scan` 不报错；该 CLI 出现在 `ymesh sessions list`
      的 `--source` 选项里。
- [ ] `ymesh sessions list --source <canonical>` 能查到该 CLI 的 session。
- [ ] `ymesh sessions list --source <cass-slug>` 也能查到（别名展开生效）。
- [ ] 同一 session 被多源导入时不重复（matchKey 生效）。
- [ ] 连续两次 `ymesh scan` 第二次 `inserted=0, unchanged=N`（幂等）。
- [ ] importer 全程只读，未写 CLI 私有文件（用 `fs.statSync` 对比 mtime 验证）。

### 挂载轴

- [ ] `ymesh mount --cli <cli>` 成功；`ymesh status` 显示该 CLI 的 mounted=true。
- [ ] 重复 `ymesh mount` 不产生重复段落 / 重复键（幂等）。
- [ ] `ymesh unmount --cli <cli>` 后 `ymesh status` 显示 mounted=false。
- [ ] unmount 后该 CLI 原配置文件内容除 ymesh 段外完全恢复（`diff` 验证）。
- [ ] 该 CLI 启动新 session 时能在工具列表 / skill 列表 / 上下文里发现 ymesh
      （MCP 工具可用 / skill 可调用 / always-on 段落被注入）。
- [ ] 若该 CLI 无 always-on，对应的 `<cli>-awareness` skill 已存在并可被发现。

### 注册与文档

- [ ] `src/store/source-aliases.ts` 的 `SOURCE_MAP` 已加 canonical 与所有别名形态。
- [ ] `src/mount/registry.ts` 的 `CLI_REGISTRY` 已加该 CliTarget，`detect` 函数
      基于稳定路径。
- [ ] `README.md` 已支持 CLI 列表已更新。
- [ ] `docs/architecture.md` §2.2 覆盖等级表已补（如走原生 adapter）。
- [ ] 单元测试 + 端到端测试已写并通过。
- [ ] 本 skill 的"已接入 CLI 参考表"已追加一行。

### 健康检查

- [ ] `bash skills/yondermesh-diagnose/scripts/diagnose.sh` 全 PASS（adapters
      section 应显示该 CLI 的 source instance 与 scan_run 正常）。
- [ ] 新安装用户场景模拟：清空 `~/.yondermesh` 后重装 ymesh，新 session 能自动
      挂载并发现该 CLI（验证安装即自动注册）。

## 常见陷阱

1. **slug 没注册别名**：cass 导入时 source 写了 cass slug，但 source-aliases 没加，
   导致 `--source` 过滤不到。**修复**：把 slug 加进 SOURCE_MAP → canonical。
2. **nativeSessionId 不含 UUID**：cass 的 external_id 形如
   `-Users/.../UUID.jsonl`，原生 adapter 直接用 UUID，两者 matchKey 才能匹配。
   新 adapter 必须从 session 文件里提取 UUID 作为 nativeSessionId，否则去重失效。
3. **registry detect 写错**：detect 应判 `existsSync(join(home, '.<cli>'))`，不要
   判 `~/.<cli>/config.toml` 之类的子文件（用户首次安装但未启动 CLI 时子文件可能
   不存在，会漏检）。
4. **always-on 段落重复注入**：必须用 `CONTEXT_BLOCK_START/END` 边界标记 + 先移除
   再追加，不能直接 append。参考 `src/mount/strategies.ts` 的 `alwaysOnStrategy`。
5. **Trae 类 CLI 漏 awareness skill**：没 always-on 的 CLI 必须配 awareness skill，
   否则 agent 完全不知道 ymesh 存在，等于没接入。
6. **写采集 adapter 时引入写操作**：违反架构 §2 关键取舍。任何对 CLI 私有文件的
   写都是禁项；MCP/always-on 配置写入只针对 ymesh 自己的段落 / 键。
