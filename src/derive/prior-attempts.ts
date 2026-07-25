/**
 * 「这坑别的 agent 踩过没」洞察 — L4 派生层旗舰（product-vision US-7）
 *
 * 完全 deterministic，零 LLM（ARCHITECTURE §III.6「内核零 LLM」）。
 * v0 直接基于 session messages 做确定性匹配，**不依赖独立的决策提取模块**
 * （那是后续 loop）。
 *
 * 匹配口径（默认，可配）：
 *   1. 报错/失败标记正则（DEFAULT_FAILURE_PATTERNS）—— query 与 message 同时命中
 *      同一报错形态视为强信号。
 *   2. 显著 token Jaccard 重叠 —— 任务/报错关键词重叠度。
 *   3. 同项目加权（projectPath 命中）/ 同 cwd 加权。
 *
 * 对应 roadmap T2.4.5。
 *
 * 误匹配已知口径（v0 限制，后续 loop 改进）：
 *   - 仅靠 token 重叠可能命中「同主题但不同坑」的 session；minScore 与
 *     failure-pattern 强信号加权用以过滤，但无法完全消除。
 *   - 仅匹配 message 文本，不解析调用栈结构；同一行报错在不同语言/库下
 *     可能含义不同。
 */

import type { MessageRole } from '../store/types.js';

/** 单条消息的最小输入形态（与 SessionMessage 子集兼容） */
export interface PriorAttemptMessage {
  role: MessageRole;
  content: string;
  timestamp?: number;
}

/** 待检索的 session 输入项 */
export interface PriorAttemptSession {
  id: string;
  source?: string;
  cwd?: string | null;
  projectPath?: string | null;
  startedAt?: number | null;
  lastSeenAt?: number;
  /** 该 session 的全部消息（按 seq 升序）；空数组也允许 */
  messages: ReadonlyArray<PriorAttemptMessage>;
}

/** 查询输入 */
export interface PriorAttemptQuery {
  /** 用户的任务描述或报错文本（必填） */
  query: string;
  /** 调用方的项目路径；命中同 projectPath 时加权。可选 */
  projectPath?: string | null;
  /** 调用方的 cwd；命中同 cwd 时加权（弱于 projectPath）。可选 */
  cwd?: string | null;
  /** 返回结果上限；默认 DEFAULT_PRIOR_ATTEMPTS_LIMIT（5） */
  limit?: number;
  /** 最低分数阈值（0-1），低于此不返回；默认 DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE（0.1） */
  minScore?: number;
}

/** 命中原因标签 */
export type PriorAttemptReason =
  | 'failure_pattern' // 报错/失败标记正则命中（强信号）
  | 'token_overlap' // 显著 token Jaccard 重叠
  | 'same_project' // 同 projectPath 加权
  | 'same_cwd'; // 同 cwd 加权

/** 单条 prior-attempt 结果 */
export interface PriorAttemptResult {
  sessionId: string;
  source?: string;
  projectPath?: string | null;
  cwd?: string | null;
  /** 相关性分数 0-1（已归一化） */
  score: number;
  /** 命中的原因集合（至少一个） */
  reasons: PriorAttemptReason[];
  /** 命中的消息内容片段（前 N 字符） */
  matchedSnippet: string;
  /** 命中的消息在 session.messages 中的索引；无消息时为 -1 */
  matchedMessageIndex: number;
  /** 最后一条 assistant 消息内容预览（作为「结论」）；无 assistant 消息时为 null */
  conclusion: string | null;
  /** session 消息总数 */
  messageCount: number;
}

// ---------------------------------------------------------------------------
// 默认常量（可配参数集中在此，便于下游覆盖）
// ---------------------------------------------------------------------------

/** 默认返回结果上限 */
export const DEFAULT_PRIOR_ATTEMPTS_LIMIT = 5;

/** 默认最低分数阈值 */
export const DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE = 0.1;

/**
 * 报错/失败标记正则表（强信号）。
 *
 * 设计原则：宁可漏召不要硬凑——只匹配「明确失败/报错」的形态。
 * - 命名形如 `XxxError` / `XxxException` 的类型名
 * - 显式失败关键字（大小写不敏感）
 * - 常见报错前缀（`Error:`, `fatal:`, `panic:`）
 *
 * 每条正则匹配到的「第一个 group 或整段匹配」作为失败指纹，
 * 用于 query↔message 同指纹命中判定。
 */
