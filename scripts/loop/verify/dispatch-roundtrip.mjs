// scripts/loop/verify/dispatch-roundtrip.mjs
// 端到端验证 send+reply+审计：向一个已认证的双向 CLI 发"创建文件"任务，
// 断言：delivered=true、文件真被创建且非空、agent_messages 表留有审计。
// 失败说明派发链路或该 CLI 未认证 —— 这正是要暴露的真实状态。
// 可用 DISPATCH_CLI=codex,claude 指定候选；默认 codex,claude,hermes。
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const DB = join(os.homedir(), '.yondermesh', 'yondermesh.db');
const ts = Date.now();
const probe = `/tmp/ymesh-probe-${ts}.txt`;
const candidates = (process.env.DISPATCH_CLI || 'codex,claude,hermes').split(',').map(s => s.trim()).filter(Boolean);

let last = null;
for (const cli of candidates) {
  try {
    const r = execSync(`ymesh send --cli ${cli} --mode new --message "在 ${probe} 写入内容 ok，只做这一件事" --json`, { encoding: 'utf-8', timeout: 120000 });
    const j = JSON.parse(r);
    last = { cli, ...j };
    if (j.delivered) {
      // delivered 后必须确认探针文件真被创建（CLI 沙箱可能拒绝写 /tmp）
      if (existsSync(probe) && readFileSync(probe, 'utf-8').trim().length > 0) break;
      // delivered 但文件未创建：CLI 不接受该任务或沙箱拦截，继续试下一个候选
    }
  } catch (e) {
    last = { cli, error: String(e.message).slice(0, 100) };
  }
}

const fileCreated = existsSync(probe) && readFileSync(probe, 'utf-8').trim().length > 0;
let auditRows = 0;
try {
  auditRows = Number(execSync(`sqlite3 "${DB}" "SELECT COUNT(*) FROM agent_messages WHERE body LIKE '%${probe}%';"`, { encoding: 'utf-8' }).trim());
} catch {}

const result = { probe, delivered: !!last?.delivered, fileCreated, auditRows, response: (last?.response || '').slice(0, 80), last };
console.log(JSON.stringify(result, null, 2));
const pass = last && last.delivered && fileCreated && auditRows >= 1;
if (!pass) console.error('未通过：派发链路未端到端跑通（可能 CLI 未认证 / 无回复 / 审计未写）');
process.exit(pass ? 0 : 1);
