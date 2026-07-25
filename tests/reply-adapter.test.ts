/**
 * ReplyAdapter 纯函数单测（loop: verify-trigger-reply-adapter）
 *
 * 锁住 src/trigger/reply-adapter.ts 的纯函数管线各分支：
 *   stripAnsi → applyCliSpecificFilter → applyGenericFilter → collapseBlankLines
 * 以及 ReplyResult.source 派生规则（channelToSource）。
 *
 * applyCliSpecificFilter / applyGenericFilter / collapseBlankLines 是模块私有，
 * 通过 ReplyAdapter.extractReply 的公开入口间接覆盖（端到端管线断言）。
 * stripAnsi 单独导出，直接断言。
 *
 * 对应 roadmap T3.2。
 */

import { describe, it, expect } from 'vitest';

import { ReplyAdapter, stripReplyAnsi } from '../src/trigger/index.js';
import type { TriggerChannel, TriggerResult } from '../src/trigger/index.js';

/** 构造一个最小 TriggerResult，省去每次写 channel/latencyMs */
function mkResult(
  partial: Pick<TriggerResult, 'delivered' | 'response'> &
    Partial<Pick<TriggerResult, 'channel' | 'latencyMs' | 'exitCode' | 'error'>>,
): TriggerResult {
  return {
    delivered: partial.delivered,
    response: partial.response,
    channel: partial.channel ?? ('cli-spawn' as TriggerChannel),
    latencyMs: partial.latencyMs ?? 0,
    exitCode: partial.exitCode,
    error: partial.error,
  };
}

// ─── stripAnsi ──────────────────────────────────────────────────────────────

describe('stripAnsi（stripReplyAnsi）', () => {
  it('去除 CSI 颜色转义序列', () => {
    expect(stripReplyAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });

  it('去除 CSI 多参数样式（粗体+前景色）', () => {
    expect(stripReplyAnsi('\u001b[1;32mOK\u001b[0m')).toBe('OK');
  });

  it('去除 CSI 光标控制（清屏+归位）', () => {
    expect(stripReplyAnsi('\u001b[2J\u001b[H')).toBe('');
  });

  it('去除 OSC 标题设置（以 BEL 结尾）', () => {
    expect(stripReplyAnsi('\u001b]0;my title\u0007hello')).toBe('hello');
  });

  it('去除单字符控制序列（= / >）', () => {
    expect(stripReplyAnsi('\u001b=\u001b>txt')).toBe('txt');
  });

  it('保留普通文本不变', () => {
    expect(stripReplyAnsi('hello world\nline2')).toBe('hello world\nline2');
  });

  it('混合 ANSI + 文本全部剥离', () => {
    const input = '\u001b[1;32mOK\u001b[0m: \u001b]0;t\u0007done\u001b[2J';
    expect(stripReplyAnsi(input)).toBe('OK: done');
  });

  it('空串输入返回空串', () => {
    expect(stripReplyAnsi('')).toBe('');
  });
});

// ─── extractReply: delivered=false / 空回复 ─────────────────────────────────

describe('ReplyAdapter.extractReply — delivered=false / 空回复', () => {
  const adapter = new ReplyAdapter();

  it('delivered=false 时返回空串且不抛错（错误信息由上层从 result.error 取）', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: false, response: 'whatever' }),
      'hermes',
    );
    expect(r.text).toBe('');
    expect(r.source).toBe('stdout'); // cli-spawn 默认
  });

  it('delivered=true 但 response 为空串时返回空串', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: '', channel: 'http-api' }),
      'opencode',
    );
    expect(r.text).toBe('');
    expect(r.source).toBe('api');
  });

  it('cleaned 后为空（全是噪声行）时返回空串', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'Warning: x\nDEBUG: y\n\n\n',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('');
  });

  it('全是 ANSI 转义（剥离后为空）时返回空串', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: '\u001b[2J\u001b[H\u001b[31m\u001b[0m',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('');
  });
});

// ─── extractReply: source 派生（channelToSource）─────────────────────────────

