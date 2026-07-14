#!/usr/bin/env bash
# yondermesh system health diagnostics
# Usage: diagnose.sh [--json] [--section <name>] [--verbose]
# Sections: install, db, daemon, logs, cli, adapters, all
set -euo pipefail

YONDERMESH_HOME="${YONDERMESH_HOME:-$HOME/.yondermesh}"
SECTION="all"
VERBOSE="${VERBOSE:-false}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) shift ;;
    --section) SECTION="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    *) shift ;;
  esac
done

PASS=0
WARN=0
FAIL=0
ISSUES=()

check_pass() { PASS=$((PASS+1)); }
check_warn() { WARN=$((WARN+1)); ISSUES+=("WARN: $1"); }
check_fail() { FAIL=$((FAIL+1)); ISSUES+=("FAIL: $1"); }

section_line() { printf '\n==== %s ====\n' "$1"; }

# --- INSTALL ---
check_install() {
  section_line "INSTALL"
  local entry="$YONDERMESH_HOME/bin/ymesh"
  local current_sym="$YONDERMESH_HOME/releases/current"
  local prev_sym="$YONDERMESH_HOME/releases/previous"

  printf 'YONDERMESH_HOME = %s\n' "$YONDERMESH_HOME"

  if [[ -d "$YONDERMESH_HOME" ]]; then
    check_pass; printf '  data dir exists\n'
  else
    check_fail "data dir missing: $YONDERMESH_HOME"
    return
  fi

  if [[ -L "$entry" ]] && [[ -e "$entry" ]]; then
    local target; target=$(readlink "$entry" 2>/dev/null || echo "?")
    check_pass; printf '  entry symlink -> %s\n' "$target"
  else
    check_fail "entry symlink broken or missing: $entry"
  fi

  if [[ -L "$current_sym" ]] && [[ -e "$current_sym" ]]; then
    local ver; ver=$(readlink "$current_sym" 2>/dev/null || echo "?")
    check_pass; printf '  current release -> %s\n' "$ver"
  else
    check_warn "no current release symlink"
  fi

  if [[ -L "$prev_sym" ]]; then
    check_pass; printf '  previous release available (rollback ready)\n'
  else
    check_warn "no previous release (no rollback target)"
  fi

  if command -v ymesh &>/dev/null; then
    check_pass; printf '  ymesh in PATH at %s\n' "$(command -v ymesh)"
  else
    check_warn "ymesh not in PATH"
  fi
}

# --- DATABASE ---
check_db() {
  section_line "DATABASE"
  local db="$YONDERMESH_HOME/yondermesh.db"

  if [[ ! -f "$db" ]]; then
    check_fail "database missing: $db"
    return
  fi

  local size; size=$(stat -f%z "$db" 2>/dev/null || stat --printf='%s' "$db" 2>/dev/null || echo "?")
  check_pass; printf '  db file: %s (%s bytes)\n' "$db" "$size"

  if ! command -v sqlite3 &>/dev/null; then
    check_warn "sqlite3 CLI not available, cannot inspect db"
    return
  fi

  local integrity; integrity=$(sqlite3 "$db" "PRAGMA integrity_check;" 2>&1 || echo "ERROR")
  if [[ "$integrity" == "ok" ]]; then
    check_pass; printf '  integrity_check: ok\n'
  else
    check_fail "integrity_check failed: $integrity"
  fi

  local table_count; table_count=$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "?")
  local table_count; table_count=$(sqlite3 "$db" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" 2>/dev/null || echo "?")
  printf '  tables: %s (expected: 6)\n' "$table_count"

  local session_total; session_total=$(sqlite3 "$db" "SELECT count(*) FROM sessions;" 2>/dev/null || echo "0")
  printf '  total sessions: %s\n' "$session_total"

  if [[ "$session_total" -gt 0 ]] 2>/dev/null; then
    check_pass
    printf '  by source:\n'
    sqlite3 -column "$db" "
      SELECT si.source, count(s.id) as sessions
      FROM sessions s JOIN source_instances si ON s.source_instance_id = si.id
      GROUP BY si.source ORDER BY sessions DESC;" 2>/dev/null | sed 's/^/    /' || true
  else
    check_warn "no sessions in db (run ymesh scan first)"
  fi

  local msg_total; msg_total=$(sqlite3 "$db" "SELECT count(*) FROM messages;" 2>/dev/null || echo "0")
  printf '  total messages: %s\n' "$msg_total"

  local last_scan; last_scan=$(sqlite3 "$db" "SELECT datetime(ended_at/1000, 'unixepoch', 'localtime') FROM scan_runs WHERE status='completed' ORDER BY ended_at DESC LIMIT 1;" 2>/dev/null || echo "none")
  printf '  last scan completed: %s\n' "$last_scan"

  local rel_total; rel_total=$(sqlite3 "$db" "SELECT count(*) FROM session_relationships;" 2>/dev/null || echo "0")
  printf '  relationships: %s\n' "$rel_total"

  local rev_total; rev_total=$(sqlite3 "$db" "SELECT count(*) FROM session_revisions;" 2>/dev/null || echo "0")
  printf '  revisions: %s\n' "$rev_total"
}

