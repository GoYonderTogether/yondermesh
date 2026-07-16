import { describe, it, expect } from 'vitest';

import {
  ADAPTERS,
  getAdapter,
  listAdapters,
  listImporters,
  loadWrapper,
} from '../src/adapters/registry.js';

// ── getAdapter ──────────────────────────────────────────────────────────────

describe('getAdapter', () => {
  it('命中已知 CLI', () => {
    const hermes = getAdapter('hermes');
    expect(hermes).toBeDefined();
    expect(hermes!.id).toBe('hermes');
    expect(hermes!.displayName).toBe('Hermes Agent');
    expect(hermes!.coverage).toBe('A');
    expect(hermes!.importerLoader).toBeDefined();
    expect(hermes!.wrapperLoader).toBeDefined();
    expect(hermes!.injectLoader).toBeDefined();
  });

  it('命中 mount-only CLI（无 importer/wrapper）', () => {
    const cursor = getAdapter('cursor');
    expect(cursor).toBeDefined();
    expect(cursor!.id).toBe('cursor');
    expect(cursor!.importerLoader).toBeUndefined();
    expect(cursor!.wrapperLoader).toBeUndefined();
    expect(cursor!.mountCapabilities.length).toBeGreaterThan(0);
  });

  it('未命中返回 undefined', () => {
    expect(getAdapter('nonexistent-cli')).toBeUndefined();
    expect(getAdapter('')).toBeUndefined();
  });
});

// ── listAdapters ────────────────────────────────────────────────────────────

describe('listAdapters', () => {
  it('返回全部 32 个适配器', () => {
    const all = listAdapters();
    expect(all).toHaveLength(32);
    expect(all).toBe(ADAPTERS);
  });

  it('每个条目都有必填字段', () => {
    for (const a of listAdapters()) {
      expect(a.id).toBeTruthy();
      expect(a.displayName).toBeTruthy();
      expect(['A', 'B', 'C']).toContain(a.coverage);
      expect(Array.isArray(a.mountCapabilities)).toBe(true);
      expect(Array.isArray(a.channels)).toBe(true);
    }
  });

  it('ID 无重复', () => {
    const ids = listAdapters().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── listImporters ───────────────────────────────────────────────────────────

describe('listImporters', () => {
  it('只返回有 importerLoader 的条目（27 个）', () => {
    const importers = listImporters();
    expect(importers).toHaveLength(27);
    for (const a of importers) {
      expect(a.importerLoader).toBeDefined();
    }
  });

  it('排除无采集器的 CLI', () => {
    const ids = new Set(listImporters().map((a) => a.id));
    // omp / gsd-pi 由 PiImporter 共享采集，无独立 importerLoader
    // cursor / trae / trae-cn 仅有挂载能力，无采集器
    expect(ids.has('omp')).toBe(false);
    expect(ids.has('gsd-pi')).toBe(false);
    expect(ids.has('cursor')).toBe(false);
    expect(ids.has('trae')).toBe(false);
    expect(ids.has('trae-cn')).toBe(false);
  });

  it('包含所有 cmdScan 里的采集源', () => {
    const ids = new Set(listImporters().map((a) => a.id));
    const expected = [
      'cass', 'claude-code', 'codex', 'hermes', 'continue', 'opencode',
      'copilot', 'openclaw', 'kimi', 'qwen', 'gemini', 'pi', 'factory',
      'vibe', 'codebuddy', 'cline', 'crush', 'openhands', 'goose',
      'antigravity', 'aider', 'trae-cli', 'windsurf', 'cursor-ide',
      'trae-ide', 'amp', 'chatgpt',
    ];
    for (const id of expected) {
      expect(ids.has(id)).toBe(true);
    }
  });
});

// ── loadWrapper ─────────────────────────────────────────────────────────────

describe('loadWrapper', () => {
  it('无 wrapper 的 CLI 返回 null', async () => {
    const result = await loadWrapper('claude-code');
    expect(result).toBeNull();
  });

  it('不存在的 CLI 返回 null', async () => {
    const result = await loadWrapper('nonexistent-cli');
    expect(result).toBeNull();
  });
});

// ── 数据一致性 ──────────────────────────────────────────────────────────────

describe('数据一致性', () => {
  it('有 wrapperLoader 的条目恰好 23 个（与 WRAPPER_LOADERS 对齐）', () => {
    const wrappers = listAdapters().filter((a) => a.wrapperLoader !== undefined);
    expect(wrappers).toHaveLength(23);
  });

  it('有 injectLoader 的条目恰好 23 个（与 inject.ts 文件对齐）', () => {
    const injects = listAdapters().filter((a) => a.injectLoader !== undefined);
    expect(injects).toHaveLength(23);
  });

  it('channels 与 trigger/adapter.ts 分类一致', () => {
    // IDE 类 → tmux + applescript
    expect(getAdapter('trae-ide')!.channels).toEqual(['tmux', 'applescript']);
    expect(getAdapter('windsurf')!.channels).toEqual(['tmux', 'applescript']);
    expect(getAdapter('cursor-ide')!.channels).toEqual(['tmux', 'applescript']);
    expect(getAdapter('chatgpt')!.channels).toEqual(['tmux', 'applescript']);
    // HTTP API 类
    expect(getAdapter('opencode')!.channels).toEqual(['http-api']);
    expect(getAdapter('qwen')!.channels).toEqual(['http-api']);
    expect(getAdapter('openhands')!.channels).toEqual(['http-api']);
    // WS-RPC 类
    expect(getAdapter('kimi')!.channels).toEqual(['ws-rpc']);
    expect(getAdapter('openclaw')!.channels).toEqual(['ws-rpc']);
    expect(getAdapter('pi')!.channels).toEqual(['ws-rpc']);
    expect(getAdapter('copilot')!.channels).toEqual(['ws-rpc']);
    // CLI-spawn 类
    expect(getAdapter('hermes')!.channels).toEqual(['cli-spawn']);
    expect(getAdapter('codex')!.channels).toEqual(['cli-spawn']);
  });
});

