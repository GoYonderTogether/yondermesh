/**
 * ReplyAdapter — 回复接收适配层
 *
 * 架构分层（用户要求）：
 *   消息层 (MailboxCore) → 适配层-触发 (TriggerAdapter) → 各 CLI
 *                       ↘ 适配层-回复接收 (ReplyAdapter) ← 各 CLI
 *
 * 职责：从 TriggerResult 提取有用的 agent 回复文本，过滤掉日志 / 警告 /
 * 启动横幅 / ANSI 控制序列等噪声。ReplyAdapter 是纯函数式工具：不调外部
 * 进程，不读文件，只对 TriggerResult.response 做归一化与清洗。
 *
 * 回复来源（source）由 TriggerResult.channel 推导：
 *   - cli-spawn / stdin          → 'stdout'
 *   - http-api / ws-rpc          → 'api'
 *   - tmux / applescript         → 'tmux-capture'
 *   - 其他 / 未知                → 'stdout'（保守默认）
 *
 * 清洗规则（按顺序应用）：
 *   1. 去除 ANSI 转义序列
 *   2. 按 CLI 应用专属过滤（如 hermes 过滤 "Warning: Unknown toolsets:"）
 *   3. 过滤明显的日志/警告行（前缀 Warning: / WARN: / DEBUG: / INFO: 等）
 *   4. 折叠多余空行，去除首尾空白
 *
 * 设计权衡：
 *   - 不做"语义提取"（不调 LLM、不解析 markdown），保持纯文本清洗，可重入。
 *   - 专属过滤按 cli 字符串分支，新增 CLI 在这里加一条 case 即可。
 *   - 即使最终文本为空也返回空字符串（不抛错），由上层决定如何处理空回复。
 */

import type { TriggerChannel, TriggerResult } from './types.js';
import type { ReplyResult } from './types.js';

/** ReplyResult.source 的合法值集合 */
const REPLY_SOURCES: readonly ReplyResult['source'][] = ['stdout', 'api', 'file', 'tmux-capture'];

/** 把 TriggerChannel 映射到 ReplyResult.source */
function channelToSource(channel: TriggerChannel | undefined): ReplyResult['source'] {
  switch (channel) {
    case 'http-api':
    case 'ws-rpc':
      return 'api';
    case 'tmux':
    case 'applescript':
      return 'tmux-capture';
    case 'stdin':
    case 'cli-spawn':
    default:
      return 'stdout';
  }
}

/** 匹配 ANSI CSI / OSC 转义序列（粗略，覆盖绝大多数终端着色/光标控制） */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\u001b[=>]/g;

/** 明显的日志/警告前缀（不区分大小写） */
const LOG_PREFIX_RE = /^\s*(warning|warn|debug|info|error|fatal|trace|verbose)\s*[:\]]/i;

/** 明显的启动横幅行（claude / hermes / codex 等常见） */
const BANNER_RE = /^\s*(Welcome|Booting|Starting|Loaded|Initializing|Copyright)\b/i;

/**
 * 去除 ANSI 转义序列。
 * 单独抽出来便于测试。
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * 按 CLI 应用专属过滤。每个 case 返回过滤后的文本（行级处理）。
 *
 * 已知 CLI 噪声样本（实测）：
 *   - hermes: `Warning: Unknown toolsets: messaging`（重复多行）
 *   - claude: 启动时可能输出 `Tip:` 行
 *   - codex: 启动时可能输出 `model: ...` 行（已被 cli-spawn 抑制）
 *   - 其他 CLI 暂走通用过滤
 */
function applyCliSpecificFilter(text: string, cli: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    // hermes: 过滤 "Warning: Unknown toolsets:" 行
    if (cli === 'hermes' && /Warning:\s*Unknown toolsets?:/i.test(trimmed)) {
      continue;
    }
    // hermes: 过滤 "Warning: No X configured" 之类的启动警告
    if (cli === 'hermes' && /^Warning:\s/i.test(trimmed)) {
      continue;
    }

    // claude: 过滤 "Tip:" 行
    if ((cli === 'claude' || cli === 'claude-code') && /^Tip:\s/i.test(trimmed)) {
      continue;
    }

    out.push(line);
  }
  return out.join('\n');
}

/**
 * 通用行级过滤：去除日志前缀行与启动横幅行。
 */
function applyGenericFilter(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (LOG_PREFIX_RE.test(trimmed)) continue;
    if (BANNER_RE.test(trimmed)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** 折叠连续空行为最多一个，并去除首尾空白 */
function collapseBlankLines(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * ReplyAdapter — 回复接收适配器
 *
 * 无状态、无副作用。可直接 new，也可复用单例。
 *
 * 用法：
 *   const reply = new ReplyAdapter().extractReply(triggerResult, targetCli);
 */
export class ReplyAdapter {
  /**
   * 从 TriggerResult 提取清洗后的回复文本。
   *
   * @param result TriggerAdapter.trigger() 的返回值
   * @param cli    目标 CLI id（用于专属过滤）
   * @returns ReplyResult（text 可能为空字符串，绝不抛错）
   */
  extractReply(result: TriggerResult, cli: string): ReplyResult {
    const startMs = Date.now();
    const source = channelToSource(result.channel);

    // 触发失败时直接返回空文本（错误信息由上层从 result.error 取）
    const raw = result.delivered ? (result.response ?? '') : '';
    if (!raw) {
      return { text: '', source, latencyMs: Date.now() - startMs };
    }

    const cleaned = collapseBlankLines(
      applyGenericFilter(
        applyCliSpecificFilter(stripAnsi(raw), cli),
      ),
    );

    // 静态保证 source 字段合法（防御性，便于 JSON 序列化）
    const safeSource: ReplyResult['source'] = REPLY_SOURCES.includes(source) ? source : 'stdout';

    return {
      text: cleaned,
      source: safeSource,
      latencyMs: Date.now() - startMs,
    };
  }
}
