---
title: 贡献指南
description: 如何为 yondermesh 贡献代码 —— 开发环境、代码风格、adapter、doc-sync 纪律、CI 与 PR 流程。
outline: [2, 3]
---

# 贡献指南

感谢你考虑为 yondermesh 贡献代码。这是
[未至之境 (GoYonderTogether)](https://github.com/GoYonderTogether)
的开源项目。本页内容与仓库根目录的
[CONTRIBUTING.md](https://github.com/GoYonderTogether/yondermesh/blob/main/CONTRIBUTING.md)
和 [AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md)
一致 —— 那两份文档是事实来源，本页是便于浏览的版本。

## 常见贡献路径

- **Bug 报告** →
  [开 issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=bug&template=bug_report.md)
- **功能建议** →
  [开 issue](https://github.com/GoYonderTogether/yondermesh/issues/new?labels=enhancement&template=feature_request.md)
- **安全报告** → 见
  [SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
  （**不要**为安全问题开公开 issue）
- **代码改动** → fork → 分支 → 向 `main` 提 PR

## 起步

```bash
git clone https://github.com/GoYonderTogether/yondermesh.git
cd yondermesh
npm install            # 根目录依赖（TypeScript、vitest、tsx）
npm run build          # 编译 TS → dist/
npm test               # 跑 vitest
npm run typecheck      # tsc --noEmit
```

也可以不安装直接从源码跑 CLI：

```bash
npm run dev -- help
npm run dev -- scan
npm run dev -- daemon
```

## 项目结构

完整的文件/目录地图在
[ARCHITECTURE.md](https://github.com/GoYonderTogether/yondermesh/blob/main/ARCHITECTURE.md)
§II，也镜像在[文件布局](/zh/reference/files)上。简版如下：

| 路径 | 角色 |
|---|---|
| `src/bin/ymesh.ts` | CLI 入口；命令注册的唯一位置 |
| `src/<adapter>/` | 每个支持的 CLI agent 一个目录（importer/wrapper/inject/extractor） |
| `src/store/` | SQLite 的唯一写入方 |
| `src/daemon/` | Daemon 生命周期（scan-once → watch → reconcile） |
| `src/mcp/` | MCP server、注册、handoff 包构建 |
| `src/mount/` | Mount 系统：向 CLI 配置目录做非侵入式扩展 |
| `src/install/` | Release 构建、launcher 符号链接、带自动回滚的 updater |
| `scripts/docs/` | 文档生成器与 drift/link 检查器 |
| `site/` | VitePress 公共文档站（即本站） |

## 代码风格

- **全程 TypeScript。** `npm run typecheck` 必须通过。
- **`src/bin/ymesh.ts` 不引入外部 CLI 框架** —— 手写 `parseArgs` 是有意
  为之。不要引入 `commander`、`yargs` 等。
- **遵循既有模式。** 每个 adapter 都遵循 importer/wrapper/inject/extractor
  文件结构；任意一个 `src/` 下的 adapter 都可作为模板。
- **外科手术式的 diff。** 每一行都能对到任务上。不要顺手清理无关代码。
- **"完成"之前先验证。** 跑 `npm test`、`npm run typecheck`，并实际走一遍
  真实路径（CLI / daemon / MCP）。在 PR 描述里贴出证据。
- **大声失败。** 列出哪些被跳过、哪些有警告、哪些没验证。

## 新增一个 CLI adapter

1. 新建 `src/<cli-name>/`，放一个 `importer.ts`，把该 CLI 的原生 session
   格式读进 `SessionStore`。再写一个 `index.ts` 导出 adapter 的公开接口。
2. 在 `src/bin/ymesh.ts` 的 `cmdScan()` 里注册，让 `ymesh scan` 能调用。
3. 加一个测试：`tests/<cli-name>-importer.test.ts`。每个 adapter 都有自己的
   测试文件。
4. 跑 doc-sync 流水线（见下一节），让 adapter 矩阵自动重新生成。
5. 完整清单见[适配器矩阵](/zh/reference/adapters) 的 "Adding a New
   Adapter" 小节。

## Doc-sync 纪律（最高优先级）

> 文档天然会滞后于代码。本项目把 doc/code 同步当成**硬规则**：每次改动都
> 必须在**同一个 commit** 里更新对应文档。**Doc lag = 未完成的 bug。**

规范的映射表在
[AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md)。
高频条目：

| 你改了… | 必须同时更新 |
|---|---|
| `src/bin/ymesh.ts`（CLI 命令 / flag / 帮助文本） | 跑 `npm run sync --prefix site` —— 从 `ymesh help` 重新生成 `site/reference/cli.md`（en + zh）。把结果提交。 |
| `src/<adapter>/`（新增 / 删除 / 覆盖等级变化） | 跑 `npm run sync --prefix site` —— 从 `src/*/` 重新生成 `site/reference/adapters.md`（en + zh）。把结果提交。 |
| Daemon 协议、MCP 工具列表、mount 策略 | `site/reference/mcp-tools.md`、`site/guide/mount.md`、`ARCHITECTURE.md` codemap |
| `package.json` 版本号 | 同一个 commit 里更新 `CHANGELOG.md` |
| 新的顶层特性 | `README.md` 特性列表 + 新建 `site/guide/<topic>.md`，并在 `site/.vitepress/config.ts` 侧边栏挂上链接 |
| `~/.yondermesh/` 文件布局 | `site/reference/files.md` |
| `install.sh` 或 release / update 流程 | `site/guide/installation.md` |
| 文档与代码不一致，或留下了 TODO | 开 issue，不要让它静默腐烂 |

操作流程（PR 标记 "ready for review" 之前跑一遍）：

```bash
# 1. 重新跑自动生成器（重新生成 CLI reference + adapter 矩阵）
npm run sync --prefix site
git add site/reference/cli.md site/zh/reference/cli.md \
        site/reference/adapters.md site/zh/reference/adapters.md

# 2. Drift 检查：重新生成 + 断言与已提交版本无差异
node scripts/docs/check-drift.mjs

# 3. 链接检查：site/ 下所有内部链接必须能解析
node scripts/docs/verify-links.mjs

# 4. 全量站点构建（捕捉 VitePress 配置 / frontmatter 错误）
npm run build --prefix site
```

三个 hygiene gate 必须全部通过，PR 才能进入 review。如果其中任一发生
drift，CI 会直接 fail PR。规范流程见
[`skills/doc-sync/SKILL.md`](https://github.com/GoYonderTogether/yondermesh/blob/main/skills/doc-sync/SKILL.md)。

### 自动生成 vs 手写文档

| 文件 | 来源 | 能手改？ |
|---|---|---|
| `site/reference/cli.md` | 从 `ymesh help` 自动生成 | 否 |
| `site/zh/reference/cli.md` | 从 `ymesh help` 自动生成 | 否 |
| `site/reference/adapters.md` | 从 `src/*/` 自动生成 | 否 |
| `site/zh/reference/adapters.md` | 从 `src/*/` 自动生成 | 否 |
| `site/guide/*.md` | 手写 | 是 |
| `site/zh/guide/*.md` | 手写 | 是 |
| `site/reference/files.md`、`mcp-tools.md`、`config.md` | 手写 | 是 |
| `site/.vitepress/config.ts` | 手写 | 是 |
| 顶层 `README.md`、`ARCHITECTURE.md`、`CONTRIBUTING.md`、`AGENTS.md`、`SECURITY.md`、`CHANGELOG.md` | 手写 | 是 |

永远不要手改自动生成的文件 —— 下一次 `npm run sync` 会覆盖你的修改，CI 也
会标记出 drift。

## 添加文档

- **手写页面**放在 `site/guide/`（英文）和 `site/zh/guide/`（中文）。两个
  语种必须保持同步 —— 新增或重组页面时两边一起改。
- **自动生成页面**在 `site/reference/` 与 `site/zh/reference/` 下。绝不
  手改。
- **侧边栏新条目**写在 `site/.vitepress/config.ts` 里 —— `sidebarEn()` 与
  `sidebarZh()` 都要加。链接检查器在侧边栏链接指向不存在的 `.md` 时会让
  CI 失败。
- **内部链接**用根绝对路径，不带 `.md` 后缀（`cleanUrls: true`）。例如
  `/zh/guide/faq`，而不是 `./faq.md`。

## 跑测试

```bash
npm test                                 # 完整 vitest 套件
npx vitest tests/claude-importer.test.ts # 单文件
npm run test:watch                       # watch 模式
```

每个 adapter 都有 `tests/<adapter>-importer.test.ts`。改动 daemon 或 MCP
时做端到端验证：在一个终端跑 `ymesh daemon`，在另一个终端跑
`ymesh mcp call <tool>`。

## CI 工作流

两个 GitHub Actions 工作流来强制 docs-as-code：

### `.github/workflows/docs-check.yml`（每个 PR 都跑）

触发条件：PR 改动了 `site/`、`scripts/docs/`、`src/`、`package.json`、
`README.md` 或工作流本身。步骤：

1. 安装根目录依赖与站点依赖。
2. 构建 ymesh（让 `ymesh help` 在 sync 时能跑）。
3. **检查 doc drift** —— `node scripts/docs/check-drift.mjs` 重新生成自动
   页面，与已提交版本不一致就 fail。
4. **校验内部链接** —— `node scripts/docs/verify-links.mjs` 遍历
   `site/**/*.md`，断言每个内部链接都能解析。
5. **构建文档站** —— `npm run build --prefix site` 捕捉 VitePress 配置 /
   frontmatter 错误。

这就是 **docs-as-code gate**：代码改动 = 同一个 PR 里改文档。

### `.github/workflows/docs-deploy.yml`（`main` 上跑）

触发条件：向 `main` 推送时改动了 `site/`、`scripts/docs/`、`src/`、
`package.json`、`README.md` 或工作流本身。步骤：

1. 与上面同样的 build + sync + verify 流水线。
2. 把构建产物作为 Pages artifact 上传。
3. 部署到 GitHub Pages（单并发部署，绝不取消进行中的部署，避免半成品
   上线）。

## Commit 风格

Conventional Commits、原子提交、模块级：

```
feat(cli): add ymesh foo command
fix(daemon): handle EACCES on watched path
docs(site): sync adapter matrix
chore(release): v0.2.0
```

- 一个 commit 一个逻辑改动。不要把无关工作捆在一起。
- `package.json` 版本号变更必须与 `CHANGELOG.md` 条目在同一个 commit。
- 发布打 tag：`git tag v0.Y.Z && git push --tags`。
- `npm publish` 是手动的（暂无自动发布工作流）。

## Pull request 流程

1. Fork 仓库，从 `main` 拉特性分支。
2. 完成改动。本地跑一遍 doc-sync 流水线和 hygiene gate。
3. 向 `main` 提 PR。按 PR 模板填写 —— 附上 `npm test`、`npm run typecheck`
   以及真实路径验证的证据。
4. CI 跑 `docs-check.yml`。三个 gate（drift、link、build）必须全部通过。
5. Maintainer review。反馈用新 commit 推上来回应（除非让你 force-push，
   否则不要 force-push）。
6. 通过且 CI 绿后，maintainer squash merge。

## 内部文档（已 gitignore）

仓库根目录的 `docs/` 是 **gitignored** 的 —— 它存放内部架构规格、实现循环
和验收基线，不对外公开。不要提交 `docs/` 下的任何东西。公开文档放在
`site/` 或顶层 `*.md`（`README.md`、`ARCHITECTURE.md`、`CONTRIBUTING.md`、
`CHANGELOG.md`、`SECURITY.md`）。

## 安全

改动同步、MCP server、mount 系统，或任何接触 session 内容的代码之前，先
读
[SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)。
关键不变量：

- **离开设备的只有密文。** 同步 relay 永远看不到明文。
- **不做模型代理。** yondermesh 永远看不到 API key。
- **不改 CLI 二进制。** Mount 只往 CLI 自己的配置目录写，绝不 patch 二进制
  或它的 session 写入逻辑。
- **本地 SQLite 不做静态加密。** 唯一保护是文件权限 —— 不要把 yondermesh
  跑在共享账号上。

漏洞请**私下**报告：通过 GitHub 的 "Report a vulnerability" 流程，或直接
邮件联系 maintainer。不要开公开 issue。72 小时内会有初步响应。完整披露政策
见 SECURITY.md。

## 协议

提交贡献即表示你同意以 MIT 协议授权你的贡献（见
[LICENSE](https://github.com/GoYonderTogether/yondermesh/blob/main/LICENSE)）。

## 相关

- [文件布局](/zh/reference/files)
- [架构](/zh/guide/architecture)
- [常见问题](/zh/guide/faq)
- [故障排查](/zh/guide/troubleshooting)
- [SECURITY.md](https://github.com/GoYonderTogether/yondermesh/blob/main/SECURITY.md)
- [CONTRIBUTING.md](https://github.com/GoYonderTogether/yondermesh/blob/main/CONTRIBUTING.md)
- [AGENTS.md](https://github.com/GoYonderTogether/yondermesh/blob/main/AGENTS.md)
