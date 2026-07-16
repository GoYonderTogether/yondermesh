/**
 * Kimi Wire 协议注入器 —— 杀手级中途介入能力
 *
 * Kimi 的 Wire 协议 JSONRPCSteerMessage 是独有的"中途注入"能力：
 * 在 agent 正在执行 turn 时，可发送 steering 消息中断/引导当前执行。
 * 这比 OpenClaw 的 CLI 链式注入更强——CLI 链是启动时注入，Wire 是运行时注入。
 *
 * 本模块封装两种注入策略：
 *
 *   1. Wire 中途注入（JSONRPCSteerMessage）：通过 ACP 服务器向运行中 session
 *      发送 steer 消息，可中断当前 turn 或追加上下文。这是真正的"中途介入"。
 *
 *   2. CLI 链式注入（替代 MCP/Skill/Always-on）：与 OpenClaw 类似，通过
 *      kimi -w <dir> --session <id> -m <prompt> 在启动时注入系统提示词 + skill。
 *      替代 MCP（工具描述）、Skill（SKILL.md 内容）、Always-on（系统提示词前缀）。
 *
 * 组合：launchWithInjection() 在启动时通过 CLI 链注入完整上下文，
 *       injectSteer() 在运行中通过 Wire 协议中途追加指令。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KimiController } from './wrapper.js';

/** 注入器选项 */
export interface KimiInjectorOptions {
  /** CLI 可执行路径，默认 kimi */
  cliBin?: string;
  /** 系统提示词前缀（替代 Always-on） */
  systemPrompt?: string;
  /** skill 文件路径列表（替代 Skill 挂载） */
  skillFiles?: string[];
}

/** launch 注入结果 */
export interface KimiInjectionResult {
  /** session id */
  sessionId: string;
  /** 注入通道 */
  channel: 'cli';
  /** 实际注入的 prompt 长度 */
  injectedPromptLength: number;
  /** 注入的 skill 文件数 */
  skillsInjected: number;
  /** 是否注入了系统提示词 */
  systemPromptInjected: boolean;
  /** agent 回复 */
  reply?: string;
}

/** steer 注入结果 */
export interface SteerInjectionResult {
  /** session id */
  sessionId: string;
  /** 注入通道：acp（Wire 协议）或 cli（降级） */
  channel: 'acp' | 'cli';
  /** 是否成功 */
  ok: boolean;
  /** 是否中断了当前 turn */
  interrupted: boolean;
}

/**
 * Kimi Wire 协议注入器。
 *
 * 用法：
 *   const injector = new KimiWireInjector(ctrl, {
 *     systemPrompt: "你是 yondermesh 节点...",
 *     skillFiles: ["~/.agents/skills/foo/SKILL.md"],
 *   });
 *   // 启动时注入（CLI 链，替代 MCP/Skill/Always-on）
 *   const { sessionId } = await injector.launchWithInjection("执行任务", "/work/dir");
 *   // 运行中注入（Wire 协议，杀手级中途介入）
 *   await injector.injectSteer(sessionId, "改用方案 B", { interrupt: true });
 */
export class KimiWireInjector {
  private readonly systemPrompt: string;
  private readonly skillFiles: string[];
  private readonly controller: KimiController;

  constructor(controller: KimiController, options: KimiInjectorOptions = {}) {
    this.controller = controller;
    this.systemPrompt = options.systemPrompt ?? '';
    this.skillFiles = options.skillFiles ?? [];
  }

  /**
   * 构建完整注入 prompt：系统提示词 + skill 内容 + 用户 prompt。
   * CLI 链式注入核心——替代 MCP+Skill+Always-on。
   */
  buildLaunchedPrompt(userPrompt: string): {
    prompt: string;
    skillsInjected: number;
    systemPromptInjected: boolean;
  } {
    const parts: string[] = [];
    let skillsInjected = 0;
    let systemPromptInjected = false;

    // 1. 系统提示词（替代 Always-on）
    if (this.systemPrompt.length > 0) {
      parts.push(this.formatBlock('SYSTEM CONTEXT (always-on equivalent)', this.systemPrompt));
      systemPromptInjected = true;
    }

    // 2. Skill 内容（替代 Skill 挂载）
    for (const skillFile of this.skillFiles) {
      const content = this.readSkillFile(skillFile);
      if (content) {
        parts.push(this.formatBlock(`SKILL: ${path.basename(path.dirname(skillFile))}`, content));
        skillsInjected++;
      }
    }

    // 3. 用户 prompt
    parts.push(userPrompt);

    return {
      prompt: parts.join('\n\n---\n\n'),
      skillsInjected,
      systemPromptInjected,
    };
  }

  /**
   * 带注入的 launch：构建完整 prompt 后通过 controller 启动。
   * 等效于 MCP+Skill+Always-on 组合挂载后启动 session。
   */
  async launchWithInjection(userPrompt: string, workDir: string): Promise<KimiInjectionResult> {
    const { prompt, skillsInjected, systemPromptInjected } = this.buildLaunchedPrompt(userPrompt);
    const result = await this.controller.launch(prompt, workDir);
    return {
      sessionId: result.sessionId,
      channel: 'cli',
      injectedPromptLength: prompt.length,
      skillsInjected,
      systemPromptInjected,
      reply: result.reply,
    };
  }

  /**
   * Wire 协议中途注入（杀手级能力）。
   * 通过 JSONRPCSteerMessage 向运行中 session 发送 steering 消息：
   *   - interrupt=true：中断当前 turn，agent 会立即处理注入的消息
   *   - interrupt=false：追加上下文，agent 在当前 turn 完成后可见
   *
   * ACP 不可用时降级到 CLI 新 turn（非中途介入，但仍可传递消息）。
   */
  async injectSteer(
    sessionId: string,
    message: string,
    options: { interrupt?: boolean } = {},
  ): Promise<SteerInjectionResult> {
    const interrupted = options.interrupt ?? false;
    const result = await this.controller.inject(sessionId, message, { interrupt: interrupted });
    return {
      sessionId,
      channel: result.channel,
      ok: result.ok,
      interrupted,
    };
  }

  /**
   * 验证 CLI 链式注入是否等效 MCP/Skill。
   * 构造测试 prompt，检查注入内容是否正确拼接。
   */
  verifyEquivalence(): { systemPromptInPrompt: boolean; skillInPrompt: boolean; ok: boolean } {
    const { prompt, systemPromptInjected } = this.buildLaunchedPrompt('[ymesh-verify] test');
    const testSkillFile = this.skillFiles[0];
    const systemPromptInPrompt = !systemPromptInjected || prompt.includes(this.systemPrompt);
    const skillContent = testSkillFile ? this.readSkillFile(testSkillFile) : null;
    const skillInPrompt = !testSkillFile || (skillContent !== null && prompt.includes(skillContent));
    return {
      systemPromptInPrompt,
      skillInPrompt,
      ok: systemPromptInPrompt && skillInPrompt,
    };
  }

  // ─── 辅助 ────────────────────────────────────────────────────────────

  /** 读取 skill 文件内容，失败返回 null */
  private readSkillFile(filePath: string): string | null {
    const resolved = filePath.replace(/^~(?=$|\/|\\)/, process.env.HOME ?? '');
    try {
      const content = fs.readFileSync(resolved, 'utf8');
      return content.trim().length > 0 ? content.trim() : null;
    } catch {
      return null;
    }
  }

  /** 格式化为带标题的注入块 */
  private formatBlock(title: string, content: string): string {
    return `<<<${title}>>>\n${content}\n<<</${title}>>>`;
  }
}