export const DEFAULT_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  // 命名错误类型：TypeError / ReferenceError / SyntaxError / CustomError ...
  /([A-Z][a-zA-Z0-9_]*(?:Error|Exception))\b/,
  // 显式 "Error: <something>" / "fatal: <something>" / "panic: <something>"
  /\b(?:Error|Fatal|Panic|FATAL|PANIC)\s*:\s*([^\n]{1,120})/i,
  // Node / JS 风格 stack 头："    at foo (file:line:col)"
  /\bat\s+([^\s(]+\s*\([^)]+\))/,
  // shell/退出码风格：exited with code N / exit N
  /\b(?:exited with code|exit code|exit)\s+(\d+)\b/i,
  // 通用失败动词短语
  /\b(?:failed to|unable to|cannot|couldn't|can't)\s+([a-z\s]{1,60})/i,
];

/** 同项目命中加权（叠加到原始分） */
export const DEFAULT_SAME_PROJECT_BOOST = 0.2;

/** 同 cwd 命中加权（叠加到原始分） */
export const DEFAULT_SAME_CWD_BOOST = 0.1;

/** failure_pattern 强信号权重（在原始分中占比） */
export const DEFAULT_FAILURE_PATTERN_WEIGHT = 0.6;

/** token_overlap 信号权重（在原始分中占比） */
export const DEFAULT_TOKEN_OVERLAP_WEIGHT = 0.4;

/** 截断片段长度（前 N 字符） */
export const SNIPPET_LENGTH = 200;

/** 结论（最后一条 assistant 消息）预览长度 */
export const CONCLUSION_LENGTH = 300;

/** 停用词表（短词不参与 token 计算） */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'was',
  'were', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one',
  'our', 'out', 'day', 'get', 'how', 'man', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she',
  'too', 'use',
  'a', 'an', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'be', 'as', 'or',
  'by', 'do', 'if', 'we', 'he', 'my', 'up', 'so', 'no',
]);

/** 最小 token 长度（短于此的不参与） */
const MIN_TOKEN_LENGTH = 4;

// ---------------------------------------------------------------------------
// 纯函数实现
// ---------------------------------------------------------------------------

/**
 * 纯函数：从历史 sessions 中查找「别的 agent 踩过没」的同类失败/尝试。
 *
 * @param query 查询输入（query 字符串 + 可选 projectPath / cwd / limit / minScore）
 * @param sessions 待检索的 session 列表
 * @returns 命中的 prior attempts，按 score 降序排列，最多 query.limit 条
 */
