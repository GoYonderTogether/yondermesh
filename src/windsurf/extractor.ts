/**
 * Windsurf session 提取器（覆盖等级 B —— 兼容 importer）
 *
 * Windsurf（Codeium）的 Cascade session 存储格式实测（本机 2026-07）：
 *   - 路径：~/.codeium/windsurf/cascade/<uuid>.pb
 *   - 格式：protobuf，但文件高熵（4096 字节样本含全部 256 种 byte 值），
 *     strings 无可读文本 → 文件已加密 / 强压缩，无 .proto schema 无法直接解析。
 *   - 同目录 ~/.codeium/windsurf/user_settings.pb 则是明文 protobuf（含
 *     "CASCADE_REVERT_TO_STEP" 等可读字符串），证实 .pb 扩展名本身不加密，
 *     仅 cascade session 内容被加密。
 *
 * 采集策略（B 级 fallback）：
 *   - .pb 不可逆向 → 用 12 个 Cascade Hooks 中的 `POST_CASCADE_RESPONSE_WITH_TRANSCRIPT`
 *     （HookAgentAction enum no:12，exa.cortex_pb）作为 A 级采集入口。
 *     该 hook 在每次 Cascade response 后被调用，payload 含完整 transcript。
 *   - hook 命令把 transcript 写到 ymesh 管理的目录：
 *       ~/.yondermesh/windsurf-transcripts/<cascade_id>.json
 *     每个 cascade 一个文件，每次 hook 触发覆盖该文件（含最新完整 transcript）。
 *   - 本提取器扫描该目录，把每个 transcript 文件解析为 ymesh StoredSession 入库。
 *
 * 核心约束（沿用架构 §2 / §4）：
 *   - 只读：绝不写入 Windsurf 私有 .pb / user_settings.pb。
 *   - 身份三元组：device_id + source_instance_id + native_session_id
 *       native_session_id = cascade_id（UUID，从 hook payload 提取）。
 *   - 消息：只取 user/assistant 可显示 text；排除 thinking / tool_use / tool_result。
 *   - 拓扑：Windsurf 当前无 subagent 概念，所有 session 一律 topology=root。
 *   - 幂等：依赖 SessionStore.content_hash 判定；transcript 增量更新产生新 revision。
 *
 * source 别名：windsurf（source-aliases.ts 已注册）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  Coverage,
  MessageRole,
  SessionMessageInput,
} from '../store/types.js';
import type { SessionStore } from '../store/session-store.js';
import { defaultDataDir } from '../daemon/config.js';

/** Windsurf 配置根目录（实测，非 ~/.windsurf） */
export const WINDSURF_CONFIG_DIR = path.join(os.homedir(), '.codeium', 'windsurf');

/** Cascade session .pb 文件目录（加密，本提取器仅做存在性探测） */
export const WINDSURF_CASCADE_DIR = path.join(WINDSURF_CONFIG_DIR, 'cascade');

/** ymesh 管理的 transcript 目录（hook 写入，extractor 读取） */
export const WINDSURF_TRANSCRIPTS_DIR = path.join(
  defaultDataDir(),
  'windsurf-transcripts',
);

/** 导入器选项 */
export interface WindsurfExtractOptions {
  /** 直接指定 transcript 目录，默认 ~/.yondermesh/windsurf-transcripts/ */
  transcriptsDir?: string;
  /** 直接指定 cascade .pb 目录（用于存在性探测 / 未来 .pb 解密），默认 ~/.codeium/windsurf/cascade */
  cascadeDir?: string;
  /** 设备 id，默认 os.hostname() */
  deviceId?: string;
  /** 跳过 .pb 探测（仅用 hook transcript） */
  skipPbProbe?: boolean;
}

