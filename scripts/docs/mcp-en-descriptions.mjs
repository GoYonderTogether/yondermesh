// scripts/docs/mcp-en-descriptions.mjs
//
// English descriptions for MCP tools, used by gen-mcp-docs.mjs to render the
// English reference page. src/mcp/server.ts remains the single source of truth
// for tool NAMES, ARG NAMES, types, and required flags — this file only
// supplies English PROSE. gen-mcp-docs.mjs asserts every tool + param present
// in server.ts has an entry here, so a new tool/param fails the build loudly
// (no silent drift). If a param is absent here, the generator falls back to the
// source (Chinese) string rather than crashing.

export const EN = {
  search_sessions: {
    desc: 'Search session records across every AI agent on this device. Filter by time range, project path, agent type, and session type; supports full-text `query` search over message bodies. Use it before starting a new task to find related history, or to review all work on a project.',
    params: {
      query: 'Full-text search, case-insensitive, matches message bodies',
      search: 'Alias of query',
      source: 'Filter by agent type (claude/codex/hermes …); equivalent to the old `agent` param',
      project_path: 'Exact project path match',
      project_prefix: 'Project path prefix',
      agent: 'Filter by agent type (legacy alias, same as source)',
      topology: 'root = a real user-initiated session; subagent = spawned by another agent',
      since: 'Start time, ISO 8601 or relative like 7d / 24h / 30m',
      limit: 'Return count',
    },
  },
  get_session: {
    desc: 'Return the full message stream of a session. Supports live mode (reads the source file for real-time content), handoff_mode (task takeover), and include_relations (parent/child/related topology). Merges the old get_session_detail + get_session_relations + yondermesh_get_session.',
    params: {
      session_id: 'Session ID',
      live: 'Read the source file directly for real-time content (running sessions return latest)',
      limit: 'Return only the last N messages',
      include_compacted: 'In live mode, attach codex compacted summaries',
      include_tool_calls: 'In live mode, preserve function_call blocks',
      handoff_mode: 'Shorthand for live + compacted + tool_calls + last 30 messages',
      include_relations: 'Attach parent/child/related session topology',
    },
  },
  list_active: {
    desc: 'List AI agent sessions currently active or waiting for user review. Merges the old list_active_sessions + who_is_working + who_is_waiting, with live/idle/stopped counts and a per-session runtime summary. Queries the DB directly; reflects state within the most recent scan cycle.',
    params: {
      within_minutes: 'Look back this many minutes for activity',
      include_waiting: 'Also include sessions waiting for user review',
    },
  },
  overview: {
    desc: 'Statistical overview of all AI agent sessions on this device (total / root / subagent / message counts, etc.). Merges the old get_overview.',
    params: {
      since: 'Only count data after this time',
      project_prefix: 'Only count matching projects',
    },
  },
  handoff: {
    desc: 'Build a compacted handoff package for task takeover. Reads the source file directly and returns codex-compacted summaries, recent tail, task_plan, session metadata, and active status. Merges the old get_session_handoff.',
    params: {
      session_id: 'Session ID (required)',
      tail_messages: 'Number of tail messages including tool calls',
    },
  },
  send: {
    desc: 'Synchronously inject a user message into a target agent CLI session and get the reply. Three modes: new (start a session) / running (inject into a running session) / stopped (resume a stopped session). Merges the old yondermesh_send + launch_agent + inject_session + transfer_session.',
    params: {
      cli: 'Target CLI id (e.g. hermes/claude/opencode)',
      message: 'User message',
      mode: 'Delivery mode',
      session_id: 'Target session id (required for stopped/running modes)',
      model: 'Model id (optional)',
      effort: 'Reasoning effort (optional)',
      cwd: 'Working directory (optional)',
      timeout_ms: 'Timeout in milliseconds, default 60000',
      from_session_id: 'Sender session id (for audit)',
    },
  },
  mailbox: {
    desc: 'Asynchronous message read/write. Choose the operation via `action`: post (send/broadcast) / check (read unread) / reply / get (fetch). Merges the old post_message + get_messages + yondermesh_mailbox_*.',
    params: {
      action: 'Operation',
      to_session_id: 'post: target session',
      to_project: 'post: target project (broadcast)',
      from_session_id: 'post/reply: sender',
      body: 'post/reply: message body',
      kind: 'Message type',
      priority: 'Priority',
      reply_to_id: 'reply: id of the message being replied to',
      self_session_id: 'check/get: explicit own session',
      mark_read: 'check: mark as read',
    },
  },
  agents: {
    desc: 'List local agent CLIs with install status, coverage level, and mount capability; optionally include mount detail. Merges the old yondermesh_list_agents + yondermesh_mount_status.',
    params: {
      installed_only: 'Return only installed CLIs',
      include_mounts: 'Attach per-CLI mount detail',
    },
  },
  extract_project_history: {
    desc: 'Extract user requirements (user messages) and agent responses (assistant messages) from all session history of a project into indexable NDJSONL files. The first step to understanding real user needs on a project. With force_refresh=false and existing results, returns current stats without re-extracting.',
    params: {
      project_path: 'Project path (cwd prefix match)',
      force_refresh: 'true forces re-extraction; false returns existing stats if present',
    },
  },
  query_user_requirements: {
    desc: 'Query a project\'s user requirements (user messages). Filter by keyword, session, time, or ID. Each entry has id, sessionId, content, timestamp. Requires extract_project_history first.',
    params: {
      project_path: 'Project path (must match the extract call)',
      keyword: 'Fuzzy keyword match (case-insensitive, matches content)',
      session_id: 'Filter by session ID',
      from: 'Start time, ISO 8601 or relative like 7d / 24h / 30m',
      to: 'End time, ISO 8601 or relative',
      limit: 'Max return count',
      offset: 'Skip first N',
      id: 'Query by exact ID (= line number, 1-based); ignores other filters when matched',
    },
  },
  query_agent_responses: {
    desc: 'Query a project\'s agent responses (assistant messages). Filter by keyword, session, time, or ID. Requires extract_project_history first.',
    params: {
      project_path: 'Project path (must match the extract call)',
      keyword: 'Fuzzy keyword match (case-insensitive, matches content)',
      session_id: 'Filter by session ID',
      from: 'Start time, ISO 8601 or relative like 7d / 24h / 30m',
      to: 'End time, ISO 8601 or relative',
      limit: 'Max return count',
      offset: 'Skip first N',
      id: 'Query by exact ID (= line number, 1-based); ignores other filters when matched',
    },
  },
  yondermesh_whoami: {
    // Already English in source; keep for completeness so the assertion passes.
    desc: 'Resolve your own session id via 3-layer fallback: (1) env YONDERMESH_SELF_SESSION_ID, (2) self_session_id arg, (3) match cwd against recently active sessions in the store. Also reports your current unread message count. Use this at the start of any task to know who you are and whether other agents have sent you messages.',
    params: {
      self_session_id: 'Explicitly pass your session id (fallback when env var is not set)',
    },
  },
};
