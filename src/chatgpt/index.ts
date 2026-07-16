/**
 * ChatGPT Desktop 模块入口（覆盖等级 C —— discovery only）
 *
 * ChatGPT Desktop（Codex 合并版 app）为纯 SaaS，本机无 session 文件。
 * 本模块仅做安装探测 + 注册 source 别名 chatgpt（coverage C）。
 */

export { ChatGptExtractor, detectChatGptDesktop } from './extractor.js';
export type {
  ChatGptDetection,
  ChatGptExtractOptions,
  ChatGptExtractStats,
} from './extractor.js';