/** 导入统计 */
export interface WindsurfExtractStats {
  /** 本次 scan_run id（写入 yondermesh scan_runs） */
  scanRunId: number;
  /** windsurf source instance id */
  sourceInstanceId: string;
  /** 扫描到的 transcript 总数 */
  scanned: number;
  /** 首次创建的 session 数 */
  inserted: number;
  /** 内容变化产生新 revision 的 session 数 */
  updated: number;
  /** 内容幂等未变的 session 数 */
  unchanged: number;
  /** 跳过的 transcript 数（无有效消息 / 脏数据） */
  skipped: number;
  /** 探测到的 .pb 文件数（仅诊断信息，不解析） */
  pbFilesDetected: number;
  /** 是否检测到 .pb 加密（高熵） */
  pbEncrypted: boolean;
}

/** hook 写入的 transcript 文件结构（POST_CASCADE_RESPONSE_WITH_TRANSCRIPT payload） */
interface TranscriptFile {
  /** cascade id（UUID） */
  cascadeId?: string;
  /** 会话标题 */
  title?: string;
  /** workspace 路径（cwd） */
  workspace?: string;
  /** project path */
  projectPath?: string;
  /** 模型名 */
  model?: string;
  /** Windsurf CLI / IDE 版本 */
  cliVersion?: string;
  /** startedAt 毫秒 */
  startedAt?: number;
  /** lastUpdatedAt 毫秒 */
  lastUpdatedAt?: number;
  /** 消息列表（user/assistant） */
  messages?: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp?: number;
  }>;
}

/** 把未知错误归一化为消息字符串 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 安全 JSON.parse：失败返回 undefined */
function safeJsonParse<T = unknown>(s: string | undefined | null): T | undefined {
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

/**
 * 探测 .pb 文件是否加密。
 * 判据：取前 4KB，统计 unique byte 数。明文 protobuf 含大量可读 ASCII，
 * unique bytes 通常 < 200；加密 / 强压缩数据 unique bytes 接近 256。
 */
function probePbEncrypted(pbDir: string): { count: number; encrypted: boolean } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pbDir, { withFileTypes: true });
  } catch {
    return { count: 0, encrypted: false };
  }
  const pbFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.pb'));
  if (pbFiles.length === 0) return { count: 0, encrypted: false };

  // 取第一个 .pb 探测
  const samplePath = path.join(pbDir, pbFiles[0]!.name);
  try {
    const buf = Buffer.alloc(4096);
    const fdNum = fs.openSync(samplePath, 'r');
    const bytesRead = fs.readSync(fdNum, buf, 0, 4096, 0);
    fs.closeSync(fdNum);
    const slice = buf.subarray(0, bytesRead);
    const unique = new Set(slice).size;
    return { count: pbFiles.length, encrypted: unique > 200 };
  } catch {
    return { count: pbFiles.length, encrypted: false };
  }
}

/**
 * 解析单个 transcript 文件，返回 ParsedSession。
 * 文件结构由 wrapper.ts 的 handleWindsurfHookEvent 写入，字段见 TranscriptFile。
 */
interface ParsedTranscript {
  cascadeId: string;
  title?: string;
  cwd?: string;
  projectPath?: string;
  model?: string;
  cliVersion?: string;
  startedAt?: number;
  lastUpdatedAt?: number;
  messages: SessionMessageInput[];
}

function parseTranscriptFile(filePath: string): ParsedTranscript | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const data = safeJsonParse<TranscriptFile>(raw);
  if (!data) return null;

  // cascadeId 缺失 → 用文件名（去 .json）作为回退 id
  const fallbackId = path.basename(filePath, '.json');
  const cascadeId = data.cascadeId && data.cascadeId.length > 0 ? data.cascadeId : fallbackId;

  const messages: SessionMessageInput[] = [];
  if (Array.isArray(data.messages)) {
    for (const m of data.messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const content = typeof m.content === 'string' ? m.content : '';
      if (content.trim().length === 0) continue;
      messages.push({
        role: m.role as MessageRole,
        content,
        timestamp: typeof m.timestamp === 'number' ? m.timestamp : undefined,
      });
    }
  }

  return {
    cascadeId,
    title: data.title,
    cwd: data.workspace,
    projectPath: data.projectPath,
    model: data.model,
    cliVersion: data.cliVersion,
    startedAt: data.startedAt,
    lastUpdatedAt: data.lastUpdatedAt,
    messages,
  };
}