# --- DAEMON ---
check_daemon() {
  section_line "DAEMON"
  local pid_file="$YONDERMESH_HOME/daemon.pid"

  if [[ ! -f "$pid_file" ]]; then
    check_warn "no pid file (daemon not started or crashed)"
  else
    local pid; pid=$(cat "$pid_file" 2>/dev/null || echo "")
    if [[ -n "$pid" ]]; then
      if kill -0 "$pid" 2>/dev/null; then
        check_pass; printf '  daemon running (pid %s)\n' "$pid"
      else
        check_fail "stale pid file: pid $pid not alive (daemon crashed or was killed)"
        rm -f "$pid_file" 2>/dev/null || true
        printf '  cleaned stale pid file\n'
      fi
    else
      check_fail "pid file exists but empty"
    fi
  fi

  local plist="$HOME/Library/LaunchAgents/com.yondermesh.daemon.plist"
  if [[ -f "$plist" ]]; then
    check_pass; printf '  LaunchAgent plist installed\n'
    if command -v launchctl &>/dev/null; then
      local loaded; loaded=$(launchctl list 2>/dev/null | grep -c "yondermesh" || echo "0")
      if [[ "$loaded" -gt 0 ]]; then
        check_pass; printf '  LaunchAgent loaded\n'
      else
        check_warn "plist exists but LaunchAgent not loaded (try: launchctl load $plist)"
      fi
    fi
  else
    check_warn "no LaunchAgent plist (daemon must be started manually)"
  fi
}

