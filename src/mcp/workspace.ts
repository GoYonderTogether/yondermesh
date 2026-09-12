/**
 * workspace —— 工作目录的归属与分组（**写人的意图**）。
 *
 * 为什么它必须能写（而不是从 sessions.project_path 读）：
 *   `project_path` 只能从 CLI 的 cwd 自动推出来。但「这几个目录属于同一摊事」
 *   「这个目录我管它叫笔记库」是**你的判断**，机器推不出来。
 *   所以需要一张人能编辑的表。
 *
 * 场景（用户原话）：
 *   「我在笔记目录下让 agent 管 3 个项目，能不能按工作目录增删改查，
 *     并了解其他工作目录有哪些 agent 正在进行工作」。
 *   → 于是 status 会顺带告诉你该目录下**现在有哪些会话在跑**。
 *
 * 它不是 `observe` 的一部分：observe 是读 agent 状态，这里是写人的意图。
 * 读写混在一个工具里，语义会浑浊。
 */

import type { SessionStore } from '../store/index.js';

export type WorkspaceAction = 'list' | 'add' | 'update' | 'remove' | 'status';

export interface WorkspaceInput {
  action: WorkspaceAction;
  /** 工作目录绝对路径 */
  path?: string;
  /** 给它起个名字（如「笔记库」） */
  label?: string;
  /** 归到哪一组（如「个人」「工作」） */
  group?: string;
  note?: string;
  /** status：只看最近多久内的会话（默认 30 分钟） */
  withinMinutes?: number;
}

export interface WorkspaceResult {
  ok: boolean;
  action: WorkspaceAction;
  text: string;
  data?: unknown;
  error?: string;
}

const LIVE_MS = 120_000;

export function workspace(store: SessionStore, input: WorkspaceInput): WorkspaceResult {
  try {
    switch (input.action) {
      case 'list':
        return doList(store);
      case 'status':
        return doStatus(store, input);
      case 'add':
      case 'update':
        return doUpsert(store, input);
      case 'remove':
        return doRemove(store, input);
      default:
        return { ok: false, action: input.action, text: `无效 action: ${String(input.action)}`, error: 'invalid action' };
    }
  } catch (err) {
    return {
      ok: false,
      action: input.action,
      text: `workspace 失败: ${String(err instanceof Error ? err.message : err)}`,
      error: String(err),
    };
  }
}

function doList(store: SessionStore): WorkspaceResult {
  const all = store.listWorkspaces();
  if (all.length === 0) {
    return {
      ok: true,
      action: 'list',
      text:
        '还没有标记任何工作目录。\n' +
        '  用法：workspace({ action:"add", path:"/Users/.../Obsidian Vault", label:"笔记库", group:"个人" })',
      data: [],
    };
  }
  const byGroup = new Map<string, typeof all>();
  for (const w of all) {
    const g = w.groupName ?? '(未分组)';
    const list = byGroup.get(g) ?? [];
    list.push(w);
    byGroup.set(g, list);
  }
  const lines: string[] = [`已标记 ${all.length} 个工作目录`];
  for (const [g, list] of byGroup) {
    lines.push(`\n【${g}】`);
    for (const w of list) {
      lines.push(`  ${w.label ?? '(无名)'}  ${w.path}`);
      if (w.note) lines.push(`      ${w.note}`);
    }
  }
  return { ok: true, action: 'list', text: lines.join('\n'), data: all };
}

function doStatus(store: SessionStore, input: WorkspaceInput): WorkspaceResult {
  const marked = store.listWorkspaces();
  const withinMs = (input.withinMinutes ?? 30) * 60_000;
  const active = store.getActiveSessionsSummary(withinMs).sessions;
  const now = Date.now();

  const lines: string[] = [];
  const data: Array<{ path: string; label: string | null; sessions: unknown[] }> = [];

  // 已标记的目录：逐个看里面在跑什么
  for (const w of marked) {
    const inside = active.filter(
      (s) =>
        (s.projectPath && isUnder(s.projectPath, w.path)) || (s.cwd && isUnder(s.cwd, w.path)),
    );
    lines.push(
      `\n【${w.label ?? w.path}】${w.path}  —  ${inside.length} 个会话在跑`,
    );
    for (const s of inside) {
      const live = now - s.fileModifiedAt < LIVE_MS ? 'LIVE' : s.activityStatus;
      lines.push(
        `  [${String(live).padEnd(7)}] ${String(s.source).padEnd(10)} ${s.sessionId.slice(0, 12)}  ` +
          `${s.topology.padEnd(8)} ${s.projectPath ?? s.cwd ?? ''}`,
      );
    }
    data.push({ path: w.path, label: w.label, sessions: inside });
  }

  // 未标记但活跃的目录：提示可以标记
  const markedPaths = marked.map((w) => w.path);
  const unmarked = active.filter(
    (s) =>
      s.projectPath &&
      !markedPaths.some((p) => isUnder(s.projectPath!, p)),
  );
  const unmarkedDirs = [...new Set(unmarked.map((s) => s.projectPath!))];
  if (unmarkedDirs.length > 0) {
    lines.push(`\n未标记但活跃的目录（可 add 进来）：`);
    for (const d of unmarkedDirs.slice(0, 8)) {
      const n = unmarked.filter((s) => s.projectPath === d).length;
      lines.push(`  ${d}  —  ${n} 个`);
    }
  }

  return {
    ok: true,
    action: 'status',
    text: lines.length > 0 ? lines.join('\n').trim() : '没有活跃会话，也没有已标记的目录。',
    data,
  };
}

function doUpsert(store: SessionStore, input: WorkspaceInput): WorkspaceResult {
  const path = (input.path ?? '').trim();
  if (!path) {
    return { ok: false, action: input.action, text: `${input.action} 需要 path（工作目录绝对路径）`, error: 'missing path' };
  }
  if (!path.startsWith('/')) {
    return {
      ok: false,
      action: input.action,
      text: `path 需要是绝对路径（收到: ${path}）`,
      error: 'not absolute',
      data: undefined,
    };
  }
  const existed = store.getWorkspace(path);
  store.upsertWorkspace({
    path,
    label: input.label ?? null,
    groupName: input.group ?? null,
    note: input.note ?? null,
  });
  const w = store.getWorkspace(path);
  return {
    ok: true,
    action: input.action,
    text:
      `${existed ? '已更新' : '已标记'}：${w?.label ?? '(无名)'}  ${path}` +
      (w?.groupName ? `\n  分组：${w.groupName}` : '') +
      (w?.note ? `\n  备注：${w.note}` : ''),
    data: w,
  };
}

function doRemove(store: SessionStore, input: WorkspaceInput): WorkspaceResult {
  const path = (input.path ?? '').trim();
  if (!path) {
    return { ok: false, action: 'remove', text: 'remove 需要 path', error: 'missing path' };
  }
  const removed = store.removeWorkspace(path);
  return {
    ok: true,
    action: 'remove',
    text: removed ? `已取消标记：${path}（未动任何会话）` : `该目录本来就没有标记：${path}`,
    data: { removed },
  };
}

/** path 是否在 root 之下（目录边界安全，避免 /a/bc 命中 /a/b） */
function isUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const r = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(r);
}
