---
title: 跨设备同步
description: yondermesh 通过自托管 relay 在你的设备之间同步 session，离开设备的永远是密文。介绍其工作原理、配置方式与隐私模型。
outline: [2, 3]
---

# 跨设备同步

你的 AI 编码代理分布在多台机器上——一台笔记本、一台台式机、一台工作虚拟机。上下文应该跟随。yondermesh 通过自托管 relay 在你的设备之间同步 session，离开设备的永远是密文。

## 为什么需要同步

没有同步，每台设备都是孤岛。你在笔记本上跑的 session 对台式机上的 daemon 不可见；台式机上的代理也无法回忆笔记本上的代理昨天做了什么。同步弥合了这个缺口：每台设备的本地 SQLite store 最终与其他设备收敛，所以任何设备上的任何代理都能通过同样的 MCP 工具查询任何其他代理的上下文。

同步是可选的。如果你只在一台机器上运行代理，保持禁用即可，yondermesh 作为纯本地工具工作。

## 工作原理

同步 agent（`src/sync/agent.ts`，类 `SyncAgent`）在本地 `SessionStore` 之上运行周期性的推送/拉取循环：

```text
local SessionStore → 用本地密钥加密 → POST 密文到自托管 relay
                                                       │
自托管 relay → GET 对端密文 → 用本地密钥解密 → upsert 进本地 SessionStore
```

1. agent 查询本地 store 中尚未推送的 session（`sync_state = 'local'` 的那些）。
2. 每个 session 的内容用本地密钥加密。
3. 密文被 POST 到 relay URL。
4. agent GET 对端设备推送的密文。
5. 密文用本地密钥解密并 upsert 进本地 store。
6. 已同步 session 的 `sync_state` 列被更新。

该循环默认每 60 秒运行一次，`start()` 时立即同步一次。若未配置 `relayUrl`，agent 会打印警告并跳过——同步被禁用，但 yondermesh 的其余部分不受影响。

## 不变式：离开设备的永远是密文

这是核心隐私不变式，声明于 `src/sync/agent.ts`：

> 代码离开设备前永远是密文。

relay 是一根哑管子。它存储并转发不透明的 blob。它永远看不到明文、永远看不到密钥、也无法解密它搬运的任何内容。若 relay 被攻破，攻击者只能拿到密文。

这正是 yondermesh **不做模型代理**的原因（[架构](/zh/guide/architecture) 中的不变式 2）——relay 无需理解 session 内容即可转发，而 yondermesh 绝不触碰你的 API key。

## 自托管 relay 部署

relay 是 relay，不是云。由你来运行。

- **自托管**——把 relay 部署在你控制的任何主机上（VPS、家用服务器、Tailscale 节点）。把每台设备的 `sync.relay_url` 指向它。relay 只需存储并转发不透明的密文 blob，不需要明文数据库。
- **云 relay（可选便利）——** 可能提供托管 relay 以求便利，但它永远不是被信任的参与方。它看到的是与自托管 relay 相同的密文。你可以随时通过更改 `relay_url` 在自托管与云之间切换；无需数据迁移，因为 relay 不持有明文状态。

因为 relay 仅承载密文，你无需信任 relay 运营方。安全边界是你的本地密钥，而非 relay。

## 密钥管理

每台设备在 `~/.yondermesh/key.pem` 存有一个本地密钥对。若不存在，首次运行时自动生成。

- 密钥永不离开设备。
- 密钥永不发送给 relay。
- 丢失密钥意味着失去解密从该设备同步出的 session 的能力——请做好备份。

要让设备之间能读取彼此的 session，它们需要共享密钥（或采用预共享密钥方案）。配对见下文。

## 配置同步

同步在 `~/.yondermesh/config.yaml` 的 `sync` 键下配置（见 `examples/config.yaml`）：

```yaml
sync:
  enabled: false                    # 设为 true 以启用
  relay_url: https://relay.your-domain.com
  key_file: ~/.yondermesh/key.pem   # 首次运行时自动生成
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sync.enabled` | `false` | 同步 agent 的主开关。 |
| `sync.relay_url` | — | 自托管（或云）relay 的 URL。`enabled: true` 时必填。 |
| `sync.key_file` | `~/.yondermesh/key.pem` | 本地加密密钥路径。缺失时自动生成。 |

`SyncAgent` 构造器（见 `src/sync/agent.ts`）接收 `{ enabled, relayUrl, keyFile }`。若 `enabled` 为 true 但 `relayUrl` 未设置，agent 会打印警告并跳过——不会崩溃。

完整 config schema 见 [配置文件](/zh/reference/config)。

## 配对设备

配对是两台设备通过共享 relay 同意彼此同步的步骤。在协议层面，配对归结为：两台设备指向同一个 `relay_url`，且两台设备都能解密对方推送的内容。

因为 relay 是哑密文管道，实际的配对流程是：

1. 搭建一个 relay 并记录其 URL。
2. 在设备 A 上，把 `sync.relay_url` 设为 relay URL 并启用同步。本地密钥生成于 `~/.yondermesh/key.pem`。
3. 在设备 B 上做同样的事。设备 B 生成自己的密钥。
4. 安排密钥共享，使每台设备都能解密对方的密文（如把设备 A 的密钥复制到设备 B，或在两台设备上放置预共享密钥）。

一旦两台设备都用兼容的密钥向同一个 relay 推送和拉取，session 就会自动收敛。

## 隐私模型

yondermesh 的隐私模型直接来自 [架构](/zh/guide/architecture) 中的不变式：

- **不做模型代理。** yondermesh 绝不触碰你的 API key。CLI 运行模型；ymesh 只读取 CLI 写入的内容并转发密文。
- **relay 上无明文。** relay 存储并转发不透明的 blob。它无法解密搬运的任何内容，攻破它只能得到密文。
- **不锁定云。** relay 可自托管。云 relay 只是可选便利，看到的是与自托管 relay 相同的密文。切换 relay 是改 `relay_url`，不是数据迁移。
- **密钥留在本地。** `~/.yondermesh/key.pem` 的加密密钥永不离开设备、永不发送给 relay。

这些组合意味着信任边界是你的设备，而非任何第三方。你无需信任 relay 运营方、托管 relay 的云厂商、或作为服务的 yondermesh——因为 yondermesh 不是服务，它是运行在你设备上的软件。

## 相关

- [架构](/zh/guide/architecture)——三个平面与治理同步的不变式。
- [配置文件](/zh/reference/config)——完整的 `~/.yondermesh/config.yaml` schema。
- [Daemon](/zh/guide/daemon)——同步 agent 读取与写入其 store 的 daemon。
