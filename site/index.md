---
layout: home

hero:
  name: yondermesh
  text: Self-hosted Agent Context Bus
  tagline: Let your AI agents see each other, query each other, and hand off tasks across devices and CLIs. One daemon, one MCP server, zero intrusion.
  actions:
    - theme: brand
      text: Quickstart
      link: /guide/quickstart
    - theme: alt
      text: What is yondermesh?
      link: /guide/what-is-yondermesh
    - theme: alt
      text: GitHub
      link: https://github.com/GoYonderTogether/yondermesh

features:
  - icon: 🛰️
    title: Collect
    details: Auto-harvest sessions from every CLI agent (Claude Code, Codex, Aider, Gemini, Cursor, Windsurf, Trae, Continue, …) on every device into local SQLite. No CLI modification needed.
  - icon: 🔁
    title: Sync
    details: E2E-encrypted cross-device sync via self-hosted relay. Code leaves your machine as ciphertext only.
  - icon: 🔍
    title: Query
    details: Any agent queries any other agent's context via MCP tools. recall_recent_work, whats_on_device, handoff_task — all native MCP.
  - icon: 🤝
    title: Hand off
    details: Agent A picks up where agent B left off, even on a different machine. Compacted summaries + tool trail + plan shipped in one JSON package.
  - icon: 🧠
    title: Memory-aware
    details: Topology-aware (root / subagent / sidechain), source-aware (claude / codex / cass / hermes / continue / windsurf / …), and project-aware (cwd / projectPath).
  - icon: 🪶
    title: Zero intrusion
    details: No UI, no cloud lock-in, no model proxy, no agent modification. Reads native files, exposes MCP, that's it. Fully self-hostable.
---
