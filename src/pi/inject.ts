/**
 * Pi Agent 家族配置注入（Pi / oh-my-pi / gsd-pi 通用）
 *
 * 把 yondermesh 的扩展能力注入三个 CLI 的配置目录：
 *   - MCP：合并 mcpServers 到 <configDir>/mcp.json（保留各 flavor 的额外字段）
 *   - Skills：symlink skill 目录到 <configDir>/skills/（与 install/skill-linker 同模式）
 *   - AGENTS.md：写 always-on 指令（configDir 全局级 + 项目 cwd 级）
 *   - Hooks：写 Extension 事件系统配置（omp 有 hooks/；pi/gsd 走 extensions registry）
 *   - pi-mcp-adapter：检测已安装的 pi-mcp-adapter（pi 的 npm 依赖），自动导入 MCP 配置
 *
 * 三个 flavor 的配置目录：
 *   pi     → ~/.pi/agent/
 *   omp    → ~/.omp/agent/
 *   gsd-pi → ~/.gsd/agent/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePiFlavors, resolveFlavorSessionsDir, type PiFlavorConfig } from './importer.js';

/** MCP server 定义（mcpServers 格式，与 cursor/claude-code 一致） */
export interface McpServerDef {
  /** 传输类型：stdio（默认）/ sse / http */
  type?: 'stdio' | 'sse' | 'http';
  /** 启动命令 */
  command?: string;
  /** 命令参数 */
  args?: string[];
  /** 环境变量 */
  env?: Record<string, string>;
  /** sse/http 的 URL */
  url?: string;
  [key: string]: unknown;
}

/** MCP 配置文件结构（合并后写入） */
export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
  /** pi 的导入源（cursor/claude-code/claude-desktop） */
  imports?: string[];
  [key: string]: unknown;
}

/** 注入结果 */
export interface PiInjectResult {
  /** flavor source */
  source: string;
  /** cli 名 */
  cli: string;
  /** 各注入项的执行结果 */
  mcp?: { written: boolean; servers: string[]; file: string };
  skills?: { linked: string[]; skipped: string[]; dir: string };
  agentsMd?: { written: boolean; file: string };
  hooks?: { written: boolean; file: string };
  adapter?: { detected: boolean; imported: string[]; version?: string };
}

/** 注入器选项 */
export interface PiInjectorOptions {
  /** flavor 配置覆盖（默认本机探测） */
  flavors?: PiFlavorConfig[];
}

/**
 * Pi Agent 家族配置注入器。
 *
 *   const inj = new PiInjector();
 *   await inj.injectMcp('pi', { 'ymesh': { command: 'ymesh', args: ['mcp'] } });
 *   inj.injectSkills('omp', '/path/to/skills');
 *   inj.injectAgentsMd('gsd-pi', '# Always-on\n...');
 */
export class PiInjector {
  private readonly flavors: PiFlavorConfig[];

  constructor(options: PiInjectorOptions = {}) {
    this.flavors = (options.flavors ?? resolvePiFlavors()).map((f) => ({
      ...f,
      sessionsDir: resolveFlavorSessionsDir(f),
    }));
  }

  /** 按 source 或 cli 名查 flavor */
  flavorOf(sourceOrCli: string): PiFlavorConfig | undefined {
    return this.flavors.find(
      (f) => f.source === sourceOrCli || f.cli === sourceOrCli,
    );
  }

  // ─── MCP 注入 ──────────────────────────────────────────────────────────

  /**
   * 合并 mcpServers 到 <configDir>/mcp.json。
   * 保留现有 servers 与各 flavor 的额外字段（pi 的 imports / omp 的 $schema）。
   * 已存在的同名 server 会被覆盖（调用方语义：显式覆盖）。
   */
  injectMcp(
    sourceOrCli: string,
    servers: Record<string, McpServerDef>,
  ): PiInjectResult['mcp'] & { source: string; cli: string } {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);
    const file = path.join(flavor.configDir, 'mcp.json');