# --- LOGS ---
check_logs() {
  section_line "LOGS"
  local log_dir="$HOME/.local/state/yondermesh"
  if [[ ! -d "$log_dir" ]]; then
    log_dir="$YONDERMESH_HOME/logs"
  fi

  if [[ ! -d "$log_dir" ]]; then
    check_warn "no log directory found"
    return
  fi

  check_pass; printf '  log dir: %s\n' "$log_dir"

  local recent_errors; recent_errors=$(grep -ri 'error\|fail\|crash\|exception' "$log_dir" 2>/dev/null | tail -5 || true)
  if [[ -n "$recent_errors" ]]; then
    check_warn "found error patterns in recent logs"
    if [[ "$VERBOSE" == "true" ]]; then
      printf '%s\n' "$recent_errors" | sed 's/^/    /'
    else
      printf '  (use --verbose or: grep -ri error %s)\n' "$log_dir"
    fi
  else
    check_pass; printf '  no error patterns in logs\n'
  fi

  local latest_log; latest_log=$(ls -t "$log_dir"/*.log 2>/dev/null | head -1 || true)
  if [[ -n "$latest_log" ]]; then
    local mod_time; mod_time=$(stat -f '%Sm' "$latest_log" 2>/dev/null || stat --printf='%y' "$latest_log" 2>/dev/null || echo "?")
    printf '  latest log: %s (modified %s)\n' "$(basename "$latest_log")" "$mod_time"
  fi
}

# --- CLI ---
check_cli() {
  section_line "CLI"
  local entry="$YONDERMESH_HOME/bin/ymesh"
  local ymesh_cmd=""

  if [[ -L "$entry" ]] && [[ -e "$entry" ]]; then
    ymesh_cmd="$entry"
  elif command -v ymesh &>/dev/null; then
    ymesh_cmd="ymesh"
  else
    check_fail "no ymesh binary found"
    return
  fi

  if "$ymesh_cmd" version &>/dev/null 2>&1; then
    local ver; ver=$("$ymesh_cmd" version 2>/dev/null | head -1)
    check_pass; printf '  version: %s\n' "$ver"
  else
    check_fail "ymesh version command failed"
  fi

  if "$ymesh_cmd" status &>/dev/null 2>&1; then
    check_pass; printf '  status command works\n'
    if [[ "$VERBOSE" == "true" ]]; then
      "$ymesh_cmd" status 2>/dev/null | sed 's/^/    /'
    fi
  else
    check_warn "status command returned error (may need scan first)"
  fi
}

# --- ADAPTERS ---
check_adapters() {
  section_line "ADAPTERS"
  local db="$YONDERMESH_HOME/yondermesh.db"
  if [[ ! -f "$db" ]] || ! command -v sqlite3 &>/dev/null; then
    check_warn "cannot check adapters without db+sqlite3"
    return
  fi

  printf '  source instances:\n'
  sqlite3 -column "$db" "
    SELECT id, source, coverage, substr(root_path, 1, 60) as path
    FROM source_instances ORDER BY source;" 2>/dev/null | sed 's/^/    /' || echo "    (none)"

  local claude_dir="$HOME/.claude/projects"
  if [[ -d "$claude_dir" ]]; then
    local count; count=$(find "$claude_dir" -name '*.jsonl' 2>/dev/null | wc -l || echo "0")
    printf '  claude raw: %s jsonl files in ~/.claude/projects\n' "$count"
  else
    check_warn "no ~/.claude/projects directory"
  fi

  local codex_dir="$HOME/.codex/sessions"
  if [[ -d "$codex_dir" ]]; then
    local count; count=$(find "$codex_dir" -name '*.jsonl' 2>/dev/null | wc -l || echo "0")
    printf '  codex raw: %s jsonl files in ~/.codex/sessions\n' "$count"
  fi

  local cass_db="$HOME/Library/Application Support/com.coding-agent-search.coding-agent-search/agent_search.db"
  if [[ -f "$cass_db" ]]; then
    check_pass; printf '  cass db found\n'
  else
    printf '  cass db: not found (optional, B-coverage only)\n'
  fi
}

# --- MAIN ---
main() {
  printf '===== yondermesh system diagnostics =====\n'
  printf '  time: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf '  host: %s\n' "$(hostname 2>/dev/null || echo '?')"

  case "$SECTION" in
    install) check_install ;;
    db) check_db ;;
    daemon) check_daemon ;;
    logs) check_logs ;;
    cli) check_cli ;;
    adapters) check_adapters ;;
    all)
      check_install
      check_db
      check_daemon
      check_adapters
      check_cli
      check_logs
      ;;
    *) printf 'unknown section: %s\n' "$SECTION"; exit 1 ;;
  esac

  printf '\n===== SUMMARY =====\n'
  printf '  PASS: %s  WARN: %s  FAIL: %s\n' "$PASS" "$WARN" "$FAIL"

  if [[ ${#ISSUES[@]} -gt 0 ]]; then
    printf '\n  Issues:\n'
    for issue in "${ISSUES[@]}"; do
      printf '    %s\n' "$issue"
    done
  fi

  if [[ "$FAIL" -gt 0 ]]; then
    printf '\n  STATUS: UNHEALTHY (%d failures)\n' "$FAIL"
    exit 1
  elif [[ "$WARN" -gt 0 ]]; then
    printf '\n  STATUS: DEGRADED (%d warnings)\n' "$WARN"
    exit 0
  else
    printf '\n  STATUS: HEALTHY\n'
    exit 0
  fi
}

main
