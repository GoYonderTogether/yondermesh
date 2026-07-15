---
title: 文件布局
description: yondermesh 的仓库、源码、运行时与文档站文件布局 — 每个目录的用途以及哪些文档是自动生成的。
outline: [2, 3]
---

# 文件布局

本页绘制 yondermesh 项目的全景：代码在哪、运行时写哪些文件、哪些文档是手写 vs 自动生成。依据 `ARCHITECTURE.md` 与实际仓库目录树整理。

## 仓库布局

仓库顶层结构：

```
yondermesh/
├── src/                  TypeScript 源码（daemon、MCP server、adapters、store 等）
├── tests/                Vitest 测试套件（每个 adapter 一个 *.test.ts + 核心模块）
├── site/                 VitePress 文档站（本站）
├── scripts/              仓库脚本
│   ├── extract_bp_sessions.py
│   └── docs/             文档生成流水线（sync-all.mjs、gen-*.mjs、check-drift.mjs、verify-links.mjs）
├── skills/               随仓库发布的 ymesh skills（doc-sync、trae-awareness 等）
├── specs/                内部规格（adapter-spec.md）
├── .github/workflows/    CI：docs-deploy.yml、docs-check.yml
├── .ymesh-runtime/       本地运行时状态（current.json）— 不属于公开安装
├── AGENTS.md             规范 agent 指令
├── ARCHITECTURE.md       全景 codemap（本页的事实来源）
├── CHANGELOG.md          发布历史（/reference/changelog 的事实来源）
├── CONTRIBUTING.md       贡献指南
├── README.md             项目概览 + 快速上手
├── SECURITY.md           安全策略
├── LICENSE               MIT
├── install.sh            引导安装脚本
├── package.json          npm 清单
├── tsconfig.json         TypeScript 配置
└── vitest.config.ts      测试运行器配置
```

## src/ 布局

每个受支持的 CLI agent 在 `src/` 下都有自己的目录。每个 adapter 遵循相同的文件模式（并非每个 adapter 都有全部文件 — 实时矩阵见 `/reference/adapters`）。

