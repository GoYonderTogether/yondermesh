/**
 * yondermesh — 自托管 Agent 上下文总线
 *
 * 让用户所有设备上、所有 CLI 里的 AI agent 共享同一份工作现场：
 * 互相看见、互相查询、互相接力。
 */

// Session Store（LOOP-001）
export { SessionStore, SCHEMA } from './store/index.js';
export type {
  Coverage,
  IngestResult,
  MessageRole,
  Presence,
  RelationType,
  Relationship,
  RelationshipInput,
  RevisionRecord,
  Retention,
  ScanRun,
  ScanRunFinishInput,
  ScanRunStartInput,
  SessionIngestInput,
  SessionMessage,
  SessionQuery,
  SessionStats,
  SessionRecord,
  SessionTopology,
  SourceInstance,
  SourceInstanceInput,
} from './store/index.js';

// cass 历史导入（LOOP-002，覆盖等级 B）
export { CassImporter, resolveCassDbPath } from './cass/index.js';
export type { CassImportOptions, CassImportStats } from './cass/index.js';

// Claude Code 原生 adapter（LOOP-003，覆盖等级 A）
export { ClaudeCodeImporter, resolveClaudeProjectsPath } from './claude/index.js';
export type { ClaudeImportOptions, ClaudeImportStats } from './claude/index.js';

// Codex 原生 adapter（LOOP-004，覆盖等级 A）
export { CodexImporter, resolveCodexSessionsPath } from './codex/index.js';
export type { CodexImportOptions, CodexImportStats } from './codex/index.js';

// Aider markdown importer（覆盖等级 B）+ wrapper + inject
export { AiderImporter, parseAiderMarkdown, AIDER_HISTORY_FILENAME } from './aider/index.js';
export { buildAiderCommand, GLM_MODEL_ARG } from './aider/index.js';
export {
  buildReadArgs,
  buildConventionsReadArgs,
  detectConventionFiles,
  generateAiderConfYml,
} from './aider/index.js';
export type {
  AiderImportOptions,
  AiderImportStats,
  ParsedAiderSession,
  BuildAiderCommandOptions,
  AiderCommand,
} from './aider/index.js';

// Amp SaaS importer（覆盖等级 B / 降级 C）+ wrapper + inject
export {
  AmpImporter,
  parseAmpExport,
  parseAmpThreadLog,
  AMP_AUTH_HELPER,
} from './amp/index.js';
export {
  buildAmpListCommand,
  buildAmpExportCommand,
  buildAmpMarkdownCommand,
  buildAmpNewThreadCommand,
  buildAmpContinueCommand,
} from './amp/index.js';
export {
  generateAmpMcpConfig,
  generateAmpMcpInline,
  generateAmpAgentsMd,
  generateAmpPluginHook,
  detectGlobalAgentsMd,
} from './amp/index.js';
export type {
  AmpImportOptions,
  AmpImportStats,
  AmpCommandRunner,
  ParsedAmpThread,
  AmpGlobalOptions,
} from './amp/index.js';

// ChatGPT Desktop extractor（覆盖等级 C —— discovery only）
export { ChatGptExtractor, detectChatGptDesktop } from './chatgpt/index.js';
export type {
  ChatGptDetection,
  ChatGptExtractOptions,
  ChatGptExtractStats,
} from './chatgpt/index.js';

// trae-cli trajectory importer（覆盖等级 B）+ wrapper + inject
export { TraeCliImporter, parseTrajectory } from './trae-cli/index.js';
export {
  buildTraeCliRunCommand,
  buildTraeCliInteractiveCommand,
} from './trae-cli/index.js';
export {
  generateTraeCliConfig,
  generateTraeCliConfigWithYondermesh,
  generateTraeSystemPrompt,
} from './trae-cli/index.js';
export type {
  TraeCliImportOptions,
  TraeCliImportStats,
  ParsedTrajectory,
  BuildTraeCliRunOptions,
  TraeCliCommand,
} from './trae-cli/index.js';

