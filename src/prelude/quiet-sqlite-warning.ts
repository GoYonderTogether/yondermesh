/**
 * 精准抑制 `node:sqlite` 的 ExperimentalWarning。
 *
 * 为什么需要：Node ≥22 的 `node:sqlite` 每次进程启动都会打一行
 *   `(node:xxx) ExperimentalWarning: SQLite is an experimental feature…`
 * 它出现在**每一条** ymesh 命令的 stderr 上：污染人读输出、污染 `--json`
 * 解析、看起来像在报错。
 *
 * 注意：这里**只**丢这一条实验性警告，其它 warning 一律照常输出——
 * 不做全局静音（会掩盖真问题）。
 *
 * 用法：在 CLI / MCP 入口**第一个** import 它（ESM 按 import 顺序求值，
 * 因此它的副作用会先于 `node:sqlite` 被加载）。
 */
const original = process.emitWarning.bind(process);

type WarningLike = string | Error;
interface WarningOptions {
  type?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emitWarning = (warning: WarningLike, ...args: unknown[]): void => {
  const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
  const first = args[0];
  const type =
    typeof first === 'string'
      ? first
      : ((first as WarningOptions | undefined)?.type ??
        (typeof warning === 'object' ? (warning as Error).name : ''));
  // 只丢「SQLite 实验性」这一条
  if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (original as any)(warning, ...args);
};

export {};
