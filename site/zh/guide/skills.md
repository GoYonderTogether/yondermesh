---
title: Skills 系统
description: yondermesh 自带 markdown 定义的 skill，用于扩展 agent 能力 —— 随仓库发布，挂载时由 mount 系统 symlink 到各 CLI 自己的 skill 目录。
outline: [2, 3]
---

# Skills 系统

**Skill** 是一种 markdown 定义的能力包，用于扩展 agent 能力而不修改 agent 本身。yondermesh 在仓库的 `skills/` 目录里附带若干 skill，挂载时把每个 skill symlink 到所有支持的 CLI 自己的 skill 目录。agent 像发现自己原生 skill 一样发现它 —— ymesh 只是放了一个链接。

执行这个挂载的策略是 `skill-symlink`，实现在 `src/mount/strategies.ts`，按 CLI 在 `src/mount/registry.ts` 中声明。它是 [Mount 系统](/zh/guide/mount) 安装的三种扩展类型之一（另外两种是 MCP server 配置和 always-on 段落）。

## Skill 是什么

Skill 是一个目录，至少包含一个 `SKILL.md` 文件。markdown frontmatter 声明 skill 的 `name` 和 `description`，宿主 CLI 据此决定何时把 skill 暴露给 agent。`SKILL.md` 正文是 skill 激活时 agent 加载的指令集，可以引用同目录下的其它文件（脚本、参考、子配置）。

Skill **不是**插件二进制，也**不是** MCP 工具。它是纯文本指令包。宿主 CLI 决定如何消费它，ymesh 只确保该目录能从 CLI 的 skill 查找路径访问到。

## ymesh skill 存放位置

随仓库发布的 skill 位于 `skills/<name>/`：

```text
skills/
  doc-sync/
    SKILL.md
  new-cli-onboarding/
    SKILL.md
  trae-awareness/
    SKILL.md
  yondermesh-diagnose/
    SKILL.md
    agents/
      openai.yaml
    references/
      healthy-state.md
      known-issues.md
    scripts/
      diagnose.sh
```

ymesh 安装时，`buildRelease()` 会把 `skills/` 目录复制到版本化 release 目录 `~/.yondermesh/releases/<version>/skills/`。`~/.yondermesh/bin/ymesh` 符号链接指向当前 release，因此 `releases/current/skills/<name>/` 始终反映激活版本。运行 `ymesh update` 切换 `current` 符号链接时，skill 自动更新。

## Skill 链接机制

把 skill 链接到 CLI 的 skill 目录有两条代码路径。它们机制相同（指向 release 的 `skills/<name>/` 的符号链接），但调用时机不同。

### 挂载时链接（`src/mount/strategies.ts`）

`skillSymlinkStrategy` 是 `ymesh mount all` 使用的路径。对于注册表中声明了 `skill-symlink` 能力的每个 CLI，ymesh：

1. 从注册表解析该 CLI 的 skill 目录（例如 `~/.codex/skills/`、`~/.cursor/skills/`、`~/.trae/skills/`）。
2. 若目录不存在则创建。
3. 对 `defaultExtensions()` 中的每个 ymesh skill，移除 `<skillsDir>/<name>` 处已有的符号链接（无论指向哪里），再创建一个新符号链接指向 `releases/current/skills/<name>`。

该策略通过检查链接目标是否包含 `yondermesh`、`ymesh` 或 `release` 来确认符号链接确实是 ymesh 挂载 —— 避免其它工具（如 marketplace）创建的同名符号链接被误判为 ymesh 挂载。

`isMounted()` 仅在符号链接存在、是符号链接、且指回 ymesh release 路径时返回 true。`unmount()` 移除符号链接，链接不存在时是 no-op。

### 安装时链接（`src/install/skill-linker.ts`）

