/**
 * redact.test.ts — 纯函数脱敏测试
 *
 * 验收门（loop build-retrospective §A）：
 *   A1. 输入字符串，输出脱敏后字符串；永不抛错（try/catch 兜底返回原串）
 *   A2. 必脱敏的模式：env 变量名 / .env 行 / API key 前缀 / home 路径 /
 *       邮箱 / .ssh|.aws|.gnupg 截断
 *   A3. 不误伤 ymesh session id / git commit hash / IPv4 / 公开 URL
 *   A4. 纯函数 + 无 I/O + 可单测
 */

import { describe, it, expect } from 'vitest';
import { redact } from './redact.js';

describe('redact — A2 必脱敏模式（正例）', () => {
  it('env 变量名（*_TOKEN / *_KEY / *_SECRET / *_PASSWORD / *_API_KEY）+ 值 → <redacted>', () => {
    // pragma: allowlist secret
    expect(redact('OPENAI_API_KEY=sk-abcdef1234567890')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('GITHUB_TOKEN=ghp_1234567890abcdefghij')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('AWS_SECRET_KEY=wJalrXUtFEIEXAMPLEKEY')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('DB_PASSWORD=supersecretpw')).toBe('<redacted>');
    // 行内 + 前后文
    // pragma: allowlist secret
    expect(redact('set OPENAI_API_KEY=sk-abcdef1234567890 now')).toBe('set <redacted> now');
    // 短值但 NAME 命中 secret 模式 → 仍脱敏
    // pragma: allowlist secret
    expect(redact('OPENAI_API_KEY=short')).toBe('<redacted>');
  });

  it('.env 行：KEY=VALUE 且 VALUE 长度 ≥ 8 → 整段替换为 <redacted>', () => {
    expect(redact('DATABASE_URL=postgresuuh5432db')).toBe('<redacted>');
    expect(redact('MY_VAR=abcdefgh')).toBe('<redacted>');
    // 行首有空格也算 .env 行
    expect(redact('  INDENT_VAR=12345678')).toBe('<redacted>');
    // 多行 .env 文件
    const multi = [
      'FOO=short',
      'BAR=longervaluexxx',
      'BAZ=qwertyuiop',
    ].join('\n');
    const out = redact(multi);
    // FOO 值短 → 保留；BAR/BAZ 值 ≥ 8 → 整行 <redacted>
    expect(out).toContain('FOO=short');
    expect(out).not.toContain('BAR=longervaluexxx');
    expect(out).not.toContain('BAZ=qwertyuiop');
    expect(out.match(/<redacted>/g)?.length).toBe(2);
  });

  it('API key 前缀模式（sk- / ghp_ / gho_ / ghs_ / ghr_ / AKIA / xoxb- / AIza + ≥16 字符）', () => {
    // pragma: allowlist secret
    expect(redact('sk-1234567890abcdefGHIJKL')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('ghp_1234567890abcdefghij')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('gho_1234567890abcdefghij')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('ghs_1234567890abcdefghij')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('ghr_1234567890abcdefghij')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('AKIA1234567890ABCDEF')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('xoxb-1234567890abcdef')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('AIza1234567890abcdef')).toBe('<redacted>');
    // 前缀 + 上下文
    // pragma: allowlist secret
    expect(redact('Authorization Bearer sk-1234567890abcdefXYZ')).toBe('Authorization Bearer <redacted>');
  });

  it('macOS / Linux home 绝对路径 → ~/', () => {
    expect(redact('/Users/zoran/projects/foo')).toBe('~/projects/foo');
    expect(redact('/home/alice/code/bar')).toBe('~/code/bar');
    // 多次出现
    expect(redact('cp /Users/zoran/a /Users/zoran/b')).toBe('cp ~/a ~/b');
  });

  it('邮箱（RFC 5322 简化版）→ <redacted>', () => {
    expect(redact('contact user@example.com for info')).toBe('contact <redacted> for info');
    expect(redact('alice.bob+tag@sub.domain.org')).toBe('<redacted>');
    expect(redact('send to foo@bar.io and baz@qux.co.uk please')).toBe('send to <redacted> and <redacted> please');
  });

  it('.ssh / .aws / .gnupg 路径 → 整段截断为 <redacted>', () => {
    expect(redact('/Users/zoran/.ssh/id_rsa')).toBe('<redacted>');
    expect(redact('/home/alice/.aws/credentials')).toBe('<redacted>');
    expect(redact('/Users/zoran/.gnupg/secring.gpg')).toBe('<redacted>');
    // ~/形式也要处理
    expect(redact('~/.ssh/config')).toBe('<redacted>');
    // 上下文中
    expect(redact('cat /Users/zoran/.ssh/id_rsa now')).toBe('cat <redacted> now');
  });
});

