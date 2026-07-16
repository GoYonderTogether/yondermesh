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
    title: "Sync (planned)"
    details: E2E-encrypted cross-device sync via self-hosted relay. Not yet implemented — the sync code path is a TODO stub.
  - icon: 🔍
    title: Query
    details: Any agent queries any other agent's context via MCP tools. search_sessions, list_active_sessions, get_session_handoff — all native MCP.
  - icon: 🤝
    title: Hand off
    details: Agent A picks up where agent B left off, even on a different machine. Compacted summaries + tool trail + plan shipped in one JSON package.
  - icon: 📨
    title: "Send (preview)"
    details: Synchronously inject a message into any connected CLI agent and get the reply back. 23 CLIs, 6 trigger channels, 3 modes. Claude Code and Codex support is planned.
  - icon: 🧠
    title: Memory-aware
    details: Topology-aware (root / subagent / sidechain), source-aware (claude / codex / cass / hermes / continue / windsurf / …), and project-aware (cwd / projectPath).
  - icon: 🪶
    title: Zero intrusion
    details: No UI, no cloud lock-in, no model proxy, no agent modification. Reads native files, exposes MCP, that's it. Fully self-hostable.
---
