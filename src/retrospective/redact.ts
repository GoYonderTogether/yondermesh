/**
 * redact.ts — 纯函数脱敏（loop build-retrospective §A）
 *
 * 不变式（loop §3 行动约束）：
 *   - 纯函数：无 I/O、无状态、无外部依赖
 *   - 永不抛错：try/catch 兜底返回原串（A1）
 *   - 零 LLM：纯确定性正则替换（ARCHITECTURE §III.6 内核零 LLM）
 *
 * 必脱敏模式（A2）：
 *   1. env 变量名（*_TOKEN / *_KEY / *_SECRET / *_PASSWORD / *_API_KEY）+ 值
 *   2. .env 行（KEY=VALUE，VALUE 长度 ≥ 8 → 整段 <redacted>）
 *   3. API key 前缀（sk- / ghp_ / gho_ / ghs_ / ghr_ / AKIA / xoxb- / AIza + ≥16 字符）
 *   4. macOS / Linux home 绝对路径（/Users/<name>/ → ~/，/home/<name>/ → ~/）
 *   5. 邮箱（RFC 5322 简化版）
 *   6. .ssh / .aws / .gnupg 路径整段截断
 *
 * 不误伤（A3）：ymesh session id（UUID）/ git commit hash / IPv4 / 公开 URL
 *
 * 实现策略：按顺序应用一组正则替换；顺序精心排列以避免相互破坏。
 * 每条规则前均有「必备字符」快速短路，避免在最坏输入上发生灾难性回溯。
 */

/** 所有敏感片段统一替换为该占位符 */
const REDACTED = '<redacted>';

/**
 * 1. .ssh / .aws / .gnupg 绝对路径或 ~/ 形式 → 整段截断
 *
 * 必须在 home 路径替换（规则 4）之前跑，否则 /Users/zoran/.ssh/id_rsa
 * 会被先替换成 ~/.ssh/id_rsa，仍需在此截断。本规则一次性覆盖两种形态。
 */
const SSH_AWS_GNUPG_RE = /(?:\/(?:Users|home)\/[^/\s]+|~)\/\.(?:ssh|aws|gnupg)[^\s]*/g;

/**
 * 2. macOS / Linux home 绝对路径前缀 → ~/
 *
 *   /Users/<name>/          → ~/
 *   /home/<name>/           → ~/
 *
 * 仅匹配路径前缀（含尾随 /），保留后续路径。
 * 不会误伤 https://example.com（URL 不以 /Users/ 或 /home/ 开头）。
 */
const HOME_PATH_RE = /\/(?:Users|home)\/[^/\s]+\//g;

/**
 * 3. API key 前缀模式 → <redacted>
 *
 * 前缀（sk- / sk_ / ghp_ / gho_ / ghs_ / ghr_ / github_pat_ / AKIA / ASIA /
 * xoxb- / AIza / eyJ）后跟至少 16 个 [A-Za-z0-9_-] 字符。
 *
 * 覆盖：
 *   - sk- / sk_  ：OpenAI / Stripe (sk_live_/sk_test_)
 *   - ghp_ / gho_ / ghs_ / ghr_ ：GitHub classic PAT/OAuth/server/release
 *   - github_pat_：GitHub fine-grained PAT
 *   - AKIA       ：AWS access key
 *   - ASIA       ：AWS STS temporary access key
 *   - xoxb-      ：Slack bot token
 *   - AIza       ：Google API key
 *   - eyJ        ：JWT token（base64 头部 eyJ...）
 */
const API_KEY_RE = /(?:sk-|sk_|ghp_|gho_|ghs_|ghr_|github_pat_|AKIA|ASIA|xoxb-|AIza|eyJ)[A-Za-z0-9_\-]{16,}/g;

/**
 * 4. .env 行：整行 KEY=VALUE，VALUE 长度 ≥ 8 → 整行 <redacted>
 *
 * 行首允许空白；KEY 须大写蛇形；VALUE 至少 8 个非空白字符。
 * 多行模式下逐行匹配。
 */
