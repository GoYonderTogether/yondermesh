export { CLI_REGISTRY, detectInstalledClis, findCli } from './registry.js';
export { mountAll, verifyAll, unmountAll, mountForCli, defaultExtensions } from './manager.js';
export {
  mcpJsonStrategy,
  mcpTomlStrategy,
  skillSymlinkStrategy,
  claudeMcpStrategy,
  isOpenSpaceResidual,
} from './strategies.js';
export type {
  Extension,
  McpServerDef,
  MountResult,
  MountStatus,
  CliTarget,
  CliCapability,
  ExtensionType,
  MountStrategyType,
} from './types.js';
