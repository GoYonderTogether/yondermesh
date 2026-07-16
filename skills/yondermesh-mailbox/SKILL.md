---
name: yondermesh-mailbox
description: >-
  Cross-session messaging for AI coding agents on the same machine.
  Use when: the user says "send a message to another agent", "tell the other session",
  "check my mailbox", "what did other agents send me", "notify another agent",
  "broadcast to the project", or any need to communicate between concurrent agent
  sessions. Also use proactively at the start of any task to check if other agents
  have sent you messages via yondermesh mailbox.
---

# yondermesh Mailbox

Cross-session messaging bus. Lets AI agents send messages to each other through
a shared SQLite store. Messages can be direct (to a specific session) or broadcast
(to all agents in a project).

## When to use

- **Task start**: Call `yondermesh_mailbox_check` to see if other agents sent you messages while you were away.
- **Coordination**: Tell another agent a task is done, ask a question, or hand off work.
- **Broadcast**: Notify all agents in a project about a shared decision or blocker.
- **Reply**: Continue a conversation thread by replying to a previous message.

## MCP tools (preferred)

### Check your inbox

```
yondermesh_mailbox_check
  → { sessionId, unread: {direct, broadcast, total}, messages, trayNotices }
```

Resolves your own session id via 3-layer fallback:
1. `YONDERMESH_SELF_SESSION_ID` env var (injected by wrappers)
2. `self_session_id` arg (explicit)
3. cwd match against recently active sessions

By default marks messages as read (pop). Set `mark_read=false` to peek.

### Post a message

```
yondermesh_mailbox_post
  to_session_id: "<target-sid>"     # direct message
  to_project: "/path/to/project"   # OR broadcast
  body: "msg content"
  kind: "info|warning|question|task_update"  # default: info
  priority: "low|normal|high|urgent"          # default: normal
  expires_in_seconds: 3600           # optional TTL
```

### Reply to a message

```
yondermesh_mailbox_reply
  reply_to_id: 42
  body: "reply content"
  → { messageId, posted, threadId }
```

Auto-derives `thread_id` from the parent message.

### Find your own session id

```
yondermesh_whoami
  → { sessionId, resolved, unread }
```

## CLI fallback

If MCP is not available, use the CLI:

```bash
# Check inbox
ymesh mailbox check

# Post a message
ymesh mailbox post --to <sid> --body "msg content"
ymesh mailbox post --to-project /path/to/project --body "broadcast msg"

# Peek without marking read
ymesh mailbox peek --for <sid> --unread-only

# Pop (read + mark read)
ymesh mailbox pop --for <sid>

# List all mailboxes
ymesh mailbox list

# Mark read
ymesh mailbox mark-read --id <msg_id>
ymesh mailbox mark-read --for <sid>

# Count unread
ymesh mailbox unread --for <sid>

# Find your session id
ymesh mailbox whoami
```

## Message lifecycle

1. Agent A calls `yondermesh_mailbox_post` with `to_session_id` = Agent B's session id
2. Message is stored in SQLite `agent_messages` table
3. Agent B calls `yondermesh_mailbox_check` → gets the message (mark_read=true by default)
4. Agent B can `yondermesh_mailbox_reply` to continue the thread

When daemon is running:
- Daemon polls for new unread messages every 5 seconds
- Writes tray notifications to `~/.yondermesh/mailbox-tray/<sid>.txt`
- `yondermesh_mailbox_check` consumes tray notices (push semantics)

When daemon is not running:
- `yondermesh_mailbox_check` falls back to direct DB peek (polling mode, <1ms)
- All functionality still works, just without push notifications

## Channel A: piggyback hints

When you call any non-mailbox MCP tool (e.g., `search_sessions`, `who_is_working`),
the response will include a `📬 mailbox: N unread` line if you have unread messages.
This is a passive reminder — you don't need to actively poll.
