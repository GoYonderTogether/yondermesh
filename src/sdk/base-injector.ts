/**
 * yondermesh Adapter SDK —— BaseInjector 抽象基类
 *
 * 提供配置文件读写（JSON / TOML / YAML / 文本）、幂等标记块管理
 * （CONTEXT_BLOCK_START/END）、备份/恢复等通用能力。
 *
 * 子类实现 injectAll / uninjectAll，按目标 CLI 的挂载策略组合调用基类助手。
 *
 * 参考实现：src/hermes/inject.ts、src/mount/strategies.ts。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_START,
} from '../mount/types.js';
import type { BaseInjectorOptions, Injector, InjectorResult } from './types.js';

/**
 * BaseInjector —— 通用 injector 抽象基类。
 *
 * 用法：
 *   class MyInjector extends BaseInjector {
 *     readonly cliId = 'mycli';
 *     readonly configDir = '.mycli';
 *     async injectAll() {
 *       const file = this.resolveInstructionFile('AGENTS.md');
 *       this.injectMarkedBlock(file, this.awarenessBlock);
 *     }
 *     async uninjectAll() {
 *       const file = this.resolveInstructionFile('AGENTS.md');
 *       this.removeMarkedBlock(file);
 *     }
 *   }
 */
export abstract class BaseInjector implements Injector {
  protected readonly home: string;
  protected readonly awarenessBlock: string;

  constructor(opts: BaseInjectorOptions = {}) {
    this.home = opts.home ?? os.homedir();
    this.awarenessBlock = opts.awarenessBlock ?? DEFAULT_SDK_AWARENESS_BLOCK;
  }

  /** CLI id（与 mount/registry 的 CliTarget.id 一致） */
  abstract readonly cliId: string;
  /** 配置目录名（如 '.mycli'），相对 home */
  abstract readonly configDir: string;

  abstract injectAll(): Promise<void>;
  abstract uninjectAll(): Promise<void>;

  // ─── 路径解析 ────────────────────────────────────────────────────────

  /** 配置目录绝对路径（home + configDir） */
  protected resolveConfigDir(): string {
    return path.join(this.home, this.configDir);
  }

  /** 配置目录下的文件绝对路径 */
  protected resolveConfigFile(filename: string): string {
    return path.join(this.resolveConfigDir(), filename);
  }

  /** home 下的指令文件绝对路径（如 ~/.mycli/AGENTS.md） */
  protected resolveInstructionFile(filename: string): string {
    return path.join(this.resolveConfigDir(), filename);
  }

  /** 确保配置目录存在（递归创建） */
  protected ensureConfigDir(): void {
    fs.mkdirSync(this.resolveConfigDir(), { recursive: true });
  }

  // ─── 文件读写 ────────────────────────────────────────────────────────