/**
 * Windsurf 提取器。
 *
 * 用法：
 *   const extractor = new WindsurfExtractor(store, { transcriptsDir });
 *   const stats = extractor.extract();
 */
export class WindsurfExtractor {
  constructor(
    private readonly store: SessionStore,
    private readonly options: WindsurfExtractOptions = {},
  ) {}

  /** 执行一次完整提取，返回统计并写 scan_runs */
  extract(): WindsurfExtractStats {
    const transcriptsDir = this.options.transcriptsDir ?? WINDSURF_TRANSCRIPTS_DIR;
    const cascadeDir = this.options.cascadeDir ?? WINDSURF_CASCADE_DIR;
    const deviceId = this.options.deviceId ?? os.hostname();

    // 1. 注册 coverage=B 的 windsurf source instance
    const instance = this.store.registerSourceInstance({
      deviceId,
      source: 'windsurf',
      rootPath: transcriptsDir,
      coverage: 'B' as Coverage,
    });

    // 2. 开始 scan_run
    const runId = this.store.startScanRun({
      sourceInstanceId: instance.id,
      deviceId,
    });

    try {
      const counts = this.doExtract(transcriptsDir, cascadeDir, instance.id, deviceId);
      this.store.finishScanRun(runId, {
        status: 'completed',
        sessionsSeen: counts.scanned,
        sessionsNew: counts.inserted,
        sessionsUpdated: counts.updated,
      });
      return { scanRunId: runId, sourceInstanceId: instance.id, ...counts };
    } catch (err) {
      try {
        this.store.finishScanRun(runId, { status: 'failed', error: errorMessage(err) });
      } catch {
        /* 不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 实际提取逻辑 */
  private doExtract(
    transcriptsDir: string,
    cascadeDir: string,
    sourceInstanceId: string,
    deviceId: string,
  ): Omit<WindsurfExtractStats, 'scanRunId' | 'sourceInstanceId'> {
    // 1. 探测 .pb 是否加密（仅诊断，不影响 transcript 提取）
    let pbFilesDetected = 0;
    let pbEncrypted = false;
    if (!this.options.skipPbProbe) {
      const probe = probePbEncrypted(cascadeDir);
      pbFilesDetected = probe.count;
      pbEncrypted = probe.encrypted;
    }

    // 2. 扫描 transcript 目录
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch {
      // 目录不存在 → 无 transcript 可提取（hook 未触发过）
      return {
        scanned: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        pbFilesDetected,
        pbEncrypted,
      };
    }

    let scanned = 0;
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    // 3. 逐文件解析 + 入库（按文件名字典序，保证确定性）
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();

    for (const name of files) {
      scanned++;
      const parsed = parseTranscriptFile(path.join(transcriptsDir, name));
      if (!parsed || parsed.messages.length === 0) {
        skipped++;
        continue;
      }
      const result = this.store.ingestSession({
        deviceId,
        sourceInstanceId,
        nativeSessionId: parsed.cascadeId,
        source: 'windsurf',
        cwd: parsed.cwd,
        projectPath: parsed.projectPath,
        startedAt: parsed.startedAt,
        topology: 'root',
        sourceKind: 'B',
        messages: parsed.messages,
        model: parsed.model,
        cliVersion: parsed.cliVersion,
        // Windsurf 通过 hook 采集，记录采集入口
        entrySource: 'post_cascade_response_with_transcript',
      });
      if (result.created) inserted++;
      else if (result.newRevision) updated++;
      else unchanged++;
    }

    return {
      scanned,
      inserted,
      updated,
      unchanged,
      skipped,
      pbFilesDetected,
      pbEncrypted,
    };
  }
}
