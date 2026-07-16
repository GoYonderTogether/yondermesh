---
title: Mount 系统
description: yondermesh 把非侵入式扩展（MCP server、skill、always-on 段落）挂载到各 CLI 自己的配置目录 —— 绝不修改 CLI 二进制。
outline: [2, 3]
---

# Mount 系统

Mount 系统是 yondermesh 在不修改其它 CLI 的前提下扩展它们的方式。**Mount** 把一个 ymesh 扩展安装到 CLI 自己的配置目录（`~/.claude/`、`~/.codex/`、`~/.cursor/` 等）。CLI 通过自己原生的配置读取机制发现扩展 —— ymesh 只往 CLI 的配置目录写文件和符号链接，绝不修补 CLI 二进制或它的 session 写入器。

这是 yondermesh 四平面架构（Local、Sync、Mount、Trigger）中的 **Mount 平面**。它实现在 `src/mount/`，是把 ymesh 能力注入机器上每个支持的 CLI 的唯一入口。

yondermesh 端到端支持 **28 个 CLI** —— mount 系统触达那些暴露配置文件接口的 CLI，触发层（`src/trigger/`）则触达全部 28 个 CLI 用于同步消息注入。两个平面刻意分开：mount 关注被动存在（MCP 配置、skill、always-on 上下文），trigger 关注主动投递（cli-spawn / stdin / http-api / ws-rpc / tmux / applescript）。

## Mount 是什么

一个 mount 是一个三元组 *(CLI, 扩展, 策略)*：

- **CLI** 是目标，如 `codex`、`claude-code`、`cursor`、`trae`。每个在 `src/mount/registry.ts` 中声明，含一个探测规则（通常是"`~/.<dir>` 是否存在？"）和一组能力。
- **扩展** 是 ymesh 想安装的东西：MCP server、skill 或 always-on 段落。`src/mount/manager.ts` 的 `defaultExtensions()` 是 ymesh 挂载内容的规范列表。
- **策略** 是某种扩展类型在某个 CLI 上的安装方式：`mcp-json`、`mcp-toml`、`mcp-toml-array`、`claude-mcp`、`skill-symlink`、`always-on`。策略实现在 `src/mount/strategies.ts`。

每个策略知道如何对自己的扩展类型执行 `mount`、`unmount`、`isMounted`。Mount 管理器遍历"检测到的 CLI × 扩展"，把每对分发给匹配的策略。

## 三种扩展类型

`src/mount/types.ts` 的 `ExtensionType` 精确定义了三种：