    fs.mkdirSync(flavor.configDir, { recursive: true });
    const existing = this.readMcpConfig(file);
    const merged: McpConfig = {
      ...existing,
      mcpServers: { ...existing.mcpServers, ...servers },
    };
    this.writeJson(file, merged);
    return {
      source: flavor.source,
      cli: flavor.cli,
      written: true,
      servers: Object.keys(merged.mcpServers),
      file,
    };
  }

  /** 读取 mcp.json（不存在或损坏返回空骨架） */
  readMcpConfig(file: string): McpConfig {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const obj = JSON.parse(raw) as Partial<McpConfig>;
      return {
        ...obj,
        mcpServers: obj.mcpServers ?? {},
      };
    } catch {
      return { mcpServers: {} };
    }
  }

  // ─── Skills 注入 ───────────────────────────────────────────────────────

  /**
   * 把 sourceSkillsDir 下每个子目录 symlink 到 <configDir>/skills/<name>。
   * 已存在的 symlink 跳过（除非 force=true，则重建）。
   */
  injectSkills(
    sourceOrCli: string,
    sourceSkillsDir: string,
    options: { force?: boolean } = {},
  ): PiInjectResult['skills'] & { source: string; cli: string } {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);
    const targetDir = path.join(flavor.configDir, 'skills');
    fs.mkdirSync(targetDir, { recursive: true });

    const linked: string[] = [];
    const skipped: string[] = [];

    if (!fs.existsSync(sourceSkillsDir)) {
      return {
        source: flavor.source,
        cli: flavor.cli,
        linked,
        skipped: [`源 skills 目录不存在: ${sourceSkillsDir}`],
        dir: targetDir,
      };
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sourceSkillsDir, { withFileTypes: true });
    } catch (e) {
      return {
        source: flavor.source,
        cli: flavor.cli,
        linked,
        skipped: [`读取源 skills 目录失败: ${errorMessage(e)}`],
        dir: targetDir,
      };
    }

    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const name = e.name;
      const src = path.join(sourceSkillsDir, name);
      const dst = path.join(targetDir, name);
      try {
        if (fs.existsSync(dst) || fs.existsSync(dst + '.md')) {
          if (options.force) {
            fs.rmSync(dst, { recursive: true, force: true });
          } else {
            skipped.push(`${name} 已存在`);
            continue;
          }
        }
        fs.symlinkSync(src, dst);
        linked.push(name);
      } catch (e) {
        skipped.push(`${name}: ${errorMessage(e)}`);
      }
    }

    return {
      source: flavor.source,
      cli: flavor.cli,
      linked,
      skipped,
      dir: targetDir,
    };
  }

  // ─── AGENTS.md 注入 ────────────────────────────────────────────────────

  /**
   * 写 AGENTS.md（always-on 指令）。
   *   - target='global'（默认）：写到 <configDir>/AGENTS.md（全局 always-on）
   *   - target='project'：写到 <cwd>/AGENTS.md（项目级）
   *   - target='both'：两处都写
   */
  injectAgentsMd(
    sourceOrCli: string,
    content: string,
    options: { target?: 'global' | 'project' | 'both'; cwd?: string } = {},
  ): PiInjectResult['agentsMd'] & { source: string; cli: string; projectFile?: string } {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);
    const target = options.target ?? 'global';
    const cwd = options.cwd ?? process.cwd();

    let globalFile: string | undefined;
    let projectFile: string | undefined;
    if (target === 'global' || target === 'both') {
      fs.mkdirSync(flavor.configDir, { recursive: true });
      globalFile = path.join(flavor.configDir, 'AGENTS.md');
      fs.writeFileSync(globalFile, content, 'utf8');
    }
    if (target === 'project' || target === 'both') {
      projectFile = path.join(cwd, 'AGENTS.md');
      fs.writeFileSync(projectFile, content, 'utf8');
    }
    return {
      source: flavor.source,
      cli: flavor.cli,
      written: true,
      file: globalFile ?? projectFile!,
      projectFile,
    };
  }

  // ─── Hook 注入（Extension 事件系统） ───────────────────────────────────

  /**
   * 写 Extension 事件系统 hook 配置。
   *   - omp：写到 <configDir>/hooks/<name>.ts（omp 实测有 hooks/ 目录）
   *   - pi/gsd：写到 <configDir>/extensions/<name>.json（extensions registry）
   * 配置体为 hooks 定义对象（事件名 → 处理器描述），由调用方提供。
   */
  injectHooks(
    sourceOrCli: string,
    name: string,
    hooksConfig: object,
  ): PiInjectResult['hooks'] & { source: string; cli: string } {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);

    let file: string;
    // omp 有独立 hooks/ 目录；pi/gsd 用 extensions/ registry
    if (flavor.cli === 'omp') {
      const dir = path.join(flavor.configDir, 'hooks');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${name}.json`);
      this.writeJson(file, hooksConfig);
    } else {
      const dir = path.join(flavor.configDir, 'extensions');
      fs.mkdirSync(dir, { recursive: true });
      file = path.join(dir, `${name}.json`);
      this.writeJson(file, hooksConfig);
    }
    return {
      source: flavor.source,
      cli: flavor.cli,
      written: true,
      file,
    };
  }

  // ─── pi-mcp-adapter 集成 ───────────────────────────────────────────────

  /**
   * 检测 pi-mcp-adapter 并自动导入 MCP 配置。
   * pi-mcp-adapter 是 pi 的 npm 依赖（实测 ~/.pi/agent/npm/node_modules/pi-mcp-adapter ^2.11.0），
   * 它把 cursor/claude-code/claude-desktop 的 MCP 配置适配进 pi。
   *
   * 本方法：
   *   1. 检测 <configDir>/npm/node_modules/pi-mcp-adapter 是否存在
   *   2. 若存在，确保 mcp.json 的 imports 包含已知源（cursor/claude-code/claude-desktop）
   *   3. 返回检测与导入结果
   *
   * 对 omp/gsd（无 npm 子目录）返回 detected=false。
   */
  importMcpFromAdapter(
    sourceOrCli: string,
  ): PiInjectResult['adapter'] & { source: string; cli: string } {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);

    const adapterDir = path.join(flavor.configDir, 'npm', 'node_modules', 'pi-mcp-adapter');
    const pkgJson = path.join(adapterDir, 'package.json');
    let version: string | undefined;
    let detected = false;
    try {
      if (fs.statSync(adapterDir).isDirectory()) {
        detected = true;
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { version?: string };
          version = pkg.version;
        } catch {
          /* 忽略 package.json 读取失败 */
        }
      }
    } catch {
      detected = false;
    }

    const imported: string[] = [];
    if (detected) {
      // 确保 mcp.json 的 imports 包含 adapter 支持的源
      const mcpFile = path.join(flavor.configDir, 'mcp.json');
      const cfg = this.readMcpConfig(mcpFile);
      const knownSources = ['cursor', 'claude-code', 'claude-desktop'];
      const imports = new Set(cfg.imports ?? []);
      let changed = false;
      for (const s of knownSources) {
        if (!imports.has(s)) {
          imports.add(s);
          imported.push(s);
          changed = true;
        }
      }
      if (changed) {
        cfg.imports = [...imports];
        this.writeJson(mcpFile, cfg);
      }
    }

    return {
      source: flavor.source,
      cli: flavor.cli,
      detected,
      imported,
      version,
    };
  }

  // ─── 一键注入 ──────────────────────────────────────────────────────────

  /**
   * 一键向指定 flavor 注入全部能力（MCP + Skills + AGENTS.md + adapter）。
   * hooks 因需定制内容不在此批量注入。
   */
  injectAll(
    sourceOrCli: string,
    options: {
      mcpServers?: Record<string, McpServerDef>;
      skillsDir?: string;
      agentsMd?: string;
      agentsMdTarget?: 'global' | 'project' | 'both';
      cwd?: string;
    } = {},
  ): PiInjectResult {
    const flavor = this.flavorOf(sourceOrCli);
    if (!flavor) throw new Error(`未知 Pi flavor / cli: ${sourceOrCli}`);
    const result: PiInjectResult = { source: flavor.source, cli: flavor.cli };

    if (options.mcpServers) {
      const { source, cli, ...rest } = this.injectMcp(sourceOrCli, options.mcpServers);
      result.mcp = rest;
    }
    if (options.skillsDir) {
      const { source, cli, ...rest } = this.injectSkills(sourceOrCli, options.skillsDir);
      result.skills = rest;
    }
    if (options.agentsMd) {
      const { source, cli, projectFile, ...rest } = this.injectAgentsMd(
        sourceOrCli,
        options.agentsMd,
        { target: options.agentsMdTarget, cwd: options.cwd },
      );
      result.agentsMd = rest;
    }
    const { source, cli, ...adapter } = this.importMcpFromAdapter(sourceOrCli);
    result.adapter = adapter;
    return result;
  }

  // ─── 内部 ──────────────────────────────────────────────────────────────

  /** 写 JSON（格式化） */
  private writeJson(file: string, obj: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
