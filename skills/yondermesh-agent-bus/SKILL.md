---
name: yondermesh-agent-bus
description: >-
  Use when you need to see what other AI agents on this machine are doing, find past
  work or prior attempts, talk to another agent session, hand off or delegate work,
  spawn a sub-agent, or organize which working directory is which. Triggers: "what
  are other agents doing", "did anyone try this before", "ask the other agent",
  "hand this off", "check my mailbox", "which sessions are running", "tell the other
  session", "what did we already do on this project", "yondermesh", "ymesh".
---

# yondermesh Agent Bus —— 4 个工具怎么用

本机所有 CLI agent 的会话都汇总在本地 SQLite。你通过 **4 个工具**（或对应的
`ymesh` CLI）使用它。**没有第五个**：所有需求都落在这四个职能里。

| 职能 | 工具 | 回答什么 |
|---|---|---|
| **看** | `observe` | 什么情况？让我看细节。按条件筛。 |
| **说** | `message` | 跟谁说话，什么时候送到。 |
| **管** | `orchestrate` | 起新的 / 派活 / 接力 / 等结果 —— 我对下属的动作。 |
| **标** | `workspace` | 工作目录的归属与分组。 |

---

## 一、`observe` —— 看

三个正交维度，一次调用带齐：

```
observe({
  scope:  'me' | 'global' | 'project' | 'session' | 'active' | 'tree',
  target: <session id | 项目路径>,
  filter: { roles, exclude, min_length, keyword, since, until },
  shape:  'list' | 'detail' | 'summary' | 'tree' | 'stats',
})
```

**核心：筛选是查询的一部分，不是拿回来再处理。**

| 你想要 | 怎么写 |
|---|---|
| 只看人的话（排除工具链） | `roles: ["user","assistant"]` 或 `exclude: ["tool"]` |
| 只要长需求（小需求不算需求） | `roles: ["user"], min_length: 200` |
| 只要 AI 的结论 / 推理 | `roles: ["assistant"]` |
| 只要某个词相关 | `keyword: "支付"` |
| 只要最近的 | `since: "7d"`（支持 s/m/h/d/w 或 ISO） |
| 别一次给太多 | `limit: 20, offset: 0` |

**常用组合**

| 你在干什么 | 调用 |
|---|---|
| 开工先看局势 | `{scope:"global"}` |
| 谁在干活 / 谁在等我 | `{scope:"active"}` |
| 接手别人做了一半的活 | `{scope:"session", target:<id>, shape:"detail", exclude:["tool"]}` |
| 大盘需求分析 | `{scope:"project", target:<path>, shape:"summary", roles:["user"]}` |
| 看这个任务分了哪几支 | `{scope:"tree", target:<id>}` |
| 我这个会话的角色分布 | `{scope:"me", shape:"stats"}` |

⚠️ **树状归属有坑**（实测）：
- `spawned_by` 在真实数据里**不是干净的直接父边**——同一个会话可能记了 2~105 个上级（含传递祖先链）。
  所以 tree 会如实告诉你「记录了 N 个上级」，别假定是唯一父节点。
- **pi 的子代理不落独立会话文件**（task 工具结果直接写进父会话的 message 流）→
  pi 会话的树状归属**拿不到**，不是「没起过」。claude / hermes / opencode 才可信。

---

## 二、`message` —— 说

```
message({ action:'send'|'check', to, body, delivery, reply_to })
```

| delivery | 什么时候送到 | 用在什么场景 |
|---|---|---|
| `now` | 立刻 | 对方**已停**，要它继续干活 |
| `after_turn` | **我这轮**结束后 | 只是通知/同步信息，不用等回复。同目标的积压会**合并成一条**（省 token） |
| `on_reply` | **对方回复完用户**那一刻，且**以用户口吻** | 对方**正在干活**，你要它加个需求（它会当成用户说的去做） |

**禁忌（实锤会损坏数据）**：不要用 `now` 给**正在跑**的会话发消息。外部进程注入会与它
自己的进程同时写同一个 `.jsonl` → 消息错乱/丢失。工具会拒绝并提示你改用 `on_reply`。

`action:"check"` 看发给你的消息。**开工先 check**，别的 agent 可能给你留了话。

---

## 三、`orchestrate` —— 管

```
orchestrate({ action, target, brief, to, config:{cli,model,effort,cwd}, delivery })
```

| action | 树上做什么 | 什么时候用 |
|---|---|---|
| `spawn` | 加子节点 | 任务**可并行**且与我上下文**无关**——新会话更干净 |
| `assign` | 向已有节点派活 | **已经有**合适会话（同项目同主题）——别重复起 |
| `handoff` | 交接给别的节点 | 我干不了（缺工具/权限/要换模型） |
| `await` | 等结果 | spawn 之后收口 |
| `discuss` | 拉多个节点互聊 | 需要多方视角（评审/选型） |
| `prior` | 查历史 | **动手前先问「这事以前有人试过吗」** |
| `stop` | 剪枝 | ⚠️ 暂不支持（ymesh 不持有别的 agent 的进程句柄） |

### 要不要编排 config？—— 这是最容易用错的地方

| 场景 | 要不要配 | 配什么 |
|---|---|---|
| `spawn` | **要** | `cwd` 几乎必给（不然它不知道在哪干活）；需要特定能力再给 `cli`/`model` |
| `assign` | 不要 | 已有会话的配置不该被你改 |
| `handoff` | **要** | 换 `cli` + `model`（本来就是因为做不了才交接） |
| `discuss` | **要，且必须异构** | **给每个参与方不同的 `model`**——同模型讨论 = 同一张嘴说三遍，纯浪费 |
| `await` / `prior` | 不要 | — |

---

## 四、`workspace` —— 标

```
workspace({ action:'list'|'add'|'update'|'remove'|'status', path, label, group, note })
```

**为什么这个必须能写**：`project_path` 只能从 CLI 的 cwd 自动推导；但
「这几个目录属于同一摊事」「这目录我叫它笔记库」是**人的判断**，机器推不出来。

- `add` / `update` —— 标记一个工作目录（起名、分组、备注）
- `status` —— 看每个标记目录下**现在有哪些 agent 在跑**，还会提示未标记但活跃的目录
- `remove` —— 取消标记（不动任何会话）

典型用法：用户有多个 IDE 在不同工作目录干活。把「笔记库」标上，之后
`workspace({action:"status"})` 就能一眼看到那个目录下有哪些 agent 在做什么。

---

## 五、每个响应自带的「情境包」

`observe` / `message` 的响应末尾都有一小块：

```
── 现状 ──────────────────────────────
 8 个会话在场（3 个正在写） · 用户发起 5 · agent 发起 3
 其中 2 个有下属
 你：pi root · 由 3f2a… 发起 · 同项目还有 4 个在跑：claude* pi hermes
 跟你交流过的会话：3 个
──────────────────────────────────────
```

**所以不要为了了解全局单独调一次 `observe({scope:"global"})`** —— 它已经在每个响应里了。

---

## 六、三条铁律

1. **动手前先 `observe`** —— 不知道现状就 spawn，会起一堆重复会话。
2. **能 `assign` 就不要 `spawn`** —— 重复会话是上下文分裂的头号来源。
3. **`discuss` 必须配异构 model** —— 否则是同一张嘴说三遍。

## 七、CLI 等价入口

```bash
ymesh observe --scope active
ymesh observe --scope project --target "/path" --roles user --min-length 200
ymesh message check
ymesh message send --to <sid> --body "..." --delivery on_reply
ymesh orchestrate prior --query "报错文本"
ymesh workspace status
```