- **`mcp-server`** —— 写入 CLI 的 MCP 配置（JSON 或 TOML，取决于 CLI）的 stdio MCP server 条目。server 本身就是 `ymesh mcp`。见 [MCP Server](/zh/guide/mcp)。
- **`skill`** —— 指向 `releases/current/skills/<name>/` 下某个 ymesh skill 的、放进 CLI skill 目录的符号链接。见 [Skills 系统](/zh/guide/skills)。
- **`plugin`**（always-on 段落）—— 注入到 CLI 某个全局指令文件（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules`、`.windsurfrules` 等）的带边界标记段落。段落告诉每个新 session：ymesh 已安装及其能力。

默认扩展集（`src/mount/manager.ts` 的 `defaultExtensions()`）挂载：

1. yondermesh MCP server（`mcp-server`）。
2. `yondermesh-diagnose` skill（`skill`）。
3. `trae-awareness` skill（`skill`）—— Trae 专属的 always-on 替代品。
4. yondermesh awareness 段落（`plugin` / always-on）。

并非每个 CLI 都支持每种扩展类型。Mount 管理器会跳过 CLI 不支持的 `(cli, 扩展)` 对，并报告为 `unsupported`，而不是报错。

## Mount 管理命令

```bash
ymesh mount status    # 查看各处挂载了什么
ymesh mount all       # 把每个默认扩展挂载到每个检测到的 CLI
ymesh mount remove    # 从每个 CLI 卸载所有 ymesh 扩展
```

`ymesh mount all` 是幂等的：重复运行会刷新符号链接并重写配置块以匹配当前 release。它是 `ymesh update` 后拉取新 ymesh 版本的推荐方式。

### `ymesh mount status`

遍历每个检测到的 CLI 和每个默认扩展，报告当前是否已挂载。输出是一组 `(cli, extension, type, strategy, mounted)` 行。用于验证挂载往返，或排查某个 CLI 为何没接入 ymesh。

### `ymesh mount all`

通过每个 `CliTarget.detect()` 规则检测已安装的 CLI（过滤掉 OpenSpace 残留目录），然后对 CLI 支持的每个 `(cli, 扩展)` 对，分发给匹配策略。结果收集为 `MountResult` 行，含 `success`、`message` 和解析出的目标路径。

### `ymesh mount remove`

从每个检测到的 CLI 卸载所有 ymesh 扩展。对配置重写策略，移除 ymesh 块；对 `skill-symlink`，移除符号链接；对 `claude-mcp`，调用 `claude mcp remove`。可安全重复执行。

## 支持的 CLI 及其策略

yondermesh 端到端支持 **28 个 CLI** —— 每一个都可以通过 `ymesh send` / `yondermesh_send`（触发平面）同步注入；暴露配置文件接口的那些还可以被挂载（挂载平面）。下面的公开 CLI 覆盖表（源数据在 `src/mount/registry.ts`）展示的是挂载平面策略；触发平面覆盖更广，位于 wrapper 注册表（`src/mcp/tools.ts` 的 `WRAPPER_LOADERS`）。

| CLI | MCP 挂载 | Skill 挂载 | Always-on 注入 |
|---|---|---|---|
| codex | mcp-toml (`~/.codex/config.toml`) | skill-symlink (`~/.codex/skills/`) | `~/.codex/AGENTS.md` |
| claude-code | claude-mcp (`claude mcp add`) | — | `~/.claude/CLAUDE.md` |
| cursor | mcp-json (`~/.cursor/mcp.json`) | skill-symlink (`~/.cursor/skills/`) | `~/.cursorrules` |
| gemini | mcp-json (`~/.gemini/settings.json`) | — | `~/.gemini/GEMINI.md` |
| windsurf | mcp-json (`~/.codeium/windsurf/mcp_config.json`) | skill-symlink (`~/.codeium/windsurf/skills/`) | `~/.windsurfrules` |
| trae | — | skill-symlink (`~/.trae/skills/`) | — |
| trae-cn | — | skill-symlink (`~/.trae-cn/skills/`) | — |
| continue | — | skill-symlink (`~/.continue/skills/`) | — |

注册表声明了更多 CLI（Factory、Vibe、CodeBuddy、Copilot、Pi / OMP / GSD-Pi、OpenHands、Goose、Crush、Cline、Antigravity、Amp、Qwen、Hermes 以及 IDE 共享变体）。部分 CLI（Aider、OpenClaw、Kimi、ChatGPT 桌面版）未声明任何挂载能力，会被检测但不挂载。完整的自动生成实时矩阵见 [CLI 适配器](/zh/reference/adapters) 页面。至于触发平面覆盖 —— 也就是 `ymesh send` 能跟 28 个 CLI 里的哪些对话 —— 见 `src/mcp/tools.ts` 的 wrapper loader；触发层独立于挂载层，能触达挂载无法触达的 CLI。

## 策略实现

每个策略位于 `src/mount/strategies.ts`，对外暴露 `mount` / `unmount` / `isMounted`。`src/mount/types.ts` 的 `MountStrategyType` 联合类型是规范列表。

### `mcp-json`（Cursor / Gemini / Windsurf / Factory / CodeBuddy / Copilot / Crush / Cline / Amp / Pi 系列 / Antigravity）

把 `mcpServers.<name>` 键写入 JSON 配置文件。文件路径按 CLI 从注册表解析（例如 `~/.cursor/mcp.json`、`~/.gemini/settings.json`）。挂载时安全读取 JSON（缺失或格式错误的文件视为 `{}`），设置 `mcpServers[ext.name] = { command, args, env? }`，再美化写回。卸载删除该键。`isMounted` 检查键是否存在。

### `mcp-toml`（Codex / OpenHands / Trae CLI / Goose）

用文本操作（无 TOML 解析器依赖）把 `[mcp_servers.<name>]` 段写入 TOML 配置文件。挂载时先移除同名的已有段（含 `[mcp_servers.<name>.env]` 子表），再追加新段，含 `command`、`args` 和可选的 `[mcp_servers.<name>.env]` 子表。卸载移除该段。`isMounted` 检查 `[mcp_servers.<name>]` 头是否存在。

### `mcp-toml-array`（Vibe）

把 `[[mcp_servers]]` array-of-tables 条目写入 TOML 配置文件。Vibe 用 array-of-tables 而非 Codex 的命名子表。每条含 `name`、`transport`、`command`、`args` 和超时字段。挂载时先移除 `name` 匹配的已有条目，再在文件末尾追加新条目（顶层 scalar 不受影响，规避 TOML "scalar 在 table 之后" 的陷阱）。卸载移除匹配条目。

### `claude-mcp`（Claude Code）

Claude Code 把 MCP server 配置存在内部数据库，而非 JSON 文件。此策略通过 `claude` CLI 完成：`claude mcp add <name> -s user -- <command> <args…>` 挂载，`claude mcp remove <name> -s user` 卸载。挂载时先移除已有条目（幂等）。`isMounted` 运行 `claude mcp list` 检查名称。这是 `ymesh mount all` 使用的策略；较早的 `ymesh mcp register` 直接写 `~/.claude.json` —— 两者都可行，Mount 系统是推荐路径。

### `skill-symlink`（Codex / Cursor / Windsurf / Trae / Trae CN / Continue / Factory / Vibe / CodeBuddy / Copilot / Pi 系列 / OpenHands / Goose / Crush / Cline / Antigravity / Amp）

创建从 `<cli skills 目录>/<name>` 到 `releases/current/skills/<name>` 的目录符号链接。挂载时按需创建 skills 目录，移除目标路径上已有的链接（无论指向哪里），再创建新符号链接。`isMounted` 校验链接存在、是符号链接、且目标包含 `yondermesh`、`ymesh` 或 `release` —— 避免其它工具创建的同名链接被误判。见 [Skills 系统](/zh/guide/skills)。

### `always-on`（Codex / Claude Code / Cursor / Gemini / Windsurf 等）

把带边界标记的段落注入 CLI 某个全局指令文件（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`.cursorrules`、`.windsurfrules`、Hermes 的 `SOUL.md` 等）。段落用 `<!-- YONDERMESH_AWARENESS_START -->` / `<!-- YONDERMESH_AWARENESS_END -->` 标记包裹，可幂等查找和替换。挂载时先移除已有块，再追加新块。`isMounted` 检查两个标记是否都存在。段落内容由 `src/mount/manager.ts` 的 `generateContextBlock()` 生成，告诉 agent ymesh 已安装、有哪些 MCP 工具、可用哪些 CLI 命令。

## Trae 四变体覆盖机制

Trae 实际有四个客户端变体需要全覆盖：Trae IDE（国际版）、Trae IDE CN（中文版）、Trae Work（国际版）、Trae Work CN（中文版）。ymesh 用 **两个** `CliTarget` 条目（`trae` + `trae-cn`）覆盖全部 4 个变体：

- 物理上只有 2 个用户级目录：`~/.trae`（国际版）和 `~/.trae-cn`（中文版）。
- 每个目录下，Trae IDE 和 Trae Work 共享用户级 `skills/` 目录（它们用不同 profile，但用户级 skills 目录是共享的）。
- 所以挂 2 个 `CliTarget`（`trae` + `trae-cn`）即覆盖 4 个变体（IDE + Work × 国际 + 中文）。

Trae 的挂载策略与其它 CLI 有两点重要差异：

- **不支持 always-on 注入。** Trae 不读取 `project_rules.md` 之类的全局指令文件（它通过 system prompt + skills 目录注入，不读全局指令文件）。ymesh 改用 `trae-awareness` skill 替代 always-on awareness 段落，让 Trae 在 session 启动时就能在 skill 列表里发现 ymesh。这就是 `defaultExtensions()` 把 `trae-awareness` skill 与通用 awareness 段落分开推送的原因。
- **不支持文件挂 MCP。** Trae 通过 IDE 设置界面配置 MCP，不是文件可挂。要在 Trae 里使用 ymesh MCP 工具，请在 Trae 设置里手动添加 MCP server：command `ymesh`，args `["mcp"]`。见 [MCP Server - Trae](/zh/guide/mcp#trae)。

## 验证

`ymesh mount status` 是规范的验证命令。它针对每个检测到的 CLI 和每个默认扩展，报告当前是否已挂载、用哪种策略。在 `ymesh mount all` 之后用它确认全部落地，在 `ymesh mount remove` 之后用它确认全部清理干净。

每个策略的状态检查与挂载检查一致：`mcp-json` 查 `mcpServers` 键、`mcp-toml` 扫描段头、`claude-mcp` 运行 `claude mcp list`、`skill-symlink` 校验符号链接目标、`always-on` 检查两个边界标记。只有当策略的特定检查通过时才报告 `mounted: true` —— 而不是仅仅文件存在。

## 相关

- [MCP Server](/zh/guide/mcp) —— `mcp-server` 扩展类型与 `ymesh mcp` server。
- [Skills 系统](/zh/guide/skills) —— `skill` 扩展类型与 `skill-symlink` 策略。
- [CLI 适配器](/zh/reference/adapters) —— 自动生成的 CLI 支持实时矩阵。
- [CLI 命令](/zh/reference/cli) —— `ymesh mount` 子命令参考。
