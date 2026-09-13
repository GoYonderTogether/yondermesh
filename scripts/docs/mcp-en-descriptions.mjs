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
  observe: {
    desc: 'See — the single read entry point over every AI agent session on this machine (and, later, across devices). Pick `scope` to choose what you are looking at (me / global / project / session / active / tree), then narrow with filters; `shape` decides the output form (list / detail / summary / tree / stats). Use it before starting work so you know who is already running, and instead of post-processing results by hand — filters are part of the query.',
    params: {
      scope: 'What to look at: me (my own session) / global / project / session / active (who is working now) / tree (session hierarchy)',
      target: 'Target for scope=session|tree: session id (hash, native UUID or unique prefix) or project path for scope=project',
      shape: 'Output form: list / detail / summary / tree / stats',
      roles: 'Only these message roles, e.g. ["user","assistant"] — use ["user"] to read just what the human asked',
      exclude: 'Exclude roles such as ["tool"] to drop tool-call noise',
      min_length: 'Only messages with at least this many characters (e.g. 200 = long requirements only)',
      keyword: 'Fuzzy keyword match over message content',
      since: 'Only activity after this time — ISO 8601 or relative like 7d / 24h / 30m',
      until: 'Only activity before this time',
      limit: 'Max rows (default 20)',
      offset: 'Pagination offset (default 0)',
      include_agents: 'For scope=global, also list the detected CLIs',
      self_session_id: 'Explicitly state which session you are (when self-detection is ambiguous)',
    },
  },
  message: {
    desc: 'Say — the one entry point for talking to another agent session. You do not need to know which CLI it is, only its session id. `action=send` posts a message, `action=check` reads what was sent to me. `delivery` picks the moment: now (rejected while the target is running — injecting between its turns corrupts the session), after_turn (delivered once my own turn ends; queued messages to the same target are merged), on_reply (delivered the moment the target finishes replying to its user, phrased as if the user said it).',
    params: {
      action: 'send = post a message, check = read messages addressed to me (default)',
      to: 'send: target session id (hash / native / prefix) or "all" to broadcast to my project',
      body: 'send: message body',
      delivery: 'send: now / after_turn / on_reply (default now)',
      reply_to: 'send: id of the message you are replying to (thread is derived automatically)',
      limit: 'check: max messages to return (default 20)',
      mark_read: 'check: mark returned messages as read (default true)',
      unread_only: 'check: only unread messages (default true)',
      self_session_id: 'check: explicitly state which session you are',
    },
  },
  orchestrate: {
    desc: 'Manage — what I do to sessions below me. `spawn` starts a new session, `assign` hands work to an existing one, `handoff` builds a takeover package, `await` waits for a result, `discuss` runs a multi-model debate, `stop` asks a session to stop cooperatively (never a kill — see the tool result), `prior` asks whether this was attempted before.',
    params: {
      action: 'spawn / assign / handoff / await / discuss / stop / prior',
      target: 'Target session (assign/await/stop) or source session (handoff)',
      brief: 'Task description (spawn/assign/discuss)',
      to: 'discuss: which sessions to pull in (at least 2, must use different models)',
      query: 'prior: the task or error text to search for',
      delivery: 'spawn/assign/discuss: when to deliver — now / after_turn / on_reply (default on_reply)',
      config: 'spawn: execution config — cli / model / effort / cwd / timeout_ms',
      limit: 'await / prior: how many records to consider',
      self_session_id: 'Explicitly state which session you are',
    },
  },
  workspace: {
    desc: 'Label — where I record what a working directory means: a human-readable label, a group, and a note. Also answers "which agents are running under this directory right now", counting only sessions strictly below the marked path.',
    params: {
      action: 'add / update / remove / list / status',
      path: 'Absolute path of the working directory',
      label: 'Readable name for the directory',
      group: 'Group such as "personal" / "work"',
      note: 'Free-form note',
      within_minutes: 'status: only consider sessions seen within the last N minutes (default 30)',
    },
  },
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
  yondermesh_check_prior_attempts: {
    // Already English in source; keep for completeness so the assertion passes.
    desc: 'Check whether other agents have encountered a similar task/error before and what they concluded. Input a task description or error message; returns ranked prior attempts with their conclusions (last assistant message preview). v0 uses deterministic matching on session messages (failure-marker regex + token overlap + same-project weighting) — zero LLM, no separate decision-extraction module. Useful before starting a new task to avoid re-stepping on a known landmine.',
    params: {
      query: 'Task description or error text to search for. Required.',
      project_path: 'Caller\'s project path. Sessions with the same projectPath get a relevance boost. Optional.',
      cwd: 'Caller\'s working directory. Sessions with the same cwd get a small relevance boost. Optional.',
      limit: 'Max results (default 5, max 50).',
      min_score: 'Minimum relevance score 0-1 (default 0.1). Lower = more results but noisier.',
    },
  },
};