`linkSkills()` / `unlinkSkills()` 是较早的安装时辅助函数，由 release 安装器调用。它把内置 skill 集合（当前是 `yondermesh-diagnose`）链接到一小段固定 CLI skill 目录列表。Mount 系统的 `skill-symlink` 策略是更全面的路径 —— 覆盖注册表声明的所有 CLI —— 所以日常使用建议用 `ymesh mount all`。

## 哪些 CLI 支持 skill 挂载

CLI 覆盖表（来自 `src/mount/registry.ts`）列出所有声明 `skill-symlink` 能力的 CLI。主要支持的 CLI：

| CLI | Skill 目录 |
|---|---|
| Codex | `~/.codex/skills/` |
| Cursor | `~/.cursor/skills/` |
| Windsurf | `~/.codeium/windsurf/skills/` |
| Trae（国际版） | `~/.trae/skills/` |
| Trae CN（中文版） | `~/.trae-cn/skills/` |
| Continue | `~/.continue/skills/` |

注册表中的其它 CLI（Factory、Vibe、CodeBuddy、Copilot、Pi / OMP / GSD-Pi、OpenHands、Goose、Crush、Cline、Antigravity、Amp 以及 IDE 共享变体）也声明了 `skill-symlink` 能力。完整的实时矩阵在 [CLI 适配器](/zh/reference/adapters) 页面重新生成。

Claude Code **不**支持通过 skill 目录挂载 skill —— 它没有基于文件的 skill 查找。ymesh 改用 always-on 段落和 MCP server 接入 Claude Code。

## 内置 skill

随仓库发布、会被链接到所有支持 CLI 的 skill：

- **`yondermesh-diagnose`** —— 系统健康检查。遍历 ymesh 安装、数据库、daemon 和日志，报告哪些健康哪些不健康。默认挂载集始终包含此 skill，任何 agent 都能按需运行诊断。
- **`trae-awareness`** —— 路标 skill，告诉 Trae session ymesh 存在及其能力。Trae 不读取全局指令文件（没有 always-on 注入点），所以这个 skill 是替代方案：Trae 在 session 启动时就能在 skill 列表里看到 ymesh。默认挂载集专门为 Trae 目标包含此 skill。
- **`doc-sync`** —— 让文档与代码保持同步。文档生成器工作流使用。
- **`new-cli-onboarding`** —— 把新 CLI 适配器接入 ymesh 的引导工作流。

前两个由 `src/mount/manager.ts` 的 `defaultExtensions()` 推送；后两个随仓库发布，可供显式链接或由 agent 直接读取。

## 添加自定义 skill

发布自己的 skill：

1. 创建目录 `skills/<your-skill-name>/`，内含 `SKILL.md`。frontmatter 必须声明 `name` 和 `description`。

   ```markdown
   ---
   name: my-team-conventions
   description: Use when writing code in the monorepo — covers naming, test layout, and review checklist.
   ---

   # My Team Conventions

   ...
   ```

2. 可选地添加子目录（`scripts/`、`references/`、`agents/`）放置 `SKILL.md` 引用到的支撑文件。

3. 重新运行挂载步骤，把新 skill 链接到所有地方：

   ```bash
   ymesh mount all
   ```

`src/mount/manager.ts` 的 `defaultExtensions()` 列表控制挂载系统自动链接哪些 skill。随 `skills/` 发布但不在该列表里的 skill 仍然可用 —— agent 可直接从 release 目录读取，或你手动把符号链接放进 CLI 的 skill 目录。

因为 skill 是纯 markdown，你可以和代码放在同一仓库里版本化、在 PR 中评审、随 ymesh release 一起前滚或回滚。

## 相关

- [Mount 系统](/zh/guide/mount) —— ymesh 如何把扩展安装到各 CLI 的配置目录。
- [MCP Server](/zh/guide/mcp) —— ymesh 向 agent 暴露能力的另一种方式。
- [文件布局](/zh/reference/files) —— 安装后 skill 在磁盘上的位置。
- [CLI 适配器](/zh/reference/adapters) —— 哪些 CLI 支持哪些扩展类型的完整实时矩阵。