// Session Bridge —— 有限 agent session 转交器（Aider/Amp/ChatGPT/trae-cli → 中性 JSONL）
export {
  toNeutralMessages,
  toNeutralJsonl,
  parseNeutralJsonl,
  buildHandoffPrompt,
  convertSession,
} from './limited/session-bridge.js';
export type { NeutralMessage, SessionData, LimitedSourceCli } from './limited/session-bridge.js';

// Copilot CLI / SDK 原生 adapter（覆盖等级 A）
export {
  CopilotImporter,
  resolveCopilotHomePath,
  resolveCopilotSessionStatePath,
  COPILOT_HOOK_TYPES,
  COPILOT_EVENT_TYPES,
} from './copilot/index.js';
export type {
  CopilotImportOptions,
  CopilotImportStats,
  CopilotHookType,
  CopilotEventType,
  CopilotWrapperOptions,
  CopilotSessionListItem,
  CopilotLaunchResult,
  CopilotStreamCallbacks,
  CopilotSessionExtract,
  CopilotInjectOptions,
  CopilotMcpServerDef,
  CopilotSkillDef,
  CopilotHookDef,
  CopilotAlwaysOnDef,
  CopilotInjectResult,
} from './copilot/index.js';
export {
  CopilotWrapper,
  CopilotInjector,
  createCopilotWrapper,
  createCopilotInjector,
  getDefaultCopilotWrapper,
  defaultYondermeshAwarenessBlock,
} from './copilot/index.js';

// OpenClaw 原生 adapter（覆盖等级 A，CLI 链式注入）
export { OpenClawImporter, resolveOpenClawPath, OpenClawController, CliChainInjector } from './openclaw/index.js';
export type {
  OpenClawImportOptions,
  OpenClawImportStats,
  OpenClawControllerOptions,
  LaunchResult,
  StreamEvent,
  TransferredSession,
  CliChainInjectorOptions,
  InjectionResult,
} from './openclaw/index.js';

// Kimi 原生 adapter（覆盖等级 A，Wire 协议中途注入）
export { KimiImporter, resolveKimiPath, KimiController, KimiWireInjector } from './kimi/index.js';
export type {
  KimiImportOptions,
  KimiImportStats,
  KimiControllerOptions,
  KimiLaunchResult,
  WireEvent,
  SteerMessage,
  KimiTransferredSession,
  KimiInjectorOptions,
  KimiInjectionResult,
  SteerInjectionResult,
} from './kimi/index.js';

// Qwen Code 原生 adapter（覆盖等级 A）
export { QwenCodeImporter, resolveQwenProjectsPath } from './qwen/index.js';
export type { QwenImportOptions, QwenImportStats } from './qwen/index.js';

// Gemini CLI 原生 adapter（覆盖等级 A）
export { GeminiImporter, resolveGeminiSessionsPath } from './gemini/index.js';
export type { GeminiImportOptions, GeminiImportStats } from './gemini/index.js';

// OpenHands 原生 adapter（覆盖等级 A，HTTP 服务器架构 + GLM-5.2 ✅）
export { OpenHandsImporter, resolveOpenHandsWorkspace } from './openhands/index.js';
export type { OpenHandsImportOptions, OpenHandsImportStats } from './openhands/index.js';
export { OpenHandsApiWrapper } from './openhands/index.js';
export type {
  OpenHandsWrapperOptions,
  OpenHandsApiResult,
  LaunchConversationInput,
  LaunchedConversation,
} from './openhands/index.js';
export {
  registerMcp as registerOpenHandsMcp,
  unregisterMcp as unregisterOpenHandsMcp,
  isMcpRegisteredInOpenHands,
  buildYmeshArgsForOpenHands,
  listOpenHandsSkills,
  installOpenHandsSkill,
  listOpenHandsHooks,
  registerOpenHandsHook,
  unregisterAllOpenHandsHooks,
  setOpenHandsAlwaysOnContext,
  getOpenHandsAlwaysOnContext,
  clearOpenHandsAlwaysOnContext,
  injectAllToOpenHands,
  OPENHANDS_HOOK_EVENTS,
} from './openhands/index.js';
export type {
  OpenHandsMcpRegistrationResult,
  OpenHandsSkillEntry,
  OpenHandsHookConfig,
  OpenHandsHookEvent,
  OpenHandsFullInjectResult,
} from './openhands/index.js';