```
src/
├── bin/
│   └── ymesh.ts            CLI 入口（argv 解析、命令分发）
├── index.ts                公共 SDK 入口 — 再导出 adapter 类型
├── store/                  Session 存储（唯一写 SQLite 的地方）
│   ├── index.ts            SessionStore 类 — 查询面
│   ├── schema.ts           SQLite schema（CREATE TABLE / 索引）
│   ├── session-store.ts    Upsert / 去重逻辑
│   ├── source-aliases.ts   原始 source 名 -> 规范 source ID
│   └── types.ts            SessionRecord、SessionQuery、SessionStats 等
├── daemon/                 Daemon 生命周期
│   ├── index.ts            YondermeshDaemon（start/stop、scan+watch+reconcile 循环）
│   └── config.ts           defaultDaemonConfig / defaultDataDir（YONDERMESH_HOME）
├── mcp/                    MCP server
│   ├── server.ts           McpServer 类 — stdio JSON-RPC、工具列表（见 /reference/mcp-tools）
│   ├── register.ts         注册到 Claude Code / Codex
│   ├── codex-handoff.ts    为 handoff_task / ymesh handoff 构建 HandoffPackage
│   ├── tools.ts            工具辅助
│   └── index.ts            Barrel
├── mount/                  Mount 系统（非侵入式 CLI 扩展）
│   ├── manager.ts          mountAll / unmountAll / verifyAll
│   ├── registry.ts         受支持 CLI + 每个 CLI 的策略
│   ├── strategies.ts       mcp-toml、claude-mcp、mcp-json、skill-symlink、always-on
│   ├── types.ts            CliTarget、MountStrategy、MountResult
│   └── index.ts
├── install/                安装 / release / 更新
│   ├── release.ts          buildRelease / installRelease / listReleases / rollbackRelease
│   ├── launcher.ts         ~/.yondermesh/bin/ymesh 符号链接
│   ├── updater.ts          updateFromGit（clone/pull -> build -> 原子符号链接切换）
│   ├── skill-linker.ts     把 skills/ 符号链接到各 CLI 的 skill 目录
│   ├── paths.ts            中心路径解析（resolveDataDir、resolveDbPath 等）
│   ├── version.ts          版本比较辅助
│   └── index.ts
├── extract/                项目历史提取
│   ├── extractor.ts        extractProject -> NDJSONL 文件（requirements + responses）
│   ├── index.ts            queryExtracts 带过滤读回
│   └── types.ts
├── briefing/
│   └── generator.ts        每日摘要 -> ~/.yondermesh/briefings/
├── sync/
│   └── agent.ts            跨设备 sync agent（仅密文）
├── detect/                 CLI 检测（本机装了哪些 agent）
│   ├── agents.ts
│   └── index.ts
├── limited/                Limited-session bridge
│   ├── session-bridge.ts
│   └── index.ts
├── sdk/                    新 adapter 的公共 SDK 脚手架
│   ├── base-importer.ts
│   ├── base-injector.ts
│   ├── base-wrapper.ts
│   ├── scaffold.ts
│   ├── template.ts
│   ├── types.ts
│   └── index.ts
├── aider/                  单 CLI adapter（完整列表见 /reference/adapters）
│   ├── importer.ts         A 级：原生 importer
│   ├── wrapper.ts          B 级：launcher
│   ├── inject.ts           B 级：配置片段
│   └── index.ts            公共导出
├── amp/                    ...同样模式...
├── antigravity/
├── cass/                   （仅 importer）
├── chatgpt/                （仅 extractor — C 级）
├── claude/                 （仅 importer）
├── cline/
├── codebuddy/
├── codex/                  （仅 importer）
├── continue/
├── copilot/
├── crush/
├── cursor-ide/             （仅 extractor — C 级）
├── factory/
├── gemini/
├── goose/
├── hermes/
├── kimi/
├── openclaw/
├── opencode/
├── openhands/
├── pi/                     （importer + rpc.ts）
├── qwen/
├── trae-cli/
├── trae-ide/               （仅 extractor — C 级）
├── vibe/
└── windsurf/               （仅 extractor — C 级）
```

Adapter 文件模式：

- `importer.ts` — **A 级**：原生 importer。直接读 CLI 的原生 session 文件写入 `SessionStore`。
- `wrapper.ts` — **B 级**：构建调用被包装 CLI 的命令行。是 launcher，不是 session reader。
- `inject.ts` — **B 级**：生成注入 CLI 自身配置的片段（MCP JSON、agents.md、plugin hooks）。
- `extractor.ts` — **C 级**：实时提取器（如 transcript hook）。部分覆盖；通常补充 B 级 wrapper。
- `index.ts` — adapter 的公共导出。`scripts/docs/gen-adapters.mjs` 读取每个 `index.ts` 头部注释作为支持矩阵备注。

## 运行时布局

yondermesh 运行时写入的文件。数据目录默认 `~/.yondermesh/`，可通过 `YONDERMESH_HOME` 覆盖（见 `/reference/config`）。

```
~/.yondermesh/
├── config.yaml              用户配置（由 `ymesh init` 生成）
├── yondermesh.db            SQLite 数据库 — SessionStore 唯一写入目标
├── daemon.pid               PID 文件（daemon 单实例锁）
├── key.pem                  sync 用的 E2E 加密密钥（首次运行自动生成）
├── bin/
│   └── ymesh -> ../releases/<current>/ymesh.js   全局入口符号链接
├── releases/
│   ├── current -> <version>/                      当前 release 符号链接
│   ├── previous -> <version>/                     上一个 release 符号链接（用于回退）
│   └── <version>/                                 不可变 release 目录
│       ├── dist/                                  编译后 JS
│       ├── node_modules/                          依赖
│       ├── package.json
│       └── ymesh.js                               启动脚本（符号链接目标）
├── briefings/                                  每日 briefing 输出（按日期命名）
├── extracts/<project-hash>/                    NDJSONL 提取（requirements.ndjsonl、responses.ndjsonl）
└── logs/                                       daemon 日志（`ymesh doctor` 会引用）
```

