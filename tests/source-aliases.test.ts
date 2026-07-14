import { describe, it, expect } from 'vitest';
import { normalizeSource, expandSource } from '../src/store/source-aliases.js';

describe('Source 别名归一化', () => {
  it('normalizeSource: claude 变体归一化为 claude', () => {
    expect(normalizeSource('claude')).toBe('claude');
    expect(normalizeSource('claude-code')).toBe('claude');
    expect(normalizeSource('claude_code')).toBe('claude');
    expect(normalizeSource('CLAUDE-CODE')).toBe('claude');
  });

  it('normalizeSource: codex 保持不变', () => {
    expect(normalizeSource('codex')).toBe('codex');
  });

  it('normalizeSource: copilot 变体归一化', () => {
    expect(normalizeSource('copilot_cli')).toBe('copilot');
    expect(normalizeSource('copilot-cli')).toBe('copilot');
    expect(normalizeSource('copilot')).toBe('copilot');
  });

  it('normalizeSource: 未知 source 原样返回', () => {
    expect(normalizeSource('some-new-cli')).toBe('some-new-cli');
    expect(normalizeSource('unknown_agent')).toBe('unknown_agent');
  });

  it('expandSource: claude 展开为所有别名', () => {
    const aliases = expandSource('claude');
    expect(aliases).toContain('claude');
    expect(aliases).toContain('claude-code');
    expect(aliases).toContain('claude_code');
    expect(aliases.length).toBeGreaterThanOrEqual(3);
  });

  it('expandSource: claude-code 同样能展开', () => {
    const aliases = expandSource('claude-code');
    expect(aliases).toContain('claude');
    expect(aliases).toContain('claude-code');
    expect(aliases).toContain('claude_code');
  });

  it('expandSource: copilot 展开包含 copilot_cli', () => {
    const aliases = expandSource('copilot');
    expect(aliases).toContain('copilot');
    expect(aliases).toContain('copilot_cli');
    expect(aliases).toContain('copilot-cli');
  });

  it('expandSource: 未知 source 只返回自身', () => {
    const aliases = expandSource('some-unknown');
    expect(aliases).toEqual(['some-unknown']);
  });

  it('expandSource: codex 只返回自身', () => {
    const aliases = expandSource('codex');
    expect(aliases).toEqual(['codex']);
  });

  it('normalizeSource + expandSource 双向一致', () => {
    for (const raw of ['claude-code', 'claude_code', 'claude', 'CLAUDE']) {
      const normalized = normalizeSource(raw);
      const expanded = expandSource(normalized);
      // 归一化后的名称应该在展开列表中
      expect(expanded).toContain(normalized);
      // 原始名称也应该在展开列表中（或其 lowercase 形式）
      expect(expanded).toContain(raw.toLowerCase());
    }
  });
});