// Goose 原生 adapter（覆盖等级 A，SQLite + GLM-5.2 ✅ via zhipu）
export { GooseImporter, resolveGooseDbPath } from './goose/index.js';
export type { GooseImportOptions, GooseImportStats } from './goose/index.js';
export { GooseCliWrapper } from './goose/index.js';
export type {
  GooseWrapperOptions,
  GooseCliResult,
  GooseLaunchInput,
  GooseLaunchedSession,
} from './goose/index.js';
export {
  registerGooseMcp,
  unregisterGooseMcp,
  isMcpRegisteredInGoose,
  buildYmeshArgsForGoose,
  listGooseSkills,
  installGooseSkill,
  setGooseAlwaysOnContext,
  getGooseAlwaysOnContext,
  clearGooseAlwaysOnContext,
  injectAllToGoose,
} from './goose/index.js';
export type {
  GooseMcpRegistrationResult,
  GooseSkillEntry,
  GooseFullInjectResult,
} from './goose/index.js';

// Antigravity 原生 adapter（覆盖等级 A，Google IDE + GLM-5.2 ❌ 但可 handoff）
export { AntigravityImporter, resolveAntigravityDbPath } from './antigravity/index.js';
export type { AntigravityImportOptions, AntigravityImportStats } from './antigravity/index.js';
export { AntigravityCliWrapper } from './antigravity/index.js';
export type {
  AntigravityWrapperOptions,
  AgyResult,
  AgyLaunchInput,
  AgyLaunchedSession,
  AgySessionListItem,
} from './antigravity/index.js';
export {
  registerAntigravityMcp,
  unregisterAntigravityMcp,
  isMcpRegisteredInAntigravity,
  buildYmeshArgsForAntigravity,
  listAntigravitySkills,
  installAntigravitySkill,
  listAntigravityHooks,
  registerAntigravityHook,
  unregisterAllAntigravityHooks,
  setAntigravityAlwaysOnContext,
  getAntigravityAlwaysOnContext,
  clearAntigravityAlwaysOnContext,
  injectAllToAntigravity,
  ANTIGRAVITY_HOOK_EVENTS,
} from './antigravity/index.js';
export type {
  AntigravityMcpRegistrationResult,
  AntigravitySkillEntry,
  AntigravityHookConfig,
  AntigravityHookEvent,
  AntigravityFullInjectResult,
} from './antigravity/index.js';

// Pi Agent 家族原生 adapter（Pi / oh-my-pi / gsd-pi，覆盖等级 A；共享 JSONL v3 + RPC steer）
export {
  PiImporter,
  PiController,
  PiInjector,
  PiRpcClient,
  RpcError,
  resolvePiFlavors,
  resolveFlavorSessionsDir,
  encodeCwd,
} from './pi/index.js';
export type {
  PiFlavor,
  PiFlavorConfig,
  PiImportOptions,
  PiImportStats,
  PiFlavorStats,
  PiEntry,
  PiNeutralSession,
  PiSource,
  PiSessionSummary,
  PiSessionHandle,
  PiLaunchOptions,
  PiTransferResult,
  PiControllerOptions,
  McpServerDef,
  McpConfig,
  PiInjectResult,
  PiInjectorOptions,
  PiCli,
  RpcCommand,
  RpcResponseOk,
  RpcResponseErr,
  RpcResponse,
  RpcEvent,
  RpcImage,
  RpcClientOptions,
} from './pi/index.js';

