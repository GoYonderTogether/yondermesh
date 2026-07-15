---
layout: home

hero:
  name: yondermesh
  text: 自托管 Agent 上下文总线
  tagline: 让你的 AI agent 互相看见、互相查询、跨设备跨 CLI 接力任务。一个 daemon，一个 MCP server，零侵入。
  actions:
    - theme: brand
      text: 快速上手
      link: /zh/guide/quickstart
    - theme: alt
      text: yondermesh 是什么？
      link: /zh/guide/what-is-yondermesh
    - theme: alt
      text: GitHub
      link: https://github.com/GoYonderTogether/yondermesh

features:
  - icon: 🛰️
    title: 采集
    details: 自动从每台设备上的每个 CLI agent（Claude Code、Codex、Aider、Gemini、Cursor、Windsurf、Trae、Continue 等）收割 session 到本地 SQLite。无需修改 CLI。
  - icon: 🔁
    title: 同步
    details: 通过自托管 relay 做端到端加密跨设备同步。代码以密文形式离开你的机器。
  - icon: 🔍
    title: 查询
    details: 任何 agent 通过 MCP 工具查询其他 agent 的上下文。recall_recent_work、whats_on_device、handoff_task —— 全部原生 MCP。
  - icon: 🤝
    title: 接力
    details: Agent A 从 Agent B 停下的地方继续，即使在不同机器上。浓缩摘要 + 工具调用轨迹 + 任务计划打包成一个 JSON。
  - icon: 🧠
    title: 记忆感知
    details: 拓扑感知（root / subagent / sidechain）、来源感知（claude / codex / cass / hermes / continue / windsurf / 等）、项目感知（cwd / projectPath）。
  - icon: 🪶
    title: 零侵入
    details: 无 UI、无云锁定、无模型代理、无 agent 修改。读取原生文件，暴露 MCP，仅此而已。完全可自托管。
---
