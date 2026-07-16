/**
 * Hermes 提示词注入
 *
 * Hermes 不支持 MCP 挂载（D3 ⚠️）也不支持 Skills（D4 ❌），但支持：
 *   - SOUL.md（D10 ✅）：always-on 全局指令文件，每次 session 启动自动注入
 *   - 启动参数：--source、--skills、--ignore-rules 等
 *   - Hooks：config.yaml 中声明的 shell-script hooks（SessionStart/UserPromptSubmit 等）
 *
 * 三种注入策略：
 *   1. always-on：写入 ~/.hermes/SOUL.md 的 ymesh awareness 块（持久，每次 session 生效）
 *   2. launch-time：通过环境变量或 prompt 前缀注入（临时，仅本次 session）
 *   3. hook：在 config.yaml 注册 SessionStart hook（事件驱动，session 启动时触发）
 *
 * SOUL.md 块使用 CONTEXT_BLOCK_START/END 标记，与 mount 系统的 always-on 策略一致，
 * 支持幂等更新与干净移除。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONTEXT_BLOCK_START, CONTEXT_BLOCK_END } from '../mount/types.js';

/** 默认 Hermes home 目录 */
const DEFAULT_HERMES_HOME = path.join(os.homedir(), '.hermes');

/** SOUL.md 文件名 */
const SOUL_MD_FILENAME = 'SOUL.md';

/** hooks 配置文件（Hermes 也支持独立 hooks 声明） */
const HOOKS_JSON_FILENAME = 'hooks.json';

/** ymesh awareness 块的默认内容 */
export const DEFAULT_AWARENESS_BLOCK = `# Yondermesh Awareness

You are running on a machine with yondermesh (ymesh) installed — a self-hosted
agent context bus that indexes sessions from all CLI agents (Claude Code, Codex,
Hermes, and more) into a unified local store.

Key implications for your operation:
- Your conversations are being indexed by ymesh. Other agents on this machine
  can query your session history via ymesh (read-only, for context sharing).
- You can hand off tasks to other agents: use "ymesh handoff <session_id>" to
  generate a transfer package, or ask the user to invoke it.
- Cross-session context is available: other agents' recent work is queryable
  via "ymesh sessions" or the ymesh MCP server.
- To check who else is working right now: "ymesh active".

You do NOT need to call ymesh yourself unless explicitly asked. Just be aware
that your session context may be shared with other agents on this machine for
continuity purposes.`;

/** 注入选项 */
export interface InjectOptions {
  /** Hermes home 目录，默认 ~/.hermes */
  hermesHome?: string;
  /** 自定义 awareness 块内容（默认用 DEFAULT_AWARENESS_BLOCK） */
  blockContent?: string;
}

/** hook 配置（SessionStart） */
export interface SessionStartHookConfig {
  /** hook 事件名 */
  event: 'SessionStart';
  /** 匹配模式（Hermes hook matcher） */
  matcher: string;
  /** 要执行的命令 */
  command: string;
  /** 超时秒 */
  timeout?: number;
}

/** 注入结果 */
export interface InjectResult {
  /** 注入策略 */
  strategy: 'always-on' | 'launch-time' | 'hook';
  /** 目标文件路径 */
  target: string;
  /** 是否成功 */
  success: boolean;
  /** 消息 */
  message: string;
}

/** Hermes home 目录解析 */
export function resolveHermesHome(hermesHome?: string): string {
  return hermesHome ?? DEFAULT_HERMES_HOME;
}

/**
 * 1. always-on 注入：写入 ~/.hermes/SOUL.md 的 ymesh awareness 块。
 *
 * 幂等：使用 CONTEXT_BLOCK_START/END 标记，已存在则替换块内容，不存在则追加。
 * 保留 SOUL.md 中的其他内容（用户自定义指令）。
 */