export function findPriorAttempts(
  query: PriorAttemptQuery,
  sessions: ReadonlyArray<PriorAttemptSession>,
): PriorAttemptResult[] {
  const limit = query.limit ?? DEFAULT_PRIOR_ATTEMPTS_LIMIT;
  const minScore = query.minScore ?? DEFAULT_PRIOR_ATTEMPTS_MIN_SCORE;

  // 空 query：返回空数组而非崩（loop §4 验收门）
  const queryText = query.query?.trim() ?? '';
  if (!queryText) return [];

  const queryTokens = extractTokens(queryText);
  const queryFailures = extractFailureFingerprints(queryText);

  const candidates: PriorAttemptResult[] = [];

  for (const session of sessions) {
    if (!session.messages || session.messages.length === 0) continue;

    let bestScore = 0;
    let bestReasons: PriorAttemptReason[] = [];
    let bestSnippet = '';
    let bestIdx = -1;
    let hasTokenOverlap = false;

    for (let i = 0; i < session.messages.length; i++) {
      const msg = session.messages[i]!;
      const content = msg.content ?? '';

      // 1. failure_pattern 强信号：query 与 message 同时命中同一指纹
      let msgScore = 0;
      const msgReasons: PriorAttemptReason[] = [];

      if (queryFailures.length > 0) {
        const msgFailures = extractFailureFingerprints(content);
        if (msgFailures.length > 0) {
          const overlap = intersect(queryFailures, msgFailures);
          if (overlap.length > 0) {
            msgScore += DEFAULT_FAILURE_PATTERN_WEIGHT;
            msgReasons.push('failure_pattern');
          }
        }
      }

      // 2. token_overlap：Jaccard 重叠度
      if (queryTokens.size > 0) {
        const msgTokens = extractTokens(content);
        if (msgTokens.size > 0) {
          const j = jaccard(queryTokens, msgTokens);
          if (j > 0) {
            msgScore += j * DEFAULT_TOKEN_OVERLAP_WEIGHT;
            msgReasons.push('token_overlap');
            hasTokenOverlap = true;
          }
        }
      }

      if (msgScore > bestScore) {
        bestScore = msgScore;
        bestReasons = [...new Set(msgReasons)]; // 去重
        bestSnippet = content.slice(0, SNIPPET_LENGTH);
        bestIdx = i;
      }
    }

    if (bestScore <= 0) continue; // 无任何命中信号

    // 3. 同项目 / 同 cwd 加权（叠加，但归一化到 [0, 1])
    if (
      query.projectPath &&
      session.projectPath &&
      query.projectPath === session.projectPath
    ) {
      bestScore += DEFAULT_SAME_PROJECT_BOOST;
      bestReasons.push('same_project');
    }
    if (
      query.cwd &&
      session.cwd &&
      query.cwd === session.cwd
    ) {
      bestScore += DEFAULT_SAME_CWD_BOOST;
      bestReasons.push('same_cwd');
    }

    // 归一化到 [0, 1]（最大可能分 = FAILURE_PATTERN_WEIGHT + TOKEN_OVERLAP_WEIGHT
    // + SAME_PROJECT_BOOST + SAME_CWD_BOOST = 1.3）
    const normalized = clamp01(bestScore / 1.3);

    if (normalized < minScore) continue;
    // 防御：若无 failure_pattern 也无 token_overlap（仅 project/cwd 命中），
    // 不应返回——这会硬凑「同项目但完全无关」的 session。
    if (!bestReasons.includes('failure_pattern') && !hasTokenOverlap) {
      continue;
    }

    candidates.push({
      sessionId: session.id,
      source: session.source,
      projectPath: session.projectPath,
      cwd: session.cwd,
      score: round3(normalized),
      reasons: bestReasons,
      matchedSnippet: bestSnippet,
      matchedMessageIndex: bestIdx,
      conclusion: extractConclusion(session.messages),
      messageCount: session.messages.length,
    });
  }

  // 按 score 降序；同分按 sessionId 升序保证稳定排序
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  return candidates.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 提取显著 token（去停用词、去短词、小写化、去重） */
function extractTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // 拆词：非字母数字字符为分隔
  const words = text.toLowerCase().split(/[^a-z0-9_]+/i);
  for (const w of words) {
    if (w.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(w)) continue;
    // 全数字 token 不参与（避免把端口号、行号当信号）
    if (/^\d+$/.test(w)) continue;
    tokens.add(w);
  }
  return tokens;
}

/**
 * 提取「失败指纹」——每个失败模式匹配到的字符串片段。
 * 同指纹命中 = query 与 message 都有同一段失败标记。
 */
function extractFailureFingerprints(text: string): string[] {
  const fps: string[] = [];
  for (const re of DEFAULT_FAILURE_PATTERNS) {
    // 全局匹配所有出现
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      // 优先取第一个 group，否则取整段匹配；归一化为小写
      const fp = (m[1] ?? m[0]).trim().toLowerCase();
      if (fp) fps.push(fp);
      // 防止零宽匹配死循环
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++;
    }
  }
  return fps;
}

/** 集合交集大小 */
function intersect<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): T[] {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

/** Jaccard 相似度：|A∩B| / |A∪B| */
function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 取最后一条 assistant 消息内容预览（作为「结论」） */
function extractConclusion(messages: ReadonlyArray<PriorAttemptMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.content?.trim()) {
      return m.content.slice(0, CONCLUSION_LENGTH);
    }
  }
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function round3(n: number): number {
  return Number(n.toFixed(3));
}
