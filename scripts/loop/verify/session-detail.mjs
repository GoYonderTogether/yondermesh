// scripts/loop/verify/session-detail.mjs
// 验证 get_session 的不变式（DB 模式 + live=true 模式）：
//   1. DB 模式：取一条 live session，get_session 返回 messages.length > 0
//   2. DB 完整性：messages 表里该 session 的所有 revision_id 都 == sessions.current_revision_id
//   3. live=true 模式：取一条 claude/codex session，messages.length > 0
//   4. live=true 模式：至少 1 条 message 含 timestamp
// 注：get_session DB 模式不暴露 revision_id 字段（设计如此），所以 revision 链一致性
//     直接查 messages 表验证，而不是依赖接口返回字段。
// exit 0 = 全部不变式成立；exit 1 = 有不变式被违反。
import { execSync } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';

const DB = join(os.homedir(), '.yondermesh', 'yondermesh.db');
const TMP = mkdtempSync(join(os.tmpdir(), 'ymesh-verify-'));
const dbOut = join(TMP, 'db.json');
const liveOut = join(TMP, 'live.json');

function fail(msg) {
  console.error(`[verify-session-detail] FAIL: ${msg}`);
  process.exit(1);
}

function sql(q) {
  return execSync(`sqlite3 "${DB}" "${q}"`, { encoding: 'utf-8' }).trim();
}

function readJsonSafe(p) {
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf-8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`输出非合法 JSON (${p}): ${e.message}`);
    return null;
  }
}

// --- 1. DB 模式：取一条 live session ---
const SID = sql(`SELECT id FROM sessions WHERE retention='live' LIMIT 1;`);
if (!SID) fail('DB 中无 live session');
const CUR = sql(`SELECT current_revision_id FROM sessions WHERE id='${SID}';`);
if (!CUR) fail(`session ${SID} 的 current_revision_id 为空`);

try {
  execSync(`ymesh mcp call get_session '{"session_id":"${SID}"}' 2>/dev/null > "${dbOut}"`, { shell: '/bin/bash', encoding: 'utf-8', timeout: 30000 });
} catch (e) {
  fail(`get_session DB 模式调用失败: ${e.message}`);
}

const dbData = readJsonSafe(dbOut);
if (!dbData) fail(`get_session DB 模式无输出`);

const dbMsgs = dbData.messages;
if (!Array.isArray(dbMsgs) || dbMsgs.length === 0) {
  fail(`get_session DB 模式 messages 为空（期望 length>0）`);
}

// --- 2. DB 完整性：messages 表里该 session 的所有 revision_id 都 == current_revision_id ---
//    （DB 模式 get_session 不暴露 revision_id，直接查表验证 revision 链一致性）
const distinctRevs = sql(`SELECT COUNT(DISTINCT revision_id) FROM messages WHERE session_id='${SID}';`);
if (String(distinctRevs) !== '1') {
  fail(`messages 表 session=${SID} 有 ${distinctRevs} 个不同的 revision_id（期望 1）`);
}
const mismatchedRev = sql(`SELECT COUNT(*) FROM messages WHERE session_id='${SID}' AND revision_id != ${CUR};`);
if (String(mismatchedRev) !== '0') {
  fail(`messages 表有 ${mismatchedRev} 条 revision_id != current_revision_id(${CUR})`);
}

// --- 3. live=true 模式：取一条 claude/codex session ---
const LIVE_SID = sql(`SELECT native_session_id FROM sessions WHERE retention='live' AND source IN ('claude','claude-code','codex') ORDER BY last_seen_at DESC LIMIT 1;`);
if (!LIVE_SID) fail('DB 中无 claude/codex 的 live session（无法测 live=true 模式）');

try {
  execSync(`ymesh mcp call get_session '{"session_id":"${LIVE_SID}","live":true}' 2>/dev/null > "${liveOut}"`, { shell: '/bin/bash', encoding: 'utf-8', timeout: 30000 });
} catch (e) {
  fail(`get_session live=true 调用失败: ${e.message}`);
}

const liveData = readJsonSafe(liveOut);
if (!liveData) fail(`get_session live=true 无输出`);

const liveMsgs = liveData.messages;
if (!Array.isArray(liveMsgs) || liveMsgs.length === 0) {
  fail(`get_session live=true messages 为空（期望 length>0）`);
}

// --- 4. live=true 模式：至少 1 条 message 含 timestamp ---
const withTs = liveMsgs.filter((m) => typeof m.timestamp === 'number' && Number.isFinite(m.timestamp));
if (withTs.length === 0) {
  fail(`live=true 模式所有 messages 都缺 timestamp（期望 >=1 条有 timestamp）`);
}

console.log(`[verify-session-detail] PASS: DB 模式 ${dbMsgs.length} 条消息，revision 链一致（全部 revision_id=${CUR}）；live=true 模式 ${liveMsgs.length} 条消息，${withTs.length} 条带 timestamp`);