平台特定：在 macOS 上，`ymesh service install` 还会把 LaunchAgent plist 写到 `~/Library/LaunchAgents/com.yondermesh.daemon.plist`（始终在 `~/Library/LaunchAgents/` 下，不受 `YONDERMESH_HOME` 影响）。

路径解析集中在 `src/install/paths.ts`（`resolveDataDir`、`resolveDbPath`、`resolveBinDir`、`resolveReleasesDir`、`resolveEntrySymlink`、`resolveCurrentSymlink`、`resolvePreviousSymlink`、`resolvePidFile`、`resolveLaunchAgentPlist`）。每次调用都重新读取，使 `YONDERMESH_HOME` 切换按调用生效。

## 文档站布局

本文档站是 `site/` 下的 VitePress 项目。英文在根目录；中文镜像在 `site/zh/`。

```
site/
├── .vitepress/
│   └── config.ts            VitePress 配置（locales、nav、sidebar、主题）
├── index.md                 首页（hero + features）
├── package.json             VitePress 依赖
├── reference/               英文参考页
│   ├── cli.md               自动生成（勿手改）
│   ├── adapters.md          自动生成（勿手改）
│   ├── config.md            手写
│   ├── mcp-tools.md         手写
│   ├── files.md             手写（本页）
│   └── changelog.md         手写（镜像根 CHANGELOG.md）
├── guide/                   英文指南页（手写）
└── zh/                      中文镜像
    ├── reference/
    │   ├── cli.md           自动生成（勿手改）
    │   ├── adapters.md      自动生成（勿手改）
    │   ├── config.md
    │   ├── mcp-tools.md
    │   ├── files.md
    │   └── changelog.md
    └── guide/
```

## 自动生成 vs 手写

文档生成流水线位于 `scripts/docs/`，由 `sync-all.mjs` 编排。在 `site/` 内运行 `npm run sync` 重新生成。

| 文件 | 来源 | 更新方式 |
|---|---|---|
| `site/reference/cli.md` | `ymesh help` 输出 | `npm run sync` — 切勿手改 |
| `site/zh/reference/cli.md` | `ymesh help` 输出 | `npm run sync` — 切勿手改 |
| `site/reference/adapters.md` | `src/*/index.ts` 头部注释 | `npm run sync` — 切勿手改 |
| `site/zh/reference/adapters.md` | `src/*/index.ts` 头部注释 | `npm run sync` — 切勿手改 |
| `site/reference/config.md` | `src/daemon/config.ts` + README | 手写 |
| `site/reference/mcp-tools.md` | `src/mcp/server.ts` | 手写 |
| `site/reference/files.md` | 仓库目录树 + ARCHITECTURE.md | 手写 |
| `site/reference/changelog.md` | 根 `CHANGELOG.md` | 手写镜像 |
| `site/guide/*.md` | — | 手写 |
| `site/index.md` | — | 手写 |

CI 强制无漂移：`scripts/docs/check-drift.mjs` 重跑 sync，若任一自动生成文件变化则失败；`scripts/docs/verify-links.mjs` 遍历每个 `site/**/*.md`，断言每个内部链接都能解析。

## 相关页面

- `/guide/architecture` — 架构不变量与模块边界
- `/reference/cli` — 自动生成的 CLI 命令参考
- `/reference/adapters` — 自动生成的 adapter 支持矩阵
- `/reference/config` — config.yaml 参考（含 `YONDERMESH_HOME`）