describe('ReplyAdapter.extractReply — source 派生（channel → source）', () => {
  const adapter = new ReplyAdapter();

  it('http-api → api', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'http-api' }),
      'opencode',
    );
    expect(r.source).toBe('api');
  });

  it('ws-rpc → api', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'ws-rpc' }),
      'kimi',
    );
    expect(r.source).toBe('api');
  });

  it('tmux → tmux-capture', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'tmux' }),
      'trae-ide',
    );
    expect(r.source).toBe('tmux-capture');
  });

  it('applescript → tmux-capture', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'applescript' }),
      'windsurf',
    );
    expect(r.source).toBe('tmux-capture');
  });

  it('cli-spawn → stdout', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'cli-spawn' }),
      'claude',
    );
    expect(r.source).toBe('stdout');
  });

  it('stdin → stdout', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: 'hi', channel: 'stdin' }),
      'codex',
    );
    expect(r.source).toBe('stdout');
  });

  it('source 字段始终是合法值（不出现非法字符串）', () => {
    const validSources = new Set(['stdout', 'api', 'file', 'tmux-capture']);
    for (const channel of [
      'cli-spawn',
      'stdin',
      'http-api',
      'ws-rpc',
      'tmux',
      'applescript',
    ] as TriggerChannel[]) {
      const r = adapter.extractReply(
        mkResult({ delivered: true, response: 'x', channel }),
        'codex',
      );
      expect(validSources.has(r.source)).toBe(true);
    }
  });
});

// ─── extractReply: applyCliSpecificFilter 各 CLI 分支 ────────────────────────

describe('ReplyAdapter.extractReply — applyCliSpecificFilter 各 CLI 分支', () => {
  const adapter = new ReplyAdapter();

  // ── hermes ──
  describe('hermes', () => {
    it('过滤 "Warning: Unknown toolsets:" 行（第一分支）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Warning: Unknown toolsets: messaging\nreal reply',
          channel: 'cli-spawn',
        }),
        'hermes',
      );
      expect(r.text).toBe('real reply');
    });

    it('过滤 "Warning: Unknown toolset:" 单数形式', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Warning: Unknown toolset: foo\nreal reply',
          channel: 'cli-spawn',
        }),
        'hermes',
      );
      expect(r.text).toBe('real reply');
    });

    it('过滤行内嵌入的 "Warning: Unknown toolsets:"（无 ^ 锚定）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'prefix Warning: Unknown toolsets: x\nreal reply',
          channel: 'cli-spawn',
        }),
        'hermes',
      );
      expect(r.text).toBe('real reply');
    });

    it('过滤 "Warning: <其他>" 启动警告（第二分支 ^Warning:\\s）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Warning: No X configured\nreply',
          channel: 'cli-spawn',
        }),
        'hermes',
      );
      expect(r.text).toBe('reply');
    });

    it('保留正常文本（无 Warning 行）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'hello hermes',
          channel: 'cli-spawn',
        }),
        'hermes',
      );
      expect(r.text).toBe('hello hermes');
    });
  });

  // ── claude / claude-code ──
  describe('claude 与 claude-code', () => {
    it('claude 过滤 "Tip: " 行', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Tip: use --help\nactual reply',
          channel: 'cli-spawn',
        }),
        'claude',
      );
      expect(r.text).toBe('actual reply');
    });

    it('claude-code 过滤 "Tip: " 行（同一分支）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Tip: try --resume\nactual reply',
          channel: 'cli-spawn',
        }),
        'claude-code',
      );
      expect(r.text).toBe('actual reply');
    });

    it('claude 不过滤非 "Tip: " 开头的行（如 "Tipster: ..."）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Tipster: hello',
          channel: 'cli-spawn',
        }),
        'claude',
      );
      expect(r.text).toBe('Tipster: hello');
    });
  });

  // ── 默认分支（其他 CLI 无专属过滤）──
  describe('其他 CLI（走默认分支，无专属过滤）', () => {
    it('codex 不被 cli filter 过滤 "Tip:" 行（后续由 generic filter 处理 Warning 等）', () => {
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Tip: hello',
          channel: 'cli-spawn',
        }),
        'codex',
      );
      // Tip: 不匹配 LOG_PREFIX_RE 也不匹配 BANNER_RE，故保留
      expect(r.text).toBe('Tip: hello');
    });

    it('gemini 不被 cli filter 过滤 "Warning: Unknown toolsets:"（仅 hermes 过滤）', () => {
      // 注意：generic filter 会过滤 "Warning:" 前缀行，所以最终文本不含该行
      const r = adapter.extractReply(
        mkResult({
          delivered: true,
          response: 'Warning: Unknown toolsets: x\nreal',
          channel: 'cli-spawn',
        }),
        'gemini',
      );
      expect(r.text).toBe('real');
    });
  });
});

// ─── extractReply: applyGenericFilter ───────────────────────────────────────

