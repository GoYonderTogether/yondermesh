/**
 * TriggerAdapter — 主适配器，统一入口
 *
 * 根据 CLI 和模式分发到对应触发通道：
 *   1. 优先调 wrapper.inject()（Wave 1 已为所有 CLI 实现）
 *   2. new 模式调 wrapper.launch()
 *   3. IDE 类 CLI 用 tmux send-keys
 *   4. 全部失败返回 delivered: false
 */

import { spawn, spawnSync } from 'node:child_process';

import type { TriggerRequest, TriggerResult, TriggerChannel, CliTriggerCapability, TriggerMode } from './types.js';
import { loadWrapper as regLoadWrapper, getAdapter } from '../adapters/registry.js';

// ---------------------------------------------------------------------------
// CLI 分类
// ---------------------------------------------------------------------------

/** IDE 类 CLI（不能 CLI spawn，需 tmux/applescript） */
const IDE_CLIS = new Set(['trae-ide', 'windsurf', 'cursor-ide', 'chatgpt']);

/** 有 HTTP API 的 CLI */
const HTTP_API_CLIS = new Set(['opencode', 'qwen', 'openhands']);

/** 有 WS/RPC 的 CLI（含 copilot：异步 spawn + stdin 模式，按 WS-RPC 通道处理 new 模式） */
const WS_RPC_CLIS = new Set(['kimi', 'openclaw', 'pi', 'copilot']);

/** CLI 二进制名映射 */
const BIN_MAP: Record<string, string> = {
  'claude-code': 'claude',
  'claude': 'claude',
  'codex': 'codex',
  'hermes': 'hermes',
  'gemini': 'gemini',
  'goose': 'goose',
  'aider': 'aider',
  'amp': 'amp',
  'factory': 'droid',
  'vibe': 'vibe',
  'codebuddy': 'cbc',
  'trae-cli': 'trae-cli',
  'trae-ide': 'trae',
  'opencode': 'opencode',
  'qwen': 'qwen',
  'openhands': 'openhands',
  'kimi': 'kimi',
  'openclaw': 'openclaw',
  'pi': 'pi',
  'copilot': 'copilot',
  'crush': 'crush',
  'cline': 'cline',
  'continue': 'cn',
  'antigravity': 'agy',
  'windsurf': 'windsurf',
  'cursor-ide': 'cursor',
  'chatgpt': 'chatgpt',
};

/** IDE 类 CLI 对应的 macOS 应用名（用于 `open -a` 与 AppleScript） */
const IDE_APP_NAME: Record<string, string> = {
  'trae-ide': 'Trae',
  'windsurf': 'Windsurf',
  'cursor-ide': 'Cursor',
  'chatgpt': 'ChatGPT',
};

/**
 * CLI launch 命令构造器：每个 CLI 的 new session 命令格式
 *
 * 备注：以下 CLI 命令格式正确，但需要外部认证/配置才能拿到回复：
 *   - factory (droid): 需要 FACTORY_API_KEY 或 /login
 *   - crush: 需要先 `crush` 交互式配置 provider
 *   - continue (cn): 需要 ~/.continue/config.json 非 null
 *   - qwen: 需要 --auth-type + 对应 API key
 *   - gemini: 需要 Google 账号认证（free-tier 已弃用）
 *   - cline: 需要 Cline 账号认证
 *   - aider: 需要 LLM API key (--model 或 env)
 *   - amp: 需要登录且有 credits
 *
 * trae-cli 已移除：强制要求 --config-file 指向 ~/.trae-cli/config.yaml，
 * 该文件不存在，且 -p/-m/--model-base-url/-k 无法绕过此要求。
 */
const CLI_LAUNCH_COMMANDS: Record<string, (prompt: string, opts?: { model?: string; cwd?: string }) => { bin: string; args: string[]; env?: Record<string, string> }> = {
  hermes: (p, o) => ({ bin: 'hermes', args: ['chat', '-q', p, '-Q', ...(o?.model ? ['-m', o.model] : [])] }),
  gemini: (p, o) => ({ bin: 'gemini', args: ['-p', p, ...(o?.model ? ['-m', o.model] : [])], env: { TERM: 'xterm-256color' } }),
  goose: (p) => ({ bin: 'goose', args: ['run', '-s', '--text', '--no-tty', p] }),
  codex: (p, o) => ({ bin: 'codex', args: ['exec', p, ...(o?.model ? ['-m', o.model] : [])], env: { TERM: 'xterm-256color' } }),
  claude: (p, o) => ({ bin: 'claude', args: ['-p', p, ...(o?.model ? ['--model', o.model] : [])] }),
  aider: (p, o) => ({ bin: 'aider', args: ['--message', p, '--yes-always', '--no-auto-commits', '--no-pretty', ...(o?.model ? ['--model', o.model] : [])], env: { TERM: 'xterm-256color' } }),
  amp: (p) => ({ bin: 'amp', args: ['-x', p] }),
  factory: (p, o) => ({ bin: 'droid', args: ['exec', p, ...(o?.cwd ? ['--cwd', o.cwd] : [])] }),
  vibe: (p, o) => ({ bin: 'vibe', args: ['-p', p, ...(o?.cwd ? ['--workdir', o.cwd] : [])] }),
  codebuddy: (p, o) => ({ bin: 'cbc', args: ['exec', p, ...(o?.cwd ? ['--cwd', o.cwd] : [])] }),
  crush: (p) => ({ bin: 'crush', args: ['run', p] }),
  cline: (p) => ({ bin: 'cline', args: [p] }),
  continue: (p) => ({ bin: 'cn', args: ['-p', p] }),
  antigravity: (p) => ({ bin: 'agy', args: [p], env: { TERM: 'xterm-256color' } }),
  qwen: (p, o) => ({ bin: 'qwen', args: ['-p', p, '-o', 'text', ...(o?.model ? ['-m', o.model] : [])] }),
};