// Cursor IDE 兼容 importer（覆盖等级 B —— SQLite 破解 + JSONL）
export {
  CursorIdeExtractor,
  CURSOR_HOOKS_PATH,
  CURSOR_HOOK_EVENTS,
  CURSOR_CORE_HOOK_EVENTS,
  CURSOR_CONFIG_DIR,
  CURSOR_MCP_PATH,
  CURSOR_SKILLS_DIR,
  CURSOR_RULES_PATH,
  CURSOR_RULES_ALT_PATH,
  handleCursorHookEvent,
  extractSession as extractCursorSession,
  transferSession as transferCursorSession,
  openCursorWorkspace,
  injectCursorIde,
  uninstallCursorIdeInjection,
} from './cursor-ide/index.js';
export type {
  CursorIdeExtractOptions,
  CursorIdeExtractStats,
  CursorHookPayload,
  HookHandleResult,
  ExtractSessionResult as CursorExtractSessionResult,
  TransferSessionResult as CursorTransferSessionResult,
  CursorInjectOptions,
  CursorInjectResult,
} from './cursor-ide/index.js';

// Trae IDE 兼容 importer（覆盖等级 B —— SQLCipher 破解尝试 + JSONL 摘要）
export {
  TraeIdeExtractor,
  tryCrackTraeSqlcipher,
  TRAE_CONFIG_DIRS as TRAE_IDE_CONFIG_DIRS,
  TRAE_RULES_START,
  TRAE_RULES_END,
  traeRulesPath,
  extractSession as extractTraeSession,
  transferSession as transferTraeSession,
  observeActiveSessions as observeTraeActiveSessions,
  openTraeWorkspace,
  TRAE_PROJECT_MCP_DIR,
  TRAE_PROJECT_MCP_FILE,
  injectTraeIde,
  uninstallTraeIdeInjection,
} from './trae-ide/index.js';
export type {
  TraeIdeExtractOptions,
  TraeIdeExtractStats,
  TraeExtractSessionResult,
  TraeTransferSessionResult,
  TraeActiveSessionObservation,
  TraeInjectOptions,
  TraeInjectResult,
} from './trae-ide/index.js';

// Cline 原生 adapter（覆盖等级 A，双轨 sessions.db + JSON transcript）
export {
  ClineImporter,
  resolveClineDataDir,
  resolveClineDbPath,
  resolveClineSessionsDir,
  ClineWrapper,
  DEFAULT_CLINE_DATA_DIR,
  ClineInjector,
  resolveClineMcpSettingsPath,
  resolveClineSkillsDir,
  resolveClineRulesPath,
} from './cline/index.js';
export type {
  ClineImportOptions,
  ClineImportStats,
  ClineThinkingLevel,
  ClineLaunchOptions,
  ClineNdjsonEvent,
  ClineLaunchResult,
  ExtractedClineSession,
  ClineHandoffPayload,
  ClineMcpServerDef,
  ClineInjectResult,
  ClineInjectOptions,
} from './cline/index.js';

// Crush 原生 adapter（覆盖等级 A，项目级 <cwd>/.crush/crush.db）
export {
  CrushImporter,
  resolveCrushDbPath,
  CrushWrapper,
  DEFAULT_CRUSH_CONFIG_DIR,
  CrushInjector,
  resolveCrushJsonPath,
  resolveCrushMdPath,
} from './crush/index.js';
export type {
  CrushImportOptions,
  CrushImportStats,
  CrushLaunchOptions,
  CrushLaunchResult,
  ExtractedCrushSession,
  CrushHandoffPayload,
  CrushMcpServerDef,
  CrushHookDef,
  CrushInjectResult,
  CrushInjectOptions,
} from './crush/index.js';