  /** 读取 JSON 文件；不存在或解析失败返回 null */
  protected readJson<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** 写入 JSON 文件（pretty-print，末尾换行）。自动创建父目录。 */
  protected writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  /** 读取文本文件；不存在返回空串 */
  protected readText(filePath: string): string {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  /** 写入文本文件。自动创建父目录。 */
  protected writeText(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }

  // ─── 幂等标记块管理（always-on 策略） ────────────────────────────────

  /**
   * 向文件注入 ymesh awareness 标记块（幂等）。
   * - 已存在块 → 用正则替换块内容（保留文件其他内容）。
   * - 无块 → 追加（带分隔符）。
   * - 文件不存在 → 创建并写入块。
   *
   * 块格式：
   *   <!-- YONDERMESH_AWARENESS_START -->
   *   <block>
   *   <!-- YONDERMESH_AWARENESS_END -->
   */
  protected injectMarkedBlock(
    filePath: string,
    block: string = this.awarenessBlock,
  ): InjectorResult {
    const wrappedBlock = `${CONTEXT_BLOCK_START}\n${block}\n${CONTEXT_BLOCK_END}`;
    try {
      let existing = '';
      if (fs.existsSync(filePath)) {
        existing = fs.readFileSync(filePath, 'utf8');
      }

      // 已有 ymesh awareness 块 → 替换
      if (existing.includes(CONTEXT_BLOCK_START) && existing.includes(CONTEXT_BLOCK_END)) {
        const regex = new RegExp(
          `${escapeRegex(CONTEXT_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONTEXT_BLOCK_END)}`,
          'g',
        );
        const updated = existing.replace(regex, wrappedBlock);
        fs.writeFileSync(filePath, updated, 'utf8');
        return {
          strategy: 'always-on',
          target: filePath,
          success: true,
          message: `${path.basename(filePath)} 中 ymesh awareness 块已更新`,
        };
      }

      // 无 ymesh 块 → 追加
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n\n' : '\n';
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, existing + separator + wrappedBlock + '\n', 'utf8');
      return {
        strategy: 'always-on',
        target: filePath,
        success: true,
        message: `${path.basename(filePath)} 已追加 ymesh awareness 块`,
      };
    } catch (err) {
      return {
        strategy: 'always-on',
        target: filePath,
        success: false,
        message: `写入 ${filePath} 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 移除文件中的 ymesh awareness 标记块（幂等）。
   * 文件不存在或无块视为成功（无需移除）。
   */
  protected removeMarkedBlock(filePath: string): InjectorResult {
    try {
      if (!fs.existsSync(filePath)) {
        return {
          strategy: 'always-on',
          target: filePath,
          success: true,
          message: `${path.basename(filePath)} 不存在，无需移除`,
        };
      }
      const existing = fs.readFileSync(filePath, 'utf8');
      if (!existing.includes(CONTEXT_BLOCK_START)) {
        return {
          strategy: 'always-on',
          target: filePath,
          success: true,
          message: `${path.basename(filePath)} 中无 ymesh awareness 块`,
        };
      }
      const regex = new RegExp(
        `${escapeRegex(CONTEXT_BLOCK_START)}[\\s\\S]*?${escapeRegex(CONTEXT_BLOCK_END)}\\n*`,
        'g',
      );
      const updated = existing.replace(regex, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
      fs.writeFileSync(filePath, updated, 'utf8');
      return {
        strategy: 'always-on',
        target: filePath,
        success: true,
        message: `${path.basename(filePath)} 中 ymesh awareness 块已移除`,
      };
    } catch (err) {
      return {
        strategy: 'always-on',
        target: filePath,
        success: false,
        message: `移除 ${filePath} 块失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** 检查文件中是否已存在 ymesh 标记块 */
  protected hasMarkedBlock(filePath: string): boolean {
    if (!fs.existsSync(filePath)) return false;
    return fs.readFileSync(filePath, 'utf8').includes(CONTEXT_BLOCK_START);
  }

  // ─── 备份/恢复 ───────────────────────────────────────────────────────

  /**
   * 备份文件到 <filePath>.ymesh.bak（覆盖已有备份）。
   * 文件不存在则无操作返回 null。
   */
  protected backup(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const backupPath = `${filePath}.ymesh.bak`;
    fs.copyFileSync(filePath, backupPath);
    return backupPath;
  }

  /** 从备份恢复文件（覆盖当前文件），备份文件保留。备份不存在返回 false。 */
  protected restore(backupPath: string): boolean {
    if (!fs.existsSync(backupPath)) return false;
    const original = backupPath.replace(/\.ymesh\.bak$/, '');
    fs.copyFileSync(backupPath, original);
    return true;
  }

  // ─── MCP 配置注入助手（mcp-json 策略） ───────────────────────────────

  /**
   * 向 JSON 配置文件的 mcpServers 键注入一个 MCP server（幂等）。
   * 已存在同名 server → 替换；不存在 → 新增。
   * 保留文件中其他键。
   */
  protected injectMcpJson(
    configPath: string,
    serverName: string,
    def: { command: string; args: string[]; env?: Record<string, string> },
  ): InjectorResult {
    try {
      const config = this.readJson<Record<string, unknown>>(configPath) ?? {};
      const mcpServers = (config.mcpServers as Record<string, unknown>) ?? {};
      mcpServers[serverName] = def;
      config.mcpServers = mcpServers;
      this.writeJson(configPath, config);
      return {
        strategy: 'mcp-json',
        target: configPath,
        success: true,
        message: `mcpServers.${serverName} 已注入 ${path.basename(configPath)}`,
      };
    } catch (err) {
      return {
        strategy: 'mcp-json',
        target: configPath,
        success: false,
        message: `注入 MCP JSON 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** 从 JSON 配置文件的 mcpServers 键移除指定 server（幂等）。 */
  protected removeMcpJson(configPath: string, serverName: string): InjectorResult {
    try {
      const config = this.readJson<Record<string, unknown>>(configPath);
      if (!config || !config.mcpServers) {
        return {
          strategy: 'mcp-json',
          target: configPath,
          success: true,
          message: `${path.basename(configPath)} 无 mcpServers，无需移除`,
        };
      }
      const mcpServers = config.mcpServers as Record<string, unknown>;
      if (!(serverName in mcpServers)) {
        return {
          strategy: 'mcp-json',
          target: configPath,
          success: true,
          message: `mcpServers.${serverName} 不存在，无需移除`,
        };
      }
      delete mcpServers[serverName];
      config.mcpServers = mcpServers;
      this.writeJson(configPath, config);
      return {
        strategy: 'mcp-json',
        target: configPath,
        success: true,
        message: `mcpServers.${serverName} 已移除`,
      };
    } catch (err) {
      return {
        strategy: 'mcp-json',
        target: configPath,
        success: false,
        message: `移除 MCP JSON 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// ─── 模块级私有助手 ─────────────────────────────────────────────────────

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** SDK 默认 awareness 块（与 src/sdk/types.ts 的 DEFAULT_AWARENESS_BLOCK 一致） */
const DEFAULT_SDK_AWARENESS_BLOCK = `# Yondermesh Awareness

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