const DOTENV_LINE_RE = /^[ \t]*[A-Z][A-Z0-9_]*=\S{8,}$/gm;

/**
 * 5. env 变量名 + 值（inline）：NAME 匹配 secret 模式 + 任意长度 VALUE
 *
 *   OPENAI_API_KEY=sk-xxx        → <redacted>
 *   set GITHUB_TOKEN=short       → set <redacted>
 *
 * VALUE 为直到下一个空白 / 引号 / 逗号 / 分号 / 括号的非空字符序列。
 */
const ENV_SECRET_INLINE_RE = /[A-Z][A-Z0-9_]*_(?:TOKEN|KEY|SECRET|PASSWORD|API_KEY)\s*=\s*[^\s;,)'"\\]+/g;

/**
 * 6. 邮箱（RFC 5322 简化版） → <redacted>
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 纯函数脱敏：输入字符串，输出脱敏后字符串。永不抛错（A1）。
 *
 * 任何内部异常都兜底返回原串（A1 铁律：调用方违约也绝不崩）。
 *
 * 性能：每条规则前先做 O(n) 的「必备字符」检查（indexOf），跳过不可能
 * 匹配的规则，避免在长输入上发生灾难性回溯。例如 EMAIL_RE 的
 * `[A-Za-z0-9._%+-]+` 是贪婪量词，在不含 `@` 的 1M 字符串上会触发
 * O(n²) 回溯——`indexOf('@') === -1` 直接跳过。
 */
export function redact(input: string): string {
  try {
    if (typeof input !== 'string') return input as unknown as string;
    if (input.length === 0) return input;

    let out = input;

    // 规则 6 → 规则 4：先截断 .ssh/.aws/.gnupg，再替换 home 前缀
    // 两者都要求 `/` 或 `~/.`；用 indexOf 短路
    if (out.indexOf('/.') !== -1 || out.indexOf('~/.') !== -1) {
      out = out.replace(SSH_AWS_GNUPG_RE, REDACTED);
    }
    if (out.indexOf('/Users/') !== -1 || out.indexOf('/home/') !== -1) {
      out = out.replace(HOME_PATH_RE, '~/');
    }

    // 规则 2：.env 行（KEY=VALUE，VALUE ≥ 8）→ 整行 <redacted>
    if (out.indexOf('=') !== -1) {
      out = out.replace(DOTENV_LINE_RE, REDACTED);
    }

    // 规则 1：env 变量名 secret 模式 + 值（inline，覆盖短值）
    if (out.indexOf('=') !== -1) {
      out = out.replace(ENV_SECRET_INLINE_RE, REDACTED);
    }

    // 规则 3：API key 前缀 + ≥16 字符
    // 检查任一前缀存在；indexOf 多次调用是 O(n) 总和，仍比回溯便宜
    if (
      out.indexOf('sk-') !== -1 || out.indexOf('sk_') !== -1 ||
      out.indexOf('ghp_') !== -1 || out.indexOf('gho_') !== -1 ||
      out.indexOf('ghs_') !== -1 || out.indexOf('ghr_') !== -1 ||
      out.indexOf('github_pat_') !== -1 ||
      out.indexOf('AKIA') !== -1 || out.indexOf('ASIA') !== -1 ||
      out.indexOf('xoxb-') !== -1 || out.indexOf('AIza') !== -1 ||
      out.indexOf('eyJ') !== -1
    ) {
      out = out.replace(API_KEY_RE, REDACTED);
    }

    // 规则 5：邮箱（必须有 @ 才可能匹配，避免贪婪量词灾难性回溯）
    if (out.indexOf('@') !== -1) {
      out = out.replace(EMAIL_RE, REDACTED);
    }

    return out;
  } catch {
    // 兜底：任何异常都返回原串，绝不抛错（A1）
    return input;
  }
}