export function injectAlwaysOn(opts: InjectOptions = {}): InjectResult {
  const hermesHome = resolveHermesHome(opts.hermesHome);
  const soulPath = path.join(hermesHome, SOUL_MD_FILENAME);
  const block = opts.blockContent ?? DEFAULT_AWARENESS_BLOCK;
  const wrappedBlock = `${CONTEXT_BLOCK_START}\n${block}\n${CONTEXT_BLOCK_END}`;

  try {
    let existing = '';
    if (fs.existsSync(soulPath)) {
      existing = fs.readFileSync(soulPath, 'utf8');
    }

    // 已有 ymesh awareness 块 → 替换
    if (existing.includes(CONTEXT_BLOCK_START) && existing.includes(CONTEXT_BLOCK_END)) {
      const regex = new RegExp(
        `${escapeRegex(CONTEXT_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONTEXT_BLOCK_END)}`,
        'g',
      );
      const updated = existing.replace(regex, wrappedBlock);
      fs.writeFileSync(soulPath, updated, 'utf8');
      return {
        strategy: 'always-on',
        target: soulPath,
        success: true,
        message: 'SOUL.md 中 ymesh awareness 块已更新',
      };
    }

    // 无 ymesh 块 → 追加
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
    fs.writeFileSync(soulPath, existing + separator + wrappedBlock + '\n', 'utf8');
    return {
      strategy: 'always-on',
      target: soulPath,
      success: true,
      message: 'SOUL.md 已追加 ymesh awareness 块',
    };
  } catch (err) {
    return {
      strategy: 'always-on',
      target: soulPath,
      success: false,
      message: `写入 SOUL.md 失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 移除 ~/.hermes/SOUL.md 中的 ymesh awareness 块（幂等）。
 */
export function removeAlwaysOn(opts: { hermesHome?: string } = {}): InjectResult {
  const hermesHome = resolveHermesHome(opts.hermesHome);
  const soulPath = path.join(hermesHome, SOUL_MD_FILENAME);

  try {
    if (!fs.existsSync(soulPath)) {
      return {
        strategy: 'always-on',
        target: soulPath,
        success: true,
        message: 'SOUL.md 不存在，无需移除',
      };
    }
    const existing = fs.readFileSync(soulPath, 'utf8');
    if (!existing.includes(CONTEXT_BLOCK_START)) {
      return {
        strategy: 'always-on',
        target: soulPath,
        success: true,
        message: 'SOUL.md 中无 ymesh awareness 块',
      };
    }
    const regex = new RegExp(
      `${escapeRegex(CONTEXT_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONTEXT_BLOCK_END)}\\n*`,
      'g',
    );
    const updated = existing.replace(regex, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    fs.writeFileSync(soulPath, updated, 'utf8');
    return {
      strategy: 'always-on',
      target: soulPath,
      success: true,
      message: 'SOUL.md 中 ymesh awareness 块已移除',
    };
  } catch (err) {
    return {
      strategy: 'always-on',
      target: soulPath,
      success: false,
      message: `移除 SOUL.md 块失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 2. launch-time 注入：构建注入 awareness 的 prompt 前缀。
 *
 * Hermes 无 --system 参数，但可通过 prompt 前缀或环境变量注入。
 * 返回的前缀可拼接到用户 prompt 前面，使本次 session 感知 ymesh。
 */
export function buildLaunchPrefix(): string {
  return `[Context: yondermesh (ymesh) is installed on this machine. Your session is being indexed. Other agents can query your history. Use "ymesh handoff <id>" for task transfer.]\n\n`;
}

/**
 * 2. launch-time 注入：构建注入 awareness 的环境变量。
 *
 * 通过 YONDERMESH_AWARENESS 环境变量传递，Hermes 可读取（需 Hermes 侧配合）。
 * 同时设置 YONDERMESH_HOME 使 ymesh CLI 可被定位。
 */
export function buildLaunchEnv(): Record<string, string> {
  return {
    YONDERMESH_AWARENESS: '1',
    YONDERMESH_HOME: path.join(os.homedir(), '.yondermesh'),
  };
}

/**
 * 3. hook 注入：在 ~/.hermes/hooks.json 注册 SessionStart hook。
 *
 * Hermes 支持在 config.yaml 声明 shell-script hooks，也支持独立 hooks.json。
 * SessionStart hook 在每次 session 启动时触发，可注入 ymesh 上下文。
 *
 * 注意：Hermes 的 hooks 主要通过 config.yaml 的 hooks: 段配置（shell-script hooks）。
 * 此函数写入一个独立的 hooks.json 作为声明式配置参考，并返回应在 config.yaml 中
 * 添加的 YAML 片段（避免直接修改用户的 config.yaml）。
 */
export function installSessionStartHook(opts: {
  hermesHome?: string;
  command?: string;
} = {}): { hooksJson: InjectResult; configYamlSnippet: string } {
  const hermesHome = resolveHermesHome(opts.hermesHome);
  const hooksJsonPath = path.join(hermesHome, HOOKS_JSON_FILENAME);

  // 默认 hook 命令：echo ymesh awareness 到 stderr（Hermes 可捕获 hook stdout 注入上下文）
  const defaultCommand = opts.command ?? 'echo "[ymesh] yondermesh is tracking this session. Use ymesh sessions/handoff for cross-agent context."';

  const hookConfig: SessionStartHookConfig = {
    event: 'SessionStart',
    matcher: '*',
    command: defaultCommand,
    timeout: 5,
  };

  let hooksArray: SessionStartHookConfig[] = [];
  // 读取已有 hooks.json（如有）
  if (fs.existsSync(hooksJsonPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      if (Array.isArray(existing)) {
        hooksArray = existing as SessionStartHookConfig[];
      } else if (existing && typeof existing === 'object') {
        hooksArray = (existing as { hooks?: SessionStartHookConfig[] }).hooks ?? [];
      }
    } catch {
      // 损坏则覆盖
    }
  }

  // 幂等：移除已存在的 ymesh SessionStart hook
  hooksArray = hooksArray.filter(
    (h) => !(h.event === 'SessionStart' && h.command.includes('ymesh')),
  );
  hooksArray.push(hookConfig);

  let success = false;
  let message = '';
  try {
    fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: hooksArray }, null, 2) + '\n', 'utf8');
    success = true;
    message = 'hooks.json 已注册 ymesh SessionStart hook';
  } catch (err) {
    message = `写入 hooks.json 失败: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 生成 config.yaml 片段（用户需手动添加到 config.yaml 的 hooks: 段）
  const configYamlSnippet = `# ymesh SessionStart hook — 添加到 config.yaml 的 hooks: 段
hooks:
  - event: SessionStart
    matcher: "*"
    command: '${defaultCommand}'
    timeout: 5`;

  return {
    hooksJson: {
      strategy: 'hook',
      target: hooksJsonPath,
      success,
      message,
    },
    configYamlSnippet,
  };
}

/**
 * 移除 hooks.json 中的 ymesh SessionStart hook。
 */
export function removeSessionStartHook(opts: { hermesHome?: string } = {}): InjectResult {
  const hermesHome = resolveHermesHome(opts.hermesHome);
  const hooksJsonPath = path.join(hermesHome, HOOKS_JSON_FILENAME);

  try {
    if (!fs.existsSync(hooksJsonPath)) {
      return {
        strategy: 'hook',
        target: hooksJsonPath,
        success: true,
        message: 'hooks.json 不存在，无需移除',
      };
    }
    const existing = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    let hooksArray: SessionStartHookConfig[] = [];
    if (Array.isArray(existing)) {
      hooksArray = existing as SessionStartHookConfig[];
    } else if (existing && typeof existing === 'object') {
      hooksArray = (existing as { hooks?: SessionStartHookConfig[] }).hooks ?? [];
    }
    const filtered = hooksArray.filter(
      (h) => !(h.event === 'SessionStart' && h.command.includes('ymesh')),
    );
    if (filtered.length === 0) {
      fs.writeFileSync(hooksJsonPath, '{}\n', 'utf8');
    } else {
      fs.writeFileSync(hooksJsonPath, JSON.stringify({ hooks: filtered }, null, 2) + '\n', 'utf8');
    }
    return {
      strategy: 'hook',
      target: hooksJsonPath,
      success: true,
      message: 'hooks.json 中 ymesh SessionStart hook 已移除',
    };
  } catch (err) {
    return {
      strategy: 'hook',
      target: hooksJsonPath,
      success: false,
      message: `移除 hook 失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 执行全部注入策略（always-on + hook）。
 * launch-time 注入由调用方在启动 session 时使用 buildLaunchPrefix/buildLaunchEnv。
 */
export function injectAll(opts: InjectOptions = {}): InjectResult[] {
  const results: InjectResult[] = [];
  results.push(injectAlwaysOn(opts));
  const hookResult = installSessionStartHook(opts);
  results.push(hookResult.hooksJson);
  return results;
}

/**
 * 移除全部注入（always-on + hook）。
 */
export function removeAll(opts: { hermesHome?: string } = {}): InjectResult[] {
  return [removeAlwaysOn(opts), removeSessionStartHook(opts)];
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
