---
title: 安装
description: 通过 npm 安装 yondermesh、从源码构建、管理 release、在 macOS 上以 LaunchAgent 服务运行，以及验证或卸载安装。
outline: [2, 3]
---

# 安装

yondermesh 以单一 `ymesh` CLI 分发。有三种方式把它装到你的机器上：从 npm 安装、从源码构建、
或从已有的本地 clone 更新。三种方式的最终结果都是你的 `PATH` 上有一个 `ymesh` 二进制。

## 系统要求

- **Node.js 20 或更高版本**（`>=20.0.0`）。用 `node --version` 检查。
- **macOS、Linux 或 WSL。** 守护进程监听文件系统事件并写入本地 SQLite 数据库。原生 Windows
  暂不支持，请使用 WSL。
- **对 `~/.yondermesh/` 的写权限**（或你通过 `YONDERMESH_HOME` 指定的目录）。守护进程在首次
  运行时创建此目录。
- **至少已安装一个 CLI Agent**，如果你希望 yondermesh 采集到真实 session。完整列表见
  [CLI 适配器参考](/zh/reference/adapters)。

## 方式 A：npm 全局安装

最简单的路径。全局安装已发布的包：

```bash
npm install -g yondermesh
```

验证二进制已在 `PATH` 上：

```bash
ymesh version
```

这会安装最新发布版本。日后升级时重新运行同一命令即可；如果你改用源码 clone，也可以使用
[方式 C](#方式-c-从-clone-运行-ymesh-update-local) 中描述的就地更新机制。

## 方式 B：从源码构建

如果你想运行预发布版本、提交补丁、或保留本地 checkout，请用此方式。

```bash
git clone https://github.com/GoYonderTogether/yondermesh.git
cd yondermesh
npm install
npm run build
```

然后将构建好的 release 安装到 `~/.yondermesh/`：

```bash
ymesh install
```

`ymesh install` 会编译 TypeScript 源码（如果需要），打包到一个位于
`~/.yondermesh/releases/<version>/` 的版本化 release 目录，并创建（或更新）指向当前
release 的 `~/.yondermesh/bin/ymesh` 符号链接。将 `~/.yondermesh/bin` 加入你的 `PATH`，
或者把 `~/.yondermesh/bin/ymesh` 符号链接到一个已在 `PATH` 上的目录。

验证：

```bash
ymesh version
ymesh doctor
```

## 方式 C：从 clone 运行 `ymesh update --local`

一旦你有了一个源码 clone（来自方式 B），就可以拉取最新变更并就地重新构建，无需重新 clone：

```bash
cd yondermesh
git pull
ymesh update --local
```

`--local` 标志告诉 yondermesh 跳过 clone 步骤，直接从当前目录构建。更新流程为：构建 ->
安装 -> 原子符号链接切换 -> 失败自动回退。如果构建失败，符号链接会继续指向之前正常的
release，因此你正在运行的守护进程不会被打断。

要从远程 Git 源码更新（clone 或 pull 后构建），运行：

```bash
ymesh update
```

## Release 管理

每次 `ymesh install` 和 `ymesh update` 都会在 `~/.yondermesh/releases/<version>/` 下创建
一个版本化 release。当前活跃的 release 是 `~/.yondermesh/bin/ymesh` 符号链接所指向的那个。

列出所有已安装的 release：

```bash
ymesh releases
```

手动回退到上一个 release（当新 release 引入了回归问题、且因构建本身成功而未触发自动回退
时很有用）：

```bash
ymesh rollback
```

没有单独的 `ymesh pin` 命令；要固定某个版本，可以自己改符号链接，或从你想要的版本的源码
checkout 运行 `ymesh install`。

## LaunchAgent 服务（仅 macOS）

在 macOS 上，你可以将守护进程作为 LaunchAgent 运行，使其在登录时自动启动、崩溃时自动重启。
yondermesh 为你管理 plist：

```bash
ymesh service install     # 安装 LaunchAgent plist
ymesh service start       # 通过 launchctl 启动守护进程
ymesh service stop        # 停止守护进程
ymesh service status      # 检查守护进程是否在运行
ymesh service uninstall   # 移除 LaunchAgent plist
```

plist 位于 `~/Library/LaunchAgents/` 下，并将守护进程指向默认数据目录
（`~/.yondermesh/`）。如果你覆盖了 `YONDERMESH_HOME`，请确保 LaunchAgent 环境与之匹配。

::: tip
LaunchAgent 集成仅限 macOS。在 Linux 上，请使用 systemd 用户单元或你选择的进程管理器；
守护进程本身只是由 `ymesh daemon` 调用的一个长运行进程。
:::

## 验证安装

运行 doctor 命令一次性检查安装健康度、数据库连通性、守护进程状态和日志健康：

```bash
ymesh doctor
```

检查版本：

```bash
ymesh version
```

检查守护进程状态和最近的扫描结果：

```bash
ymesh status
```

如果 `ymesh doctor` 没有报告任何问题，你就可以按[快速上手](/zh/guide/quickstart)继续了。

## 卸载

没有单独的 `ymesh uninstall` 命令。要完全移除 yondermesh：

1. 如果你安装了 LaunchAgent，先停止并移除：

   ```bash
   ymesh service stop
   ymesh service uninstall
   ```

2. 移除数据目录（这会删除 SQLite 数据库、所有 release 构建、符号链接和任何 briefing）：

   ```bash
   rm -rf ~/.yondermesh
   ```

3. 如果你通过 npm 安装，移除全局包：

   ```bash
   npm uninstall -g yondermesh
   ```

4. 如果你将 yondermesh 挂载到了任何 CLI 中，请清理 mount，以免这些 CLI 继续引用一个不存在的
   MCP 服务器：

   ```bash
   ymesh mount remove
   ```

   在删除 `~/.yondermesh/` 之前运行此命令，因为 `ymesh mount remove` 需要二进制可用。

::: warning
移除 `~/.yondermesh/` 会删除本地存储的所有已采集 session。其他机器上通过跨设备同步得到的
副本不受影响，但本机的本地副本将永久丢失。如果以后可能需要，请先备份数据库。
:::

## 下一步

- [快速上手](/zh/guide/quickstart)——启动守护进程并连接一个 Agent。
- [CLI 命令](/zh/reference/cli)——完整的命令参考。
- [架构](/zh/guide/architecture)——守护进程、存储、MCP 服务器和同步 agent 如何组合在一起。