describe('redact — A3 不误伤（反例）', () => {
  it('ymesh session id（UUID 形态）保留', () => {
    const sid = '019f5fe4-b127-7de2-b8f1-efa45bee24cb';
    expect(redact(sid)).toBe(sid);
    expect(redact(`session ${sid} ended`)).toBe(`session ${sid} ended`);
  });

  it('git commit hash 保留', () => {
    expect(redact('abc1234')).toBe('abc1234');
    expect(redact('commit sha: 0123456789abcdef0123456789abcdef01234567')).toBe('commit sha: 0123456789abcdef0123456789abcdef01234567');
  });

  it('IPv4 保留', () => {
    expect(redact('192.168.1.1')).toBe('192.168.1.1');
    expect(redact('connect to 10.0.0.42:8080')).toBe('connect to 10.0.0.42:8080');
  });

  it('公开 URL 保留', () => {
    expect(redact('https://example.com/path')).toBe('https://example.com/path');
    expect(redact('see https://github.com/GoYonderTogether/yondermesh')).toBe('see https://github.com/GoYonderTogether/yondermesh');
  });

  it('普通文本（无敏感模式）原样返回', () => {
    expect(redact('hello world')).toBe('hello world');
    expect(redact('ymesh retrospective --session abc --json')).toBe('ymesh retrospective --session abc --json');
  });
});

describe('redact — A1 / A4 永不抛错 + 纯函数', () => {
  it('空串输入安全', () => {
    expect(redact('')).toBe('');
  });

  it('非字符串输入兜底（调用方违约时也不崩）', () => {
    // redact 内部 try/catch 兜底；非字符串经 String() 转换或返回原值
    // 这里只验证不抛错
    expect(() => redact(undefined as unknown as string)).not.toThrow();
    expect(() => redact(null as unknown as string)).not.toThrow();
    expect(() => redact(123 as unknown as string)).not.toThrow();
  });

  it('超长输入不崩（10k 字符无 @，避免贪婪回溯）', () => {
    const big = 'a'.repeat(10_000);
    expect(redact(big).length).toBe(big.length);
  });

  it('纯函数：相同输入相同输出（无副作用）', () => {
    // pragma: allowlist secret
    const input = 'OPENAI_API_KEY=sk-1234567890abcdef /Users/zoran/.ssh/id_rsa';
    const a = redact(input);
    const b = redact(input);
    expect(a).toBe(b);
  });
});


describe('redact — §4 检查者对抗审查：5 个 API key 反例', () => {
  // 以下测试字符串均为虚构样例（长度仅 16 字符，低于真实密钥长度 24+），
  // 用于验证 redact 正则匹配能力，非真实凭证。
  it('Anthropic Claude API key 前缀 (sk-ant-api03-...) → <redacted>', () => {
    // pragma: allowlist secret
    expect(redact('sk-ant-api03-1234567890ab')).toBe('<redacted>');
  });
  it('Stripe secret key 前缀 (sk_live_...) → <redacted>', () => {
    // pragma: allowlist secret
    expect(redact('sk_live_1234567890ab')).toBe('<redacted>');
  });
  it('GitHub fine-grained PAT 前缀 (github_pat_...) → <redacted>', () => {
    // pragma: allowlist secret
    expect(redact('github_pat_1234567890abcdef')).toBe('<redacted>');
  });
  it('JWT token 前缀 (eyJ...) → <redacted>', () => {
    // pragma: allowlist secret
    const jwt = 'eyJ1234567890abcdef';
    const out = redact(`Authorization: Bearer ${jwt}`);
    expect(out).not.toContain('eyJ1234567890abcdef');
    expect(out).toContain('<redacted>');
  });
  it('AWS STS temporary access key (ASIA...) → <redacted>', () => {
    // pragma: allowlist secret
    expect(redact('ASIA1234567890ABCDEF')).toBe('<redacted>');
    // pragma: allowlist secret
    expect(redact('ASIA1234567890ABCDEF and AKIA0876543210FEDCBA')).toBe('<redacted> and <redacted>');
  });
});