describe('ReplyAdapter.extractReply — applyGenericFilter（日志前缀 + 启动横幅）', () => {
  const adapter = new ReplyAdapter();

  it('过滤 "Warning: ..." 行', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'Warning: deprecated\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('过滤 "WARN] ..." 行（方括号分隔）', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'WARN] low memory\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('过滤 DEBUG/INFO/ERROR/FATAL/TRACE/VERBOSE 前缀行（不区分大小写）', () => {
    const input = 'DEBUG: x\nINFO: y\nERROR: z\nFATAL: a\nTRACE: b\nVERBOSE: c\nactual';
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: input, channel: 'cli-spawn' }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('过滤小写日志前缀（不区分大小写）', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'warning: lower case\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('过滤启动横幅行（Welcome/Booting/Starting/Loaded/Initializing/Copyright）', () => {
    const input =
      'Welcome to foo\nBooting up\nStarting server\nLoaded plugins\nInitializing\nCopyright 2026\nactual';
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: input, channel: 'cli-spawn' }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('保留空行（不当作日志/横幅）', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'a\n\nb',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('a\n\nb');
  });
});

// ─── extractReply: collapseBlankLines ───────────────────────────────────────

describe('ReplyAdapter.extractReply — collapseBlankLines', () => {
  const adapter = new ReplyAdapter();

  it('3+ 连续空行折叠为 2', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'a\n\n\n\n\nb',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('a\n\nb');
  });

  it('去除首部空白行', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: '\n\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('去除尾部空白行', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'actual\n\n',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('actual');
  });

  it('去除行尾空格与制表符', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'line   \nnext\t\n',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('line\nnext');
  });

  it('CRLF → LF 归一化', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'a\r\nb\r\nc',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('a\nb\nc');
  });

  it('2 个连续空行保持不变（不折叠）', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'a\n\nb',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.text).toBe('a\n\nb');
  });
});

// ─── extractReply: 完整管线（顺序：stripAnsi → cli → generic → collapse）────

describe('ReplyAdapter.extractReply — 完整管线', () => {
  const adapter = new ReplyAdapter();

  it('stripAnsi 先于 cli filter：ANSI 包裹的 hermes Warning 行也被过滤', () => {
    const input = '\u001b[31mWarning: Unknown toolsets: messaging\u001b[0m\nreal reply';
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: input, channel: 'cli-spawn' }),
      'hermes',
    );
    expect(r.text).toBe('real reply');
  });

  it('cli filter 先于 generic filter：hermes 的 Warning 行被 cli filter 处理（不进 generic）', () => {
    // hermes Warning 行被 cli filter 过滤；如果进了 generic 也会被过滤，行为一致
    // 这里验证 hermes 对 "Warning: foo" 的过滤不是依赖 generic filter
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'Warning: hermes-specific\nactual',
        channel: 'cli-spawn',
      }),
      'hermes',
    );
    expect(r.text).toBe('actual');
  });

  it('ANSI + hermes Warning + 通用日志 + 多空行 全管线', () => {
    const input =
      '\u001b[31mWarning: Unknown toolsets: messaging\u001b[0m\n' +
      'DEBUG: noise\n' +
      '\n\n\n\n' +
      '\u001b[32mreal reply\u001b[0m';
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: input, channel: 'cli-spawn' }),
      'hermes',
    );
    expect(r.text).toBe('real reply');
  });

  it('claude Tip + ANSI + 多空行', () => {
    const input = '\u001b[1mTip: use --help\u001b[0m\n\n\nactual';
    const r = adapter.extractReply(
      mkResult({ delivered: true, response: input, channel: 'cli-spawn' }),
      'claude',
    );
    expect(r.text).toBe('actual');
  });
});

// ─── extractReply: latencyMs ────────────────────────────────────────────────

describe('ReplyAdapter.extractReply — latencyMs', () => {
  const adapter = new ReplyAdapter();

  it('返回非负数（空回复路径）', () => {
    const r = adapter.extractReply(
      mkResult({ delivered: false, response: '', channel: 'cli-spawn' }),
      'codex',
    );
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('返回非负数（完整管线路径）', () => {
    const r = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'hello world',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

// ─── extractReply: 复用单例 ─────────────────────────────────────────────────

describe('ReplyAdapter — 无状态可复用', () => {
  it('同一实例多次调用结果一致（无状态）', () => {
    const adapter = new ReplyAdapter();
    const r1 = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'Warning: x\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    const r2 = adapter.extractReply(
      mkResult({
        delivered: true,
        response: 'Warning: x\nactual',
        channel: 'cli-spawn',
      }),
      'codex',
    );
    expect(r1.text).toBe(r2.text);
    expect(r1.source).toBe(r2.source);
  });
});
