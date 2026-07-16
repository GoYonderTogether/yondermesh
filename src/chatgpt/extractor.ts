/**
 * ChatGPT Desktop session 探测器（覆盖等级 C —— discovery only）
 *
 * ChatGPT Desktop（实为 Codex 合并版 app，bundle id com.openai.codex，
 * v26.707.71524）是纯 SaaS：session 数据在服务端，本机无任何结构化 session 文件。
 *
 * 本机探测结论（2026-07 实测）：
 *   - /Applications/ChatGPT.app                       ✅ 存在（Codex 合并版）
 *   - ~/Library/Application Support/ChatGPT/          ❌ 不存在
 *   - ~/Library/Containers/com.openai.chat/           ❌ 不存在
 *   - ~/Library/Application Support/com.openai.chat/  仅 app_pairing_extensions
 *                                                      （浏览器配对，非 session）
 *   - ~/Library/Caches/                              ❌ 无 chat 相关
 *   - URL scheme chatgpt://                           存在但仅用于 deeplink，不暴露 session
 *
 * 因此 ChatGPT Desktop 标记为 C 级不可采集：仅注册 source 别名（chatgpt），
 * 在 mesh 中登记一个 coverage=C / presence=missing 的 source instance，
 * 让用户知道「这个 agent 存在但本机采不到 session」。
 *
 * D1-D10：D1❌ D2C D3⚠️(仅HTTPS) D4❌ D5❌ D6❌ D7❌ D8❌ D9⚠️ D10⚠️
 * GLM-5.2 ❌：SaaS 仅用 OpenAI 自家模型。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Coverage } from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';

/** macOS ChatGPT.app 安装路径 */
const CHATGPT_APP_PATH = '/Applications/ChatGPT.app';
/** 可能的本地数据目录候选（逐一探测，确认是否有 session 痕迹） */
const LOCAL_DATA_CANDIDATES = [
  path.join(os.homedir(), 'Library', 'Application Support', 'ChatGPT'),
  path.join(os.homedir(), 'Library', 'Application Support', 'com.openai.chat'),
  path.join(os.homedir(), 'Library', 'Application Support', 'com.openai.codex'),
  path.join(os.homedir(), 'Library', 'Containers', 'com.openai.chat'),
  path.join(os.homedir(), 'Library', 'Containers', 'com.openai.codex'),
  path.join(os.homedir(), 'Library', 'Caches', 'com.openai.chat'),
];

/** 探测结果 */
export interface ChatGptDetection {
  /** app 是否安装 */
  appInstalled: boolean;
  /** app bundle 路径（若安装） */
  appPath: string | null;
  /** 探测到的本地数据目录列表（均不含 session 数据） */
  localDataDirs: string[];
  /** 是否发现任何本地 session 痕迹（实测恒为 false） */
  hasLocalSessionData: boolean;
  /** 覆盖等级：恒为 C（discovery only） */
  coverage: Coverage;
  /** 不可采集原因 */
  reason: string;
}

/** 选项 */
export interface ChatGptExtractOptions {
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 显式指定 app 路径（默认 /Applications/ChatGPT.app） */
  appPath?: string;
}

/** 探测结果统计（extract 返回） */
export interface ChatGptExtractStats {
  /** chatgpt source instance id（若传入了 store 则注册） */
  sourceInstanceId: string | null;
  /** app 是否安装 */
  appInstalled: boolean;
  /** 覆盖等级：C */
  coverage: Coverage;
  /** 提取到的 session 数（恒为 0） */
  sessionsExtracted: number;
  /** 不可采集原因 */
  reason: string;
}

/**
 * 探测本机 ChatGPT Desktop 安装与本地数据痕迹。
 * 纯只读，绝不写入 app 数据。导出以便测试。
 */
export function detectChatGptDesktop(appPath: string = CHATGPT_APP_PATH): ChatGptDetection {
  let appInstalled = false;
  try {
    appInstalled = fs.statSync(appPath).isDirectory();
  } catch {
    appInstalled = false;
  }

  const localDataDirs: string[] = [];
  let hasLocalSessionData = false;
  for (const dir of LOCAL_DATA_CANDIDATES) {
    try {
      const st = fs.statSync(dir);
      if (st.isDirectory()) {
        localDataDirs.push(dir);
        // 检查目录内是否有疑似 session 文件（.jsonl / .json / .db / conversations）
        const entries = fs.readdirSync(dir);
        const sessionLike = entries.find((e) =>
          /\.(jsonl|db|sqlite)$/.test(e) ||
          /conversation|session|history/i.test(e),
        );
        if (sessionLike) hasLocalSessionData = true;
      }
    } catch {
      /* 该候选目录不存在 → 跳过 */
    }
  }

  // app_pairing_extensions 是浏览器配对，非 session —— 实测排除
  const reason = hasLocalSessionData
    ? '发现疑似本地数据（需人工确认）'
    : 'ChatGPT Desktop 为纯 SaaS：session 在服务端存储，本机无结构化 session 文件';

  return {
    appInstalled,
    appPath: appInstalled ? appPath : null,
    localDataDirs,
    hasLocalSessionData,
    coverage: 'C',
    reason,
  };
}

/**
 * ChatGPT Desktop 提取器（C 级 placeholder）。
 *
 * 不提取任何 session（本机确实没有）。若传入 store，则注册一个 coverage=C /
 * presence=missing 的 chatgpt source instance，让 mesh 知道该 agent 存在但不可采集。
 */
export class ChatGptExtractor {
  constructor(
    private readonly store?: SessionStore,
    private readonly options: ChatGptExtractOptions = {},
  ) {}

  /** 执行探测 + （可选）登记 source instance */
  extract(): ChatGptExtractStats {
    const detection = detectChatGptDesktop(this.options.appPath ?? CHATGPT_APP_PATH);
    let sourceInstanceId: string | null = null;

    if (this.store && detection.appInstalled) {
      // 仅注册 source alias（coverage C，presence=missing），不 ingest 任何 session
      const instance = this.store.registerSourceInstance({
        deviceId: this.options.deviceId ?? os.hostname(),
        source: 'chatgpt',
        rootPath: detection.appPath ?? undefined,
        coverage: 'C',
      });
      sourceInstanceId = instance.id;
    }

    return {
      sourceInstanceId,
      appInstalled: detection.appInstalled,
      coverage: 'C',
      sessionsExtracted: 0,
      reason: detection.reason,
    };
  }
}