// Windsurf 兼容 adapter（覆盖等级 B —— Cascade .pb 加密，hook transcript 采集）
export {
  WindsurfExtractor,
  WINDSURF_CONFIG_DIR,
  WINDSURF_CASCADE_DIR,
  WINDSURF_TRANSCRIPTS_DIR,
  handleWindsurfHookEvent,
  extractSession as extractWindsurfSession,
  transferSession as transferWindsurfSession,
  openWindsurfWorkspace,
  WINDSURF_CASCADE_HOOK_EVENTS,
  WINDSURF_PRIMARY_HOOK_EVENT,
  WINDSURF_CORE_HOOK_EVENTS,
  WINDSURF_EVENTS_FILE,
  injectWindsurf,
  uninstallWindsurfInjection,
  WINDSURF_MCP_PATH,
  WINDSURF_MCP_ALT_PATH,
  WINDSURF_SKILLS_DIR,
  WINDSURF_HOOKS_TEMPLATE_PATH,
  WINDSURF_RULES_PATH,
} from './windsurf/index.js';
export type {
  WindsurfExtractOptions,
  WindsurfExtractStats,
  WindsurfHookPayload,
  HookHandleResult as WindsurfHookHandleResult,
  ExtractSessionResult as WindsurfExtractSessionResult,
  TransferSessionResult as WindsurfTransferSessionResult,
  WindsurfInjectOptions,
  WindsurfInjectResult,
} from './windsurf/index.js';

// Continue CLI 原生 adapter（覆盖等级 A，@continuedev/cli，binary: cn）
export {
  ContinueImporter,
  CONTINUE_CONFIG_DIR,
  CONTINUE_SESSIONS_DIR,
  CONTINUE_SESSIONS_INDEX,
  ContinueCliWrapper,
  extractSession as extractContinueSession,
  transferSession as transferContinueSession,
  isContinueInstalled,
  CONTINUE_EVENTS_FILE,
  registerContinueMcp,
  unregisterContinueMcp,
  isMcpRegisteredInContinue,
  buildYmeshArgsForContinue,
  listContinueSkills,
  installContinueSkill,
  injectContinueBundledSkills,
  setContinueAlwaysOnRules,
  clearContinueAlwaysOnRules,
  getContinueAlwaysOnRulesVersion,
  injectContinue,
  uninstallContinueInjection,
  CONTINUE_CONFIG_PATH,
  CONTINUE_SKILLS_DIR,
} from './continue/index.js';
export type {
  ContinueImportOptions,
  ContinueImportStats,
  ContinueWrapperOptions,
  ContinueCliResult,
  ContinueLaunchInput,
  ContinueLaunchedSession,
  ContinueInjectInput,
  ContinueSessionListItem,
  ContinueExtractResult,
  ContinueTransferResult,
  ContinueMcpRegistrationResult,
  ContinueSkillEntry,
  ContinueInjectResult,
  ContinueInjectOptions,
} from './continue/index.js';

// Daemon（LOOP-006）
export { YondermeshDaemon } from './daemon/index.js';
export type {
  DaemonConfig,
  DaemonStatus,
  FullScanResult,
  SourceScanResult,
} from './daemon/index.js';
export { defaultDaemonConfig, defaultDataDir } from './daemon/config.js';

// MCP Server（LOOP-011）
export { McpServer, parseRelativeTime } from './mcp/server.js';
export type { McpToolDef, McpToolResult } from './mcp/server.js';

// MCP 任务接管 handoff 包构造（LOOP-014）
export {
  buildSessionHandoff,
  buildCodexHandoff,
  buildClaudeHandoff,
  findCodexSessionFile,
  findClaudeSessionFile,
} from './mcp/codex-handoff.js';
export type {
  BuildHandoffOptions,
  CompactedSummary,
  HandoffMessage,
  HandoffPackage,
  HandoffSessionMeta,
} from './mcp/codex-handoff.js';

// 需求与响应提取器（LOOP-013）
export {
  extractProject,
  queryExtracts,
  loadExtractIndex,
  listExtracts,
  extractsBaseDir,
  projectHashOf,
  projectExtractDir,
} from './extract/index.js';
export type {
  ExtractEntry,
  ExtractKind,
  ExtractOptions,
  ExtractResult,
  QueryEntry,
  QueryOptions,
} from './extract/index.js';

// 安装与 release 管理（LOOP-008）
export {
  buildRelease,
  installRelease,
  rollbackRelease,
  listReleases,
  getCurrentRelease,
  generatePlist,
  installService,
  uninstallService,
  startService,
  stopService,
  getServiceStatus,
} from './install/index.js';
export type { ReleaseResult, ServiceStatus } from './install/index.js';