/** 检查 CLI 是否安装 */
function isInstalled(cli: string): boolean {
  const bin = BIN_MAP[cli];
  if (!bin) return false;
  try {
    const r = spawnSync('which', [bin], { encoding: 'utf-8', timeout: 2000 });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** 检查 IDE 类 CLI 是否安装（看 .app bundle 或二进制） */
function isIdeInstalled(cli: string): boolean {
  const appName = IDE_APP_NAME[cli];
  if (process.platform === 'darwin' && appName) {
    const paths = [
      `/Applications/${appName}.app`,
      `${process.env.HOME ?? ''}/Applications/${appName}.app`,
    ];
    for (const p of paths) {
      if (!p) continue;
      try {
        const r = spawnSync('test', ['-d', p], { timeout: 1000 });
        if (r.status === 0) return true;
      } catch {
        // ignore
      }
    }
  }
  // fallback：看二进制
  return isInstalled(cli);
}

// ---------------------------------------------------------------------------
// Wrapper 动态加载（复用 Wave 1 的 inject 实现）
// ---------------------------------------------------------------------------

/** 动态加载 wrapper 模块并调用 inject */
async function callWrapperInject(cli: string, sessionId: string, message: string): Promise<{ response: string; exitCode: number } | null> {
  try {
    // 经注册表加载 wrapper 模块（registry 内部已 try/catch，未注册返回 null）
    const mod = await regLoadWrapper(cli) as Record<string, unknown> | null;
    if (!mod) return null;

    // 尝试找 inject 函数（函数式导出）
    if (typeof mod.inject === 'function') {
      const raw = await (mod.inject as (sid: string, msg: string) => unknown)(sessionId, message);
      return normalizeResult(raw);
    }

    // 尝试找 Controller/Wrapper 类，实例化后调 inject
    for (const key of Object.keys(mod)) {
      if (key.endsWith('Controller') || key.endsWith('Wrapper') || key.endsWith('CliWrapper') || key.endsWith('ApiWrapper')) {
        const Cls = mod[key];
        if (typeof Cls === 'function') {
          const instance = new (Cls as new () => { inject?: (sid: string, msg: string) => unknown })();
          if (instance && typeof instance.inject === 'function') {
            const raw = await instance.inject(sessionId, message);
            return normalizeResult(raw);
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** 动态加载 wrapper 并调 launch（new 模式） */
async function callWrapperLaunch(cli: string, prompt: string, opts: { model?: string; cwd?: string }): Promise<{ response: string; exitCode: number; sessionId?: string } | null> {
  try {
    // 只对 cli-spawn 类 CLI 尝试 wrapper launch（与原 moduleMap 的 13 个 CLI 一致）
    const adapter = getAdapter(cli);
    if (!adapter?.wrapperLoader || !adapter.channels.includes('cli-spawn')) return null;

    const mod = await regLoadWrapper(cli) as Record<string, unknown> | null;
    if (!mod) return null;

    if (typeof mod.launch === 'function') {
      const raw = await (mod.launch as (p: string, o: Record<string, unknown>) => unknown)(prompt, opts);
      return normalizeLaunchResult(raw);
    }

    for (const key of Object.keys(mod)) {
      if (key.endsWith('Controller') || key.endsWith('Wrapper') || key.endsWith('CliWrapper') || key.endsWith('ApiWrapper')) {
        const Cls = mod[key];
        if (typeof Cls === 'function') {
          const instance = new (Cls as new () => { launch?: (p: string, o: Record<string, unknown>) => unknown })();
          if (instance && typeof instance.launch === 'function') {
            const raw = await instance.launch(prompt, opts);
            return normalizeLaunchResult(raw);
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** 归一化 inject 返回值 */
function normalizeResult(raw: unknown): { response: string; exitCode: number } {
  if (raw == null) return { response: '', exitCode: 0 };
  if (typeof raw === 'string') return { response: raw, exitCode: 0 };
  if (typeof raw !== 'object') return { response: String(raw), exitCode: 0 };
  const r = raw as Record<string, unknown>;
  const response =
    (typeof r.response === 'string' && r.response) ||
    (typeof r.stdout === 'string' && r.stdout) ||
    (typeof r.data === 'string' && r.data) ||
    '';
  const exitCode =
    typeof r.exitCode === 'number' ? r.exitCode :
    r.ok === false ? 1 : 0;
  return { response, exitCode };
}

/** 归一化 launch 返回值 */
function normalizeLaunchResult(raw: unknown): { response: string; exitCode: number; sessionId?: string } {
  if (raw == null || typeof raw !== 'object') {
    return { response: String(raw ?? ''), exitCode: 0 };
  }
  const r = raw as Record<string, unknown>;
  const response =
    (typeof r.response === 'string' && r.response) ||
    (typeof r.stdout === 'string' && r.stdout) ||
    '';
  const exitCode =
    typeof r.exitCode === 'number' ? r.exitCode :
    r.ok === false ? 1 : 0;
  const sessionId =
    (typeof r.sessionId === 'string' && r.sessionId) ||
    (typeof r.id === 'string' && r.id) ||
    undefined;
  return { response, exitCode, sessionId };
}

// ---------------------------------------------------------------------------
// tmux 通道（IDE 类 CLI）
// ---------------------------------------------------------------------------

/** 在所有 tmux pane 中找目标 IDE：匹配 pane_current_command / pane_title / pane_current_path */
function findIdeTmuxPane(ideBin: string, appName: string): string | null {
  const fmt = '#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_title}\t#{pane_current_path}';
  let listRes: { status: number | null; stdout: string };
  try {
    const r = spawnSync('tmux', ['list-panes', '-a', '-F', fmt], { encoding: 'utf-8', timeout: 3000 });
    listRes = { status: r.status, stdout: r.stdout ?? '' };
  } catch {
    return null;
  }
  if (listRes.status !== 0 || !listRes.stdout.trim()) return null;

  const binLower = ideBin.toLowerCase();
  const appLower = appName.toLowerCase();
  for (const line of listRes.stdout.trim().split('\n')) {
    const [pane, cmd, title, path] = line.split('\t');
    const cmdLower = (cmd ?? '').toLowerCase();
    const titleLower = (title ?? '').toLowerCase();
    const pathLower = (path ?? '').toLowerCase();
    if (
      (cmdLower && cmdLower.includes(binLower)) ||
      (titleLower && (titleLower.includes(appLower) || titleLower.includes(binLower))) ||
      (pathLower && (pathLower.includes(binLower) || pathLower.includes(appLower)))
    ) {
      return pane ?? null;
    }
  }
  return null;
}

/** 从 capture-pane 结果里剥离发送前的内容与发送的消息本身，只返回新增回复 */
function extractNewContent(fullCapture: string, preCapture: string, sentMessage: string): string {
  let content = fullCapture;
  // 1) 优先按发送前快照切片
  if (preCapture && content.startsWith(preCapture)) {
    content = content.slice(preCapture.length);
  } else if (preCapture) {
    // 2) 找最后一次出现 preCapture 的位置
    const idx = content.lastIndexOf(preCapture);
    if (idx >= 0) content = content.slice(idx + preCapture.length);
  }
  // 3) 剥离发送的消息本身（可能被 echo 回显）
  if (sentMessage) {
    const sentIdx = content.lastIndexOf(sentMessage);
    if (sentIdx >= 0) {
      content = content.slice(sentIdx + sentMessage.length);
    } else {
      // 多行消息：用第一行做兜底
      const firstLine = sentMessage.split('\n')[0];
      if (firstLine) {
        const flIdx = content.lastIndexOf(firstLine);
        if (flIdx >= 0) content = content.slice(flIdx + firstLine.length);
      }
    }
  }
  return content.trim();
}

/** 通过 tmux send-keys 向 IDE 的 chat 面板注入消息 */
function tmuxTrigger(req: TriggerRequest): TriggerResult {
  const start = Date.now();
  const ideBin = BIN_MAP[req.cli] ?? req.cli;
  const appName = IDE_APP_NAME[req.cli] ?? req.cli;

  // tmux 是否安装
  try {
    const which = spawnSync('which', ['tmux'], { encoding: 'utf-8', timeout: 1000 });
    if (which.status !== 0) {
      return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: 'tmux 未安装' };
    }
  } catch {
    return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: 'tmux 检测失败' };
  }

  // tmux 是否有运行中的 session
  try {
    const ls = spawnSync('tmux', ['list-sessions'], { encoding: 'utf-8', timeout: 2000 });
    if (ls.status !== 0 || !ls.stdout.trim()) {
      return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: '没有运行中的 tmux session' };
    }
  } catch {
    return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: 'tmux 未运行' };
  }

  // 找 IDE pane
  const targetPane = findIdeTmuxPane(ideBin, appName);
  if (!targetPane) {
    return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: `没有找到运行 ${ideBin}/${appName} 的 tmux pane` };
  }

  // 抓取发送前快照
  let preCapture = '';
  try {
    const pre = spawnSync('tmux', ['capture-pane', '-t', targetPane, '-p', '-S', '-100'], { encoding: 'utf-8', timeout: 3000 });
    preCapture = pre.status === 0 ? (pre.stdout ?? '') : '';
  } catch {
    // ignore
  }

  // 发送消息（-l 字面量，避免特殊字符被解释）+ Enter
  try {
    spawnSync('tmux', ['send-keys', '-t', targetPane, '-l', req.message], { timeout: 5000 });
    spawnSync('tmux', ['send-keys', '-t', targetPane, 'Enter'], { timeout: 5000 });
  } catch (err) {
    return { delivered: false, response: '', channel: 'tmux', latencyMs: Date.now() - start, error: `send-keys 失败: ${String(err)}` };
  }

  // 轮询：连续 2 次内容相同 → 视为回复完成
  const timeoutMs = Math.max(3000, req.timeoutMs ?? 30000);
  const pollInterval = 1500;
  const startTime = Date.now();
  let prevCapture = '';
  let lastCapture = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    spawnSync('sleep', [`${pollInterval / 1000}`]);
    let cap: { status: number | null; stdout: string };
    try {
      const r = spawnSync('tmux', ['capture-pane', '-t', targetPane, '-p', '-S', '-100'], { encoding: 'utf-8', timeout: 3000 });
      cap = { status: r.status, stdout: r.stdout ?? '' };
    } catch {
      continue;
    }
    if (cap.status !== 0 || !cap.stdout) continue;
    const cur = cap.stdout;
    lastCapture = cur;
    if (cur === prevCapture) {
      stableCount++;
      // 内容已稳定 2 轮，且与发送前不同 → 回复完成
      if (stableCount >= 2 && cur !== preCapture) break;
    } else {
      stableCount = 0;
      prevCapture = cur;
    }
  }

  const newContent = extractNewContent(lastCapture, preCapture, req.message);
  return {
    delivered: true,
    response: newContent,
    channel: 'tmux',
    latencyMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// applescript 通道（IDE 类 CLI 在 macOS 上的 fallback / new 模式主通道）
// ---------------------------------------------------------------------------

/** 检查 macOS 应用是否正在运行 */
function isAppRunning(appName: string): boolean {
  try {
    // 用 application "X" is running 而非 process name 匹配：
    // 某些 app（如 Trae）的可执行名是 "Electron"，System Events 里 process name 不是 "Trae"，
    // 但 Launch Services 能通过 bundle name 正确解析。
    const r = spawnSync('osascript', ['-e', `application "${appName}" is running`], { encoding: 'utf-8', timeout: 2000 });
    return r.status === 0 && (r.stdout ?? '').trim() === 'true';
  } catch {
    return false;
  }
}

/** 通过 AppleScript 向 IDE 注入消息：open -a 启动 → activate → pbcopy + Cmd+V → Enter */
function applescriptTrigger(req: TriggerRequest): TriggerResult {
  const start = Date.now();
  const appName = IDE_APP_NAME[req.cli];
  if (!appName) {
    return { delivered: false, response: '', channel: 'applescript', latencyMs: 0, error: `${req.cli} 没有配置 macOS 应用名` };
  }
  if (process.platform !== 'darwin') {
    return { delivered: false, response: '', channel: 'applescript', latencyMs: 0, error: 'applescript 通道仅支持 macOS' };
  }

  const running = isAppRunning(appName);
  if (!running) {
    if (req.mode !== 'new') {
      return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `${appName} 未运行（需 new 模式启动）` };
    }
    // new 模式：open -a 启动
    let openRes: { status: number | null; stderr: string };
    try {
      const r = spawnSync('open', ['-a', appName], { encoding: 'utf-8', timeout: 5000 });
      openRes = { status: r.status, stderr: r.stderr ?? '' };
    } catch (err) {
      return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `open -a ${appName} 失败: ${String(err)}` };
    }
    if (openRes.status !== 0) {
      return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `无法启动 ${appName}: ${openRes.stderr}` };
    }
    // 等待应用就绪
    const launchBudget = 10000;
    const launchStart = Date.now();
    let launched = false;
    while (Date.now() - launchStart < launchBudget) {
      spawnSync('sleep', ['1']);
      if (isAppRunning(appName)) {
        launched = true;
        break;
      }
    }
    if (!launched) {
      return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `${appName} 启动超时（10s）` };
    }
    // 额外等待 UI 就绪
    spawnSync('sleep', ['3']);
  }

  // 激活到前台
  try {
    spawnSync('osascript', ['-e', `tell application "${appName}" to activate`], { encoding: 'utf-8', timeout: 2000 });
  } catch {
    // ignore
  }
  spawnSync('sleep', ['1']);

  // 保存原剪贴板
  let oldClip = '';
  try {
    const r = spawnSync('pbpaste', { encoding: 'utf-8', timeout: 1000 });
    oldClip = r.stdout ?? '';
  } catch {
    // ignore
  }

  // 写入消息到剪贴板
  try {
    spawnSync('pbcopy', { input: req.message, timeout: 1000 });
  } catch (err) {
    return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `pbcopy 失败: ${String(err)}` };
  }

  // Cmd+V 粘贴 + Enter 发送
  let sendOk = true;
  let sendErr = '';
  try {
    const r = spawnSync('osascript', ['-e', [
      'tell application "System Events"',
      '  keystroke "v" using command down',
      '  delay 0.5',
      '  keystroke return',
      'end tell',
    ].join('\n')], { encoding: 'utf-8', timeout: 5000 });
    if (r.status !== 0) {
      sendOk = false;
      sendErr = (r.stderr ?? '').trim().slice(0, 200);
    }
  } catch (err) {
    sendOk = false;
    sendErr = String(err).slice(0, 200);
  }

  // 恢复剪贴板
  try {
    spawnSync('pbcopy', { input: oldClip, timeout: 1000 });
  } catch {
    // ignore
  }

  if (!sendOk) {
    return { delivered: false, response: '', channel: 'applescript', latencyMs: Date.now() - start, error: `keystroke 失败（可能缺少辅助功能权限）: ${sendErr}` };
  }

  // 等待回复：通过 accessibility API 读 UI 文本，连续 2 次稳定即认为回复完成
  const timeoutMs = Math.max(5000, req.timeoutMs ?? 30000);
  const pollInterval = 2000;
  const startTime = Date.now();
  let prevText = '';
  let lastText = '';
  let stableCount = 0;
  let accessibilityOk = true;

  while (Date.now() - startTime < timeoutMs) {
    spawnSync('sleep', [`${pollInterval / 1000}`]);
    let text = '';
    try {
      const r = spawnSync('osascript', ['-e', [
        `tell application "System Events"`,
        `  tell process "${appName}"`,
        '    set output to ""',
        '    try',
        '      set output to value of (every text area of every window)',
        '    end try',
        '    return output',
        '  end tell',
        'end tell',
      ].join('\n')], { encoding: 'utf-8', timeout: 3000 });
      if (r.status === 0) {
        text = (r.stdout ?? '').trim();
      } else {
        // accessibility 失败一次后就不再尝试，只等固定时长
        accessibilityOk = false;
      }
    } catch {
      accessibilityOk = false;
    }
    lastText = text;
    if (!accessibilityOk) {
      // 没法读 UI，跑完剩余时间就返回
      continue;
    }
    if (text && text === prevText) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
      prevText = text;
    }
  }

  return {
    delivered: true,
    response: lastText,
    channel: 'applescript',
    latencyMs: Date.now() - start,
    error: accessibilityOk ? undefined : '已发送但无法读取回复（无辅助功能权限）',
  };
}

// ---------------------------------------------------------------------------
// WS-RPC 类 CLI 的 new session 实现
// ---------------------------------------------------------------------------

/**
 * WS-RPC 类 CLI（kimi / openclaw / pi / copilot）的 new session 实现。
 *
 * 这些 CLI 没有 CLI_LAUNCH_COMMANDS（不能简单 spawnSync `<bin> <args> <prompt>`），
 * 需要通过各自 wrapper 的 launch/inject 协议创建 session 并获取回复。
 *
 * 策略（按顺序尝试）：
 *   a. 调 wrapper.inject(sessionId='', message) — 适用于会自动创建 session 的 wrapper
 *   b. 调 wrapper 的 launch 方法（各 CLI 签名不同，分别处理），累积回复
 *   c. 兜底 spawnSync `<bin> <message>` 让 CLI 自己启动
 */
async function wsRpcNewSession(req: TriggerRequest, start: number, timeoutMs: number): Promise<TriggerResult> {
  const cli = req.cli;

  // (b) 调专用 launch 方法（各 CLI 分别处理，绕过 wrapper 的 require() 问题）
  try {
    if (cli === 'kimi') {
      return await wsRpcNewSessionKimi(req, start, timeoutMs);
    }
    if (cli === 'openclaw') {
      return await wsRpcNewSessionOpenclaw(req, start, timeoutMs);
    }
    if (cli === 'pi') {
      return await wsRpcNewSessionPi(req, start, timeoutMs);
    }
    if (cli === 'copilot') {
      return await wsRpcNewSessionCopilot(req, start, timeoutMs);
    }
  } catch (err) {
    // launch 失败，继续到 spawnSync 兜底
  }

  // (c) 兜底 spawnSync `<bin> <message>`
  const bin = BIN_MAP[cli];
  if (!bin) {
    return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: `未知 CLI: ${cli}` };
  }
  try {
    const r = spawnSync(bin, [req.message], {
      encoding: 'utf-8',
      timeout: timeoutMs,
      cwd: req.cwd,
    });
    return {
      delivered: r.status === 0,
      response: r.stdout || r.stderr || '',
      exitCode: r.status ?? -1,
      channel: 'ws-rpc',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: String(err) };
  }
}

/**
 * Kimi new session：直接通过 ACP 协议（spawn kimi acp + JSON-RPC over stdio）。
 *
 * 不使用 KimiController wrapper，因为：
 *   1. wrapper.launch() 用 `kimi -w <dir> --session <id> -m <prompt>`，但 -m 是 --model
 *      而非 message，CLI 格式已变更（kimi 现在需要子命令，无直接非交互 prompt 模式）
 *   2. wrapper.ts 用 require('node:crypto')，在 ESM 上下文中不可用
 *
 * ACP 协议流程：
 *   1. spawn `kimi acp` 启动 JSON-RPC over stdio 服务器
 *   2. send initialize { protocolVersion: 1, clientInfo, capabilities }
 *   3. send session/new { cwd, mcpServers: [] } → 返回 { sessionId }
 *   4. send session/prompt { sessionId, prompt: [{type:'text', text:...}] } → 返回 { stopReason }
 *   5. 轮询 context.jsonl 文件直到出现 assistant 消息（ACP 事件流不含回复文本，
 *      回复写入 ~/.kimi/sessions/<workDirHash>/<sessionId>/context.jsonl）
 */
async function wsRpcNewSessionKimi(req: TriggerRequest, start: number, timeoutMs: number): Promise<TriggerResult> {
  const { spawn } = await import('node:child_process');
  const workDir = req.cwd ?? process.cwd();

  const child = spawn('kimi', ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  let msgId = 0;
  const pending = new Map<number, (msg: unknown) => void>();
  let stderrBuf = '';

  const indexOfMessage = (buf: string): number => {
    // Content-Length 分帧（LSP 风格）
    const he = buf.indexOf('\r\n\r\n');
    if (he !== -1) {
      const hdr = buf.slice(0, he);
      const mt = hdr.match(/Content-Length:\s*(\d+)/i);
      if (mt) {
        const len = parseInt(mt[1]!, 10);
        const bs = he + 4;
        return buf.length >= bs + len ? bs + len : -1;
      }
    }
    // 换行分隔
    const nl = buf.indexOf('\n');
    return nl !== -1 ? nl + 1 : -1;
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    buffer += data;
    let idx: number;
    while ((idx = indexOfMessage(buffer)) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx);
      const he = raw.indexOf('\r\n\r\n');
      const jsonStr = he !== -1 ? raw.slice(he + 4).trim() : raw.trim();
      if (!jsonStr) continue;
      try {
        const msg = JSON.parse(jsonStr) as { id?: number };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch { /* 非 JSON，跳过 */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { stderrBuf += d; });
  child.on('error', () => { /* 忽略，pending 会超时 */ });

  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = ++msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP 超时: ${method}`));
      }, Math.min(timeoutMs, 30_000));
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  };

  try {
    await send('initialize', { protocolVersion: 1, clientInfo: { name: 'ymesh', version: '0.1.0' }, capabilities: {} });
    const sn = await send('session/new', { cwd: workDir, mcpServers: [] }) as { result?: { sessionId?: string }; error?: unknown };
    if (sn.error) {
      return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: `kimi session/new 失败: ${JSON.stringify(sn.error).slice(0, 200)}` };
    }
    const sessionId = sn.result?.sessionId;
    if (!sessionId) {
      return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: 'kimi session/new 未返回 sessionId' };
    }

    // session/prompt 返回 { stopReason: 'end_turn' }，但回复文本不通过事件流返回，
    // 而是写入 context.jsonl。发送 prompt 后轮询文件等 assistant 消息出现。
    await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: req.message }] });

    // 轮询 context.jsonl 寻找 assistant 回复
    const reply = await pollKimiContextForReply(workDir, sessionId, timeoutMs);

    return {
      delivered: reply.length > 0,
      response: reply,
      newSessionId: sessionId,
      channel: 'ws-rpc',
      latencyMs: Date.now() - start,
      error: reply.length > 0 ? undefined : (stderrBuf.trim().slice(0, 200) || 'kimi 未返回回复（可能认证失败或模型未配置）'),
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: `kimi ACP 失败: ${String(err).slice(0, 200)}${stderrBuf.trim() ? ` | stderr: ${stderrBuf.trim().slice(0, 200)}` : ''}` };
  } finally {
    try { child.kill(); } catch { /* ignore */ }
  }
}

/**
 * 轮询 kimi context.jsonl 文件，等待 assistant 消息出现。
 * 文件路径：~/.kimi/sessions/<workDirHash>/<sessionId>/context.jsonl
 * workDirHash 是 workDir 的 md5 hex（实测 32 位）。
 */
async function pollKimiContextForReply(workDir: string, sessionId: string, timeoutMs: number): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');

  const sessionsDir = path.join(os.homedir(), '.kimi', 'sessions');
  // workDirHash：kimi 用 md5(workDir) 的 hex 作为目录名
  const workDirHash = crypto.createHash('md5').update(workDir).digest('hex');
  const contextFile = path.join(sessionsDir, workDirHash, sessionId, 'context.jsonl');

  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  const pollInterval = 1000;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(contextFile, 'utf8');
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t) as { role?: string; content?: unknown };
          if (obj.role === 'assistant') {
            const text = extractTextFromContent(obj.content);
            if (text) return text;
          }
        } catch { /* 脏行跳过 */ }
      }
    } catch { /* 文件还不存在或不可读 */ }

    await new Promise((r) => setTimeout(r, pollInterval));
  }
  return '';
}

/** 从 kimi context.jsonl 的 content 字段提取文本（字符串或 content block 数组） */
function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

/**
 * OpenClaw new session：直接通过 CLI（openclaw agent --message）启动。
 *
 * 不使用 OpenClawController wrapper，因为 wrapper.ts 用 require('node:crypto')
 * 在 ESM 上下文中不可用（generateSessionId 抛 ReferenceError）。
 *
 * CLI 路径：openclaw agent --agent main --session-id <uuid> --message <prompt> --json
 * WS RPC 路径（降级）：ws://127.0.0.1:18789 sessions.send
 *
 * 认证失败时（403 Deposit required）CLI 返回错误信息到 stderr，
 * 返回 delivered:false + 认证错误，避免上层 fallthrough。
 */
async function wsRpcNewSessionOpenclaw(req: TriggerRequest, start: number, timeoutMs: number): Promise<TriggerResult> {
  const crypto = await import('node:crypto');
  const sessionId = crypto.randomUUID();
  const agentId = 'main';

  // 直接用 CLI：openclaw agent --agent main --session-id <uuid> --message <prompt> --json
  try {
    const r = spawnSync('openclaw', [
      'agent', '--agent', agentId, '--session-id', sessionId,
      '--message', req.message, '--json',
    ], {
      encoding: 'utf-8',
      timeout: Math.min(timeoutMs, 60_000),
      cwd: req.cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';

    // 尝试从 JSON 输出提取 reply
    let reply = '';
    try {
      const parsed = JSON.parse(stdout);
      reply = typeof parsed.reply === 'string' ? parsed.reply : (typeof parsed.output === 'string' ? parsed.output : '');
    } catch {
      reply = stdout.trim();
    }

    if (reply.trim().length > 0) {
      return {
        delivered: true,
        response: reply,
        newSessionId: sessionId,
        channel: 'ws-rpc',
        latencyMs: Date.now() - start,
      };
    }

    // 无 reply：检查是否认证失败
    const errMsg = stderr.trim().length > 0
      ? stderr.trim().slice(0, 300)
      : (stdout.trim().length > 0 ? stdout.trim().slice(0, 300) : 'openclaw 未返回回复');
    return {
      delivered: false,
      response: '',
      newSessionId: sessionId,
      channel: 'ws-rpc',
      latencyMs: Date.now() - start,
      error: errMsg,
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'ws-rpc', latencyMs: Date.now() - start, error: `openclaw CLI 失败: ${String(err).slice(0, 200)}` };
  }
}

/** Pi new session：通过 PiController.launch + stream 订阅 + waitForIdle 获取回复 */
async function wsRpcNewSessionPi(req: TriggerRequest, start: number, timeoutMs: number): Promise<TriggerResult> {
  const mod = await regLoadWrapper('pi') as {
    PiController: new () => {
      launch: (p: string, cli: string, opts: { cwd?: string }) => Promise<{
        sessionId: string;
        getStream: (listener: (e: Record<string, unknown>) => void) => () => void;
        waitForIdle: (t?: number) => Promise<unknown>;
        stop: () => Promise<void>;
      }>;
    },
  };
  const ctrl = new mod.PiController();

  // 不使用 waitIdle:true （会在 launch 内部等待，错过事件订阅时机）
  const handle = await withTimeout(
    ctrl.launch(req.message, 'pi', { cwd: req.cwd }),
    Math.min(timeoutMs, 30_000),
  );

  // 先订阅事件流，再等待 idle，确保不丢失 token/message 事件
  let responseText = '';
  const unsubscribe = handle.getStream((event) => {
    const text = extractPiEventText(event);
    if (text) responseText += text;
  });

  try {
    await withTimeout(handle.waitForIdle(timeoutMs), timeoutMs);
  } catch {
    // 超时也返回已收集的内容
  } finally {
    unsubscribe();
    await handle.stop().catch(() => { /* ignore */ });
  }

  return {
    delivered: responseText.length > 0,
    response: responseText,
    newSessionId: handle.sessionId || undefined,
    channel: 'ws-rpc',
    latencyMs: Date.now() - start,
  };
}

/** Copilot new session：通过 CopilotWrapper.launch spawn + 累积 stdout JSONL 流 */
async function wsRpcNewSessionCopilot(req: TriggerRequest, start: number, timeoutMs: number): Promise<TriggerResult> {
  const mod = await regLoadWrapper('copilot') as {
    CopilotWrapper: new () => {
      launch: (p: string, opts: { cwd?: string; model?: string }) => Promise<{
        child: { stdout: { on: (ev: string, cb: (chunk: Buffer) => void) => void }; on: (ev: string, cb: (...args: unknown[]) => void) => void; kill: (sig?: string) => void };
        sessionId?: string;
        prompt: string;
      }>;
    },
  };
  const wrapper = new mod.CopilotWrapper();
  const launchResult = await wrapper.launch(req.message, { cwd: req.cwd, model: req.model });

  // 累积 stdout（JSONL 流：每行一个事件）+ stderr（用于错误诊断）
  let rawStdout = '';
  let stderrBuf = '';
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { launchResult.child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve();
    }, timeoutMs);

    launchResult.child.stdout.on('data', (chunk: Buffer) => {
      rawStdout += chunk.toString('utf8');
    });
    // @ts-expect-error: stderr 存在但类型声明中未暴露（stdio: ['pipe','pipe','pipe']）
    launchResult.child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });
    launchResult.child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    launchResult.child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  // 从 JSONL 流提取 assistant.message 内容和 session.start sessionId
  const extracted = extractCopilotResponse(rawStdout);
  const sessionId = launchResult.sessionId || extracted.sessionId;

  // 有 assistant.message 文本 → 成功
  if (extracted.text.length > 0) {
    return {
      delivered: true,
      response: extracted.text,
      newSessionId: sessionId,
      channel: 'ws-rpc',
      latencyMs: Date.now() - start,
    };
  }

  // 无 assistant.message：可能是策略限制 / 认证失败 / 超时
  // 提取 session.warning 的 message 作为错误信息，不返回 raw JSON 作为 response
  const warning = extractCopilotWarning(rawStdout);
  const errMsg = warning
    || (stderrBuf.trim().length > 0 ? stderrBuf.trim().slice(0, 200) : '')
    || 'copilot 未产生 assistant.message 事件（可能策略限制或认证失败）';

  return {
    delivered: false,
    response: '',
    newSessionId: sessionId,
    channel: 'ws-rpc',
    latencyMs: Date.now() - start,
    error: errMsg,
  };
}

/** 从 Copilot stdout JSONL 流提取 session.warning 的 message 字段 */
function extractCopilotWarning(raw: string): string {
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { type?: string; data?: { message?: unknown } };
      if (obj.type === 'session.warning' && obj.data && typeof obj.data.message === 'string') {
        return obj.data.message.slice(0, 200);
      }
    } catch { /* 脏行 */ }
  }
  return '';
}

/**
 * 从 Pi RPC 事件中提取可显示文本。
 *
 * 实测 pi 事件类型（glm-5.2 模型，2026-07）：
 *   - message_end { message: { role: 'assistant', content: [{type:'text',text:...}] } }
 *   - turn_end    { message: { role: 'assistant', content: [...] } }  ← 与 message_end 重复
 *   - agent_end   { messages: [{ role: 'assistant', content: [...] }] } ← 与 message_end 重复
 *   - message_update { assistantMessageEvent: { type: 'text_end', content: '...' } } ← 与 message_end 重复
 *
 * 策略：只从 message_end（assistant role）取完整文本，避免 turn_end/agent_end 重复。
 * message_end 每条 assistant 消息触发一次，无重复。
 */
function extractPiEventText(event: Record<string, unknown>): string {
  const type = typeof event.type === 'string' ? event.type : '';

  // message_end：message.role === 'assistant' → 取 content 数组中 text 块
  if (type === 'message_end') {
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message && message.role === 'assistant') {
      return extractTextFromPiContent(message.content);
    }
    return '';
  }

  return '';
}

/** 从 pi message.content（字符串或 content block 数组）提取 text 块文本 */
function extractTextFromPiContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/** 从 Copilot stdout JSONL 流提取 assistant.message 文本 + session.start sessionId */
function extractCopilotResponse(raw: string): { text: string; sessionId?: string } {
  const parts: string[] = [];
  let sessionId: string | undefined;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof obj.type === 'string' ? obj.type : '';
    const data = (obj.data ?? {}) as Record<string, unknown>;

    if (type === 'session.start') {
      const sid = data.sessionId;
      if (typeof sid === 'string' && !sessionId) sessionId = sid;
    }
    if (type === 'assistant.message') {
      const content = data.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        parts.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
      }
    }
  }
  return { text: parts.join('\n'), sessionId };
}

// ---------------------------------------------------------------------------
// HTTP API 类 CLI 的 new session 实现
// ---------------------------------------------------------------------------

/** 每个 HTTP API CLI 的 server 配置 */
interface HttpApiServerConfig {
  /** CLI 二进制名（用于 spawn server） */
  bin: string;
  /** 启动 server 的参数 */
  serveArgs: (port: number) => string[];
  /** 默认端口 */
  defaultPort: number;
  /** 健康检查路径（GET） */
  healthPath: string;
  /** server 启动后的就绪等待毫秒 */
  startupGraceMs: number;
}

/** HTTP_API_CLIS 的 server 配置 */
const HTTP_API_SERVER_CONFIGS: Record<string, HttpApiServerConfig> = {
  opencode: {
    bin: 'opencode',
    serveArgs: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    defaultPort: 4096,
    healthPath: '/config',
    startupGraceMs: 3000,
  },
  openhands: {
    bin: 'openhands',
    serveArgs: (port) => ['agent-server', '--port', String(port), '--host', '127.0.0.1'],
    defaultPort: 3000,
    healthPath: '/health',
    startupGraceMs: 5000,
  },
  qwen: {
    bin: 'qwen',
    serveArgs: (port) => ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--no-web'],
    defaultPort: 4170,
    healthPath: '/health',
    startupGraceMs: 3000,
  },
};

/** 已启动的 server 子进程（避免重复启动） */
const startedServers = new Map<string, ReturnType<typeof spawn>>();

/** 解析 model 字符串 "provider/model" → {providerID, modelID} */
function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model || typeof model !== 'string') return undefined;
  const slashIdx = model.indexOf('/');
  if (slashIdx <= 0 || slashIdx >= model.length - 1) return undefined;
  return {
    providerID: model.slice(0, slashIdx),
    modelID: model.slice(slashIdx + 1),
  };
}

/** 探测 HTTP API server 是否可达 */
async function pingServer(baseUrl: string, healthPath: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(new URL(healthPath, baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status < 500; // 4xx 也视为可达（server 在跑）
  } catch {
    return false;
  }
}

/** 确保 HTTP API server 运行（不可达则 spawn） */
async function ensureServerRunning(cli: string, cfg: HttpApiServerConfig, baseUrl: string, port: number): Promise<boolean> {
  if (await pingServer(baseUrl, cfg.healthPath)) return true;
  if (startedServers.has(cli)) {
    // 已启动但不可达，可能刚崩溃，等一下再试
    await sleep(cfg.startupGraceMs);
    return pingServer(baseUrl, cfg.healthPath);
  }
  // spawn server
  try {
    const child = spawn(cfg.bin, cfg.serveArgs(port), {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      cwd: process.cwd(),
    });
    startedServers.set(cli, child);
    // 等待就绪：轮询 health endpoint
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await pingServer(baseUrl, cfg.healthPath)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 通用 JSON HTTP 请求 */
async function httpJson<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
  headers?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    throw new Error(`HTTP ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
  }
  const text = await res.text();
  if (text.length === 0) return null as T;
  return JSON.parse(text) as T;
}

/** sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── OpenCode HTTP API ────────────────────────────────────────────────────

async function opencodeNewSession(req: TriggerRequest, baseUrl: string, timeoutMs: number): Promise<TriggerResult | null> {
  const start = Date.now();
  const model = parseModel(req.model);

  try {
    // 1. 创建 session
    const sessionBody: Record<string, unknown> = {};
    if (model) sessionBody.model = model;
    const session = await httpJson<{ id: string }>(baseUrl, 'POST', '/session', sessionBody, 10_000);
    if (!session.id) {
      return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: 'OpenCode server 未返回 session id' };
    }
    const sid = session.id;

    // 2. 注入 prompt（prompt_async 是异步的，返回 204）
    const promptBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: req.message }],
    };
    if (model) {
      promptBody.model = { providerID: model.providerID, modelID: model.modelID };
    }
    await httpJson(baseUrl, 'POST', `/session/${encodeURIComponent(sid)}/prompt_async`, promptBody, 10_000);

    // 3. 轮询 messages 等待 assistant 回复
    const deadline = start + timeoutMs;
    let assistantText = '';
    let sawAssistant = false;
    let sawAssistantAt = 0;
    let promptSentAt = Date.now();
    while (Date.now() < deadline) {
      await sleep(2000);
      const msgs = await httpJson<Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>>(baseUrl, 'GET', `/session/${encodeURIComponent(sid)}/message`, undefined, 10_000).catch(() => []);

      for (const m of msgs) {
        if (m.info.role === 'assistant') {
          if (!sawAssistant) {
            sawAssistant = true;
            sawAssistantAt = Date.now();
          }
          const texts: string[] = [];
          for (const p of m.parts) {
            if (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) {
              texts.push(p.text);
            }
          }
          if (texts.length > 0) {
            assistantText = texts.join('\n');
            break;
          }
        }
      }
      if (assistantText) break;
      // 如果已看到 assistant 消息但无 text，且超过 15s，认为模型可能失败但消息已投递
      if (sawAssistant && Date.now() - sawAssistantAt > 15_000) break;
      // 如果 30s 内连 assistant 消息都没出现，认为模型不可用但消息已投递
      if (!sawAssistant && Date.now() - promptSentAt > 30_000) break;
    }

    return {
      delivered: true,
      response: assistantText,
      newSessionId: sid,
      channel: 'http-api',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: `opencode new session 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── OpenHands HTTP API ───────────────────────────────────────────────────

async function openhandsNewSession(req: TriggerRequest, baseUrl: string, timeoutMs: number): Promise<TriggerResult | null> {
  const start = Date.now();
  const apiToken = process.env.OPENHANDS_API_TOKEN;
  const headers: Record<string, string> = {};
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;

  try {
    // 1. 创建 conversation（含 initial_user_msg）
    const body: Record<string, unknown> = {
      initial_user_msg: req.message,
    };
    if (req.model) body.llm_model = req.model;
    body.agent = 'codeact';

    const conv = await httpJson<{ conversation_id?: string; conversationId?: string }>(
      baseUrl, 'POST', '/api/conversations', body, 30_000, headers,
    );
    const convId = conv.conversation_id ?? conv.conversationId;
    if (!convId) {
      return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: 'OpenHands server 未返回 conversation_id' };
    }

    // 2. 轮询 conversation 状态直到完成
    const deadline = start + timeoutMs;
    let status = 'running';
    while (Date.now() < deadline) {
      await sleep(3000);
      const st = await httpJson<{ status?: string; conversation_id?: string }>(
        baseUrl, 'GET', `/api/conversations/${encodeURIComponent(convId)}`, undefined, 10_000, headers,
      ).catch(() => ({}) as { status?: string });
      status = st.status ?? 'running';
      if (status === 'completed' || status === 'stopped' || status === 'error' || status === 'idle') break;
    }

    // 3. 获取消息列表
    let responseText = '';
    try {
      const msgs = await httpJson<Array<{ role?: string; content?: string | Array<{ type?: string; text?: string }> }>>(
        baseUrl, 'GET', `/api/conversations/${encodeURIComponent(convId)}/messages`, undefined, 10_000, headers,
      );
      const assistantMsgs = Array.isArray(msgs) ? msgs.filter((m) => m.role === 'assistant' || m.role === 'agent') : [];
      for (const m of assistantMsgs.reverse()) {
        if (typeof m.content === 'string' && m.content.length > 0) {
          responseText = m.content;
          break;
        } else if (Array.isArray(m.content)) {
          const texts = m.content.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text!);
          if (texts.length > 0) {
            responseText = texts.join('\n');
            break;
          }
        }
      }
    } catch {
      // messages endpoint 不可用时，inject 时如果 waitForResponse=true 可能已拿到
    }

    return {
      delivered: true,
      response: responseText,
      newSessionId: convId,
      channel: 'http-api',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: `openhands new session 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Qwen HTTP API ────────────────────────────────────────────────────────

async function qwenNewSession(req: TriggerRequest, baseUrl: string, timeoutMs: number): Promise<TriggerResult | null> {
  const start = Date.now();
  const token = process.env.QWEN_SERVER_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    // 1. 创建 session（POST /session，需要 cwd 匹配 server 的 workspace）
    const sessionBody: Record<string, unknown> = {
      cwd: req.cwd ?? process.cwd(),
    };
    const session = await httpJson<{ id?: string; sessionId?: string; error?: string; code?: string }>(
      baseUrl, 'POST', '/session', sessionBody, 10_000, headers,
    );

    // qwen serve 如果未认证会返回 error
    if (session.error) {
      return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: `qwen serve: ${session.error} (code=${session.code ?? 'unknown'})` };
    }
    const sid = session.id ?? session.sessionId;
    if (!sid) {
      return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: 'qwen serve 未返回 session id' };
    }

    // 2. 发送消息（POST /v1/sessions/:id/messages）→ SSE 流
    const msgUrl = new URL(`/v1/sessions/${encodeURIComponent(sid)}/messages`, baseUrl);
    const msgRes = await fetch(msgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ message: req.message }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!msgRes.ok) {
      const detail = await msgRes.text().catch(() => '');
      return { delivered: false, response: '', newSessionId: sid, channel: 'http-api', latencyMs: Date.now() - start, error: `qwen serve inject 失败 (${msgRes.status}): ${detail.slice(0, 200)}` };
    }

    // 3. 消费 SSE 流，收集 assistant text
    let assistantText = '';
    if (msgRes.body) {
      const reader = msgRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines: string[] = [];
      const deadline = start + timeoutMs;

      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            dataLines.push(line.slice(6));
          } else if (line.trim() === '' && dataLines.length > 0) {
            const joined = dataLines.join('\n');
            dataLines = [];
            if (joined === '[DONE]') {
              buffer = '';
              break;
            }
            try {
              const ev = JSON.parse(joined) as Record<string, unknown>;
              // qwen serve 事件格式：{type: "text", text: "..."} 或 {type: "message", ...}
              const evType = ev.type as string | undefined;
              if (evType === 'text' && typeof ev.text === 'string') {
                assistantText += ev.text;
              } else if (evType === 'assistant' && typeof ev.content === 'string') {
                assistantText += ev.content;
              }
            } catch { /* non-JSON data, skip */ }
          }
        }
      }
    }

    return {
      delivered: true,
      response: assistantText,
      newSessionId: sid,
      channel: 'http-api',
      latencyMs: Date.now() - start,
    };
  } catch (err) {
    return { delivered: false, response: '', channel: 'http-api', latencyMs: Date.now() - start, error: `qwen new session 失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * HTTP API 类 CLI 的 new session 统一入口。
 * 返回 null 表示该 CLI 的 HTTP API 不支持 new session，应回退到其他通道。
 */
async function httpApiNewSession(req: TriggerRequest): Promise<TriggerResult | null> {
  const cfg = HTTP_API_SERVER_CONFIGS[req.cli];
  if (!cfg) return null;

  const timeoutMs = req.timeoutMs ?? 60000;
  const port = cfg.defaultPort;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 确保 server 运行
  const serverOk = await ensureServerRunning(req.cli, cfg, baseUrl, port);
  if (!serverOk) {
    return {
      delivered: false,
      response: '',
      channel: 'http-api',
      latencyMs: 0,
      error: `${req.cli} server 不可达: ${baseUrl}（尝试自动启动失败，请手动运行 \`${cfg.bin} ${cfg.serveArgs(port).join(' ')}\`）`,
    };
  }

  switch (req.cli) {
    case 'opencode':
      return opencodeNewSession(req, baseUrl, timeoutMs);
    case 'openhands':
      return openhandsNewSession(req, baseUrl, timeoutMs);
    case 'qwen':
      return qwenNewSession(req, baseUrl, timeoutMs);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 主适配器
// ---------------------------------------------------------------------------

/** 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`超时 ${ms}ms`)), ms),
    ),
  ]);
}

export class TriggerAdapter {
  /** 执行触发 */
  async trigger(req: TriggerRequest): Promise<TriggerResult> {
    const start = Date.now();
    const timeoutMs = req.timeoutMs ?? 60000;

    try {
      // IDE 类 CLI → tmux 优先，applescript 兜底（macOS）
      if (IDE_CLIS.has(req.cli)) {
        // tmux 通道：running 模式优先尝试（找已运行 pane）
        const tmuxRes = tmuxTrigger(req);
        if (tmuxRes.delivered) return tmuxRes;

        // tmux 失败 → applescript 兜底（macOS）
        if (process.platform === 'darwin') {
          return applescriptTrigger(req);
        }
        return tmuxRes;
      }

      // 非 IDE 类 → wrapper inject（stopped/running 模式）
      if (req.mode === 'stopped' || req.mode === 'running') {
        if (!req.sessionId) {
          return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: 0, error: 'stopped/running 模式需要 sessionId' };
        }

        const result = await withTimeout(
          callWrapperInject(req.cli, req.sessionId, req.message),
          timeoutMs,
        );

        if (result) {
          return {
            delivered: true,
            response: result.response,
            exitCode: result.exitCode,
            channel: HTTP_API_CLIS.has(req.cli) ? 'http-api' : WS_RPC_CLIS.has(req.cli) ? 'ws-rpc' : 'cli-spawn',
            latencyMs: Date.now() - start,
          };
        }

        // wrapper inject 失败，尝试直接 spawn
        return this.fallbackSpawn(req, start);
      }

      // new 模式 → WS-RPC 类 CLI 优先走专用通道（kimi/openclaw/pi/copilot）
      if (req.mode === 'new') {
        // 0. WS-RPC 类 CLI 优先走 wsRpcNewSession（wrapper launch + stdin 注入 + 累积 stdout）
        let wsResult: TriggerResult | null = null;
        if (WS_RPC_CLIS.has(req.cli)) {
          wsResult = await wsRpcNewSession(req, start, timeoutMs).catch((err) => ({
            delivered: false,
            response: '',
            channel: 'ws-rpc' as TriggerChannel,
            latencyMs: Date.now() - start,
            error: String(err),
          }));
          // 拿到非空回复 → 直接返回
          if (wsResult.delivered && wsResult.response && wsResult.response.trim().length > 0) {
            return wsResult;
          }
          // WS-RPC 通道未拿到回复，继续尝试通用路径作为兜底
        }

        // 0.5. HTTP API 类 CLI（opencode/openhands/qwen）走 httpApiNewSession
        if (HTTP_API_CLIS.has(req.cli)) {
          const httpResult = await httpApiNewSession(req).catch((err): TriggerResult => ({
            delivered: false,
            response: '',
            channel: 'http-api',
            latencyMs: Date.now() - start,
            error: String(err),
          }));
          // HTTP API 成功投递 → 直接返回（即使回复为空，也说明 session 创建+消息投递成功）
          if (httpResult && httpResult.delivered) {
            return httpResult;
          }
          // HTTP API 不可用 → 继续尝试 CLI_LAUNCH_COMMANDS 兜底（如 qwen 有 CLI 模式）
        }

        // 1. 先尝试 wrapper launch
        const wrapperResult = await callWrapperLaunch(req.cli, req.message, { model: req.model, cwd: req.cwd }).catch(() => null);

        if (wrapperResult && wrapperResult.response) {
          return {
            delivered: true,
            response: wrapperResult.response,
            exitCode: wrapperResult.exitCode,
            newSessionId: wrapperResult.sessionId,
            channel: 'cli-spawn',
            latencyMs: Date.now() - start,
          };
        }

        // 2. 用 CLI_LAUNCH_COMMANDS 直接 spawn
        const launchCmd = CLI_LAUNCH_COMMANDS[req.cli];
        if (launchCmd) {
          const cmd = launchCmd(req.message, { model: req.model, cwd: req.cwd });
          try {
            const r = spawnSync(cmd.bin, cmd.args, {
              encoding: 'utf-8',
              timeout: timeoutMs,
              cwd: req.cwd,
              env: { ...process.env, ...(cmd.env ?? {}) },
            });
            const response = r.stdout || r.stderr || '';
            return {
              delivered: r.status === 0,
              response,
              exitCode: r.status ?? -1,
              channel: 'cli-spawn',
              latencyMs: Date.now() - start,
            };
          } catch (err) {
            return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: Date.now() - start, error: String(err) };
          }
        }

        // 3. WS-RPC 类 CLI：返回 wsRpcNewSession 的结果（即使回复为空，也比"不支持"好）
        if (wsResult) {
          return wsResult;
        }

        // 4. 最后尝试 wrapper launch（无 CLI_LAUNCH_COMMANDS 的，如 HTTP API 类）
        if (wrapperResult) {
          return {
            delivered: true,
            response: wrapperResult.response,
            exitCode: wrapperResult.exitCode,
            newSessionId: wrapperResult.sessionId,
            channel: 'cli-spawn',
            latencyMs: Date.now() - start,
          };
        }

        return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: Date.now() - start, error: `${req.cli} 不支持 new 模式` };
      }

      return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: 0, error: `未知模式: ${req.mode}` };
    } catch (err) {
      return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: Date.now() - start, error: String(err) };
    }
  }

  /** 兜底：直接 spawn CLI 命令 */
  private fallbackSpawn(req: TriggerRequest, start: number): TriggerResult {
    const bin = BIN_MAP[req.cli];
    if (!bin) {
      return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: Date.now() - start, error: `未知 CLI: ${req.cli}` };
    }

    // 构造 resume + message 命令
    const args: string[] = [];
    if (req.sessionId) {
      args.push('--resume', req.sessionId);
    }
    args.push('--message', req.message);

    try {
      const r = spawnSync(bin, args, {
        encoding: 'utf-8',
        timeout: req.timeoutMs ?? 60000,
        cwd: req.cwd,
      });
      return {
        delivered: r.status === 0,
        response: r.stdout || r.stderr || '',
        exitCode: r.status ?? -1,
        channel: 'cli-spawn',
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return { delivered: false, response: '', channel: 'cli-spawn', latencyMs: Date.now() - start, error: String(err) };
    }
  }

  /** 查询 CLI 能力 */
  getCapability(cli: string): CliTriggerCapability {
    const isIde = IDE_CLIS.has(cli);
    const installed = isIde ? isIdeInstalled(cli) : isInstalled(cli);
    const isHttpApi = HTTP_API_CLIS.has(cli);
    const isWsRpc = WS_RPC_CLIS.has(cli);

    let modes: TriggerMode[] = [];
    let primaryChannel: TriggerChannel = 'cli-spawn';
    let fallbackChannel: TriggerChannel | undefined;

    if (isIde) {
      // IDE 类支持 running（找已运行 pane/app）和 new（启动 app）
      modes = ['running', 'new'];
      primaryChannel = 'tmux';
      fallbackChannel = 'applescript';
    } else if (isHttpApi) {
      modes = ['stopped', 'running', 'new'];
      primaryChannel = 'http-api';
    } else if (isWsRpc) {
      modes = ['stopped', 'running', 'new'];
      primaryChannel = 'ws-rpc';
    } else {
      modes = ['stopped', 'new'];
      primaryChannel = 'cli-spawn';
    }

    return {
      cli,
      modes,
      primaryChannel,
      fallbackChannel,
      installed,
      wrapperInject: !isIde, // IDE 类没有 wrapper inject
      notes: isIde ? 'tmux send-keys 优先，macOS 上 applescript 兜底' : undefined,
    };
  }

  /** 列出所有 CLI 能力 */
  listCapabilities(): CliTriggerCapability[] {
    return Object.keys(BIN_MAP).map((cli) => this.getCapability(cli));
  }
}
