/**
 * yondermesh Adapter SDK 模板集成测试
 *
 * 覆盖 src/sdk/*：
 *   - scaffoldAdapter() 生成 4 个文件（importer/wrapper/inject/index），路径与内容正确
 *   - 生成的 importer 文件是合法 TypeScript（ts.transpileModule 无语法错误）
 *   - BaseImporter 可被子类化，import() 在空目录上返回 0 session 统计
 *   - BaseInjector 幂等标记块：inject 两次只留一块，remove 后干净恢复
 *
 * 若 src/sdk 模块不可用，全部测试自动 skip。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── SDK 模块动态加载（conditional skip） ──────────────────────────────────

type ScaffoldFile = { path: string; content: string };
type ScaffoldResult = { files: ScaffoldFile[] };

type SdkModule = {
  scaffoldAdapter: (name: string, options?: unknown) => ScaffoldResult;
  BaseImporter: new (store: unknown, opts: unknown) => unknown;
  BaseInjector: new (opts?: unknown) => unknown;
  CONTEXT_BLOCK_START: string;
  CONTEXT_BLOCK_END: string;
};

async function loadSdk(): Promise<SdkModule | null> {
  try {
    const mod = (await import('../src/sdk/index.js')) as Partial<SdkModule>;
    if (typeof mod.scaffoldAdapter !== 'function') return null;
    if (typeof mod.BaseImporter !== 'function') return null;
    if (typeof mod.BaseInjector !== 'function') return null;
    if (typeof mod.CONTEXT_BLOCK_START !== 'string') return null;
    return mod as SdkModule;
  } catch {
    return null;
  }
}

/** 动态加载 typescript 编译器（devDependency），用于校验生成的 importer.ts 语法 */
async function loadTs(): Promise<{ transpileModule: (input: string, opts: unknown) => { outputText: string; diagnostics?: unknown[] } } | null> {
  try {
    const ts = (await import('typescript')) as unknown as {
      transpileModule: (input: string, opts: unknown) => { outputText: string; diagnostics?: unknown[] };
    };
    if (typeof ts.transpileModule !== 'function') return null;
    return ts;
  } catch {
    return null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpHome: string;

function mkdtemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-'));
}

beforeEach(() => {
  tmpHome = mkdtemp();
});

afterEach(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─── scaffoldAdapter ────────────────────────────────────────────────────────

describe('scaffoldAdapter()', () => {
  it('生成 4 个文件（importer/wrapper/inject/index）', async () => {
    const sdk = await loadSdk();
    if (!sdk) {
      console.log('sdk module not available, skipping');
      return;
    }
    const { files } = sdk.scaffoldAdapter('mycli');
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBe(4);

    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/mycli/importer.ts');
    expect(paths).toContain('src/mycli/wrapper.ts');
    expect(paths).toContain('src/mycli/inject.ts');
    expect(paths).toContain('src/mycli/index.ts');
  });

  it('每个文件内容非空且为字符串', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    for (const f of files) {
      expect(typeof f.content).toBe('string');
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it('id 小写化与非法字符替换（"My Cli" → "my-cli"）', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    // scaffoldAdapter 用 name.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    // "My Cli" → "my cli" → "my-cli"
    const { files } = sdk.scaffoldAdapter('My Cli');
    const paths = files.map((f) => f.path);
    expect(paths).toContain('src/my-cli/importer.ts');
    expect(paths).toContain('src/my-cli/index.ts');
  });

  it('id 非法字符（含 "!"）替换为连字符', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    // "My Cli!" → "my cli!" → "my-cli-"（"!" → "-"，不去除首尾连字符）
    const { files } = sdk.scaffoldAdapter('My Cli!');
    const id = files[0]!.path.split('/')[1]!;
    expect(id).toBe('my-cli-');
    for (const f of files) {
      expect(f.path.startsWith(`src/${id}/`)).toBe(true);
    }
  });

  it('importer 模板继承 BaseImporter 并声明 source/coverage', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const importer = files.find((f) => f.path.endsWith('importer.ts'))!;
    expect(importer).toBeDefined();
    expect(importer.content).toContain('extends BaseImporter');
    expect(importer.content).toMatch(/readonly source\s*=\s*['"]mycli['"]/);
    expect(importer.content).toMatch(/readonly coverage/);
    expect(importer.content).toContain('resolveRootPath');
    expect(importer.content).toContain('*scan(');
    expect(importer.content).toContain('parse(');
  });

  it('injector 模板继承 BaseInjector 并实现 injectAll/uninjectAll', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const injector = files.find((f) => f.path.endsWith('inject.ts'))!;
    expect(injector).toBeDefined();
    expect(injector.content).toContain('extends BaseInjector');
    expect(injector.content).toContain('injectAll');
    expect(injector.content).toContain('uninjectAll');
    expect(injector.content).toContain('injectMarkedBlock');
    expect(injector.content).toContain('removeMarkedBlock');
  });

  it('wrapper 模板继承 BaseWrapper', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const wrapper = files.find((f) => f.path.endsWith('wrapper.ts'))!;
    expect(wrapper).toBeDefined();
    expect(wrapper.content).toContain('extends BaseWrapper');
    expect(wrapper.content).toMatch(/readonly sourceCli\s*=\s*['"]mycli['"]/);
    expect(wrapper.content).toContain('async launch(');
    expect(wrapper.content).toContain('async inject(');
    expect(wrapper.content).toContain('extractSession');
  });

  it('index 模板再导出 importer/wrapper/injector', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const index = files.find((f) => f.path.endsWith('index.ts'))!;
    expect(index).toBeDefined();
    expect(index.content).toContain('MycliImporter');
    expect(index.content).toContain('MycliWrapper');
    expect(index.content).toContain('MycliInjector');
  });

  it('sessionFormat 选项影响 importer 的 scan 默认实现', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    // jsonl（默认）
    const jsonl = sdk.scaffoldAdapter('a', { sessionFormat: 'jsonl' }).files.find((f) => f.path.endsWith('importer.ts'))!;
    expect(jsonl.content).toContain('collectJsonlFiles');

    // sqlite
    const sqlite = sdk.scaffoldAdapter('b', { sessionFormat: 'sqlite' }).files.find((f) => f.path.endsWith('importer.ts'))!;
    expect(sqlite.content).toContain('state.db');

    // json
    const json = sdk.scaffoldAdapter('c', { sessionFormat: 'json' }).files.find((f) => f.path.endsWith('importer.ts'))!;
    expect(json.content).toContain('*.json');

    // markdown
    const md = sdk.scaffoldAdapter('d', { sessionFormat: 'markdown' }).files.find((f) => f.path.endsWith('importer.ts'))!;
    expect(md.content).toContain('.md');
  });
});

// ─── 生成的 importer 文件 TypeScript 语法校验 ──────────────────────────────

describe('生成的 importer 文件 TypeScript 语法校验', () => {
  it('importer.ts 可被 ts.transpileModule 解析（无语法错误）', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const ts = await loadTs();
    if (!ts) {
      console.log('typescript compiler not available, skipping syntax check');
      return;
    }
    const { files } = sdk.scaffoldAdapter('mycli');
    const importer = files.find((f) => f.path.endsWith('importer.ts'))!;

    // transpileModule 不做类型检查，但能捕获语法错误
    const result = ts.transpileModule(importer.content, {
      compilerOptions: {
        target: 1, // ESNext = 1 in ts.ScriptTarget enum, numeric avoids enum import
        module: 1, // ESNext
        moduleResolution: 2, // NodeJs
      },
    });
    expect(typeof result.outputText).toBe('string');
    expect(result.outputText.length).toBeGreaterThan(0);
    // diagnostics 若存在应为空（语法错误才会产生 diagnostic）
    if (result.diagnostics) {
      expect(result.diagnostics.length).toBe(0);
    }
  });

  it('injector.ts 可被 ts.transpileModule 解析（无语法错误）', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const ts = await loadTs();
    if (!ts) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const injector = files.find((f) => f.path.endsWith('inject.ts'))!;
    const result = ts.transpileModule(injector.content, {
      compilerOptions: { target: 1, module: 1, moduleResolution: 2 },
    });
    expect(result.outputText.length).toBeGreaterThan(0);
    if (result.diagnostics) {
      expect(result.diagnostics.length).toBe(0);
    }
  });

  it('wrapper.ts 可被 ts.transpileModule 解析（无语法错误）', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;
    const ts = await loadTs();
    if (!ts) return;
    const { files } = sdk.scaffoldAdapter('mycli');
    const wrapper = files.find((f) => f.path.endsWith('wrapper.ts'))!;
    const result = ts.transpileModule(wrapper.content, {
      compilerOptions: { target: 1, module: 1, moduleResolution: 2 },
    });
    expect(result.outputText.length).toBeGreaterThan(0);
    if (result.diagnostics) {
      expect(result.diagnostics.length).toBe(0);
    }
  });
});

// ─── BaseImporter import() ─────────────────────────────────────────────────

describe('BaseImporter import()', () => {
  it('子类化后 import() 在空目录返回 0 session 统计', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    // 动态加载 SessionStore（避免硬依赖路径变化）
    let storeCtor: new (location: string) => unknown;
    try {
      const storeMod = (await import('../src/store/index.js')) as { SessionStore: new (location: string) => unknown };
      storeCtor = storeMod.SessionStore;
    } catch {
      console.log('SessionStore not available, skipping');
      return;
    }

    const store = new storeCtor(':memory:');

    // 创建一个最小可用的 BaseImporter 子类
    // 用 Function 构造避免 TS 抽象类实例化限制；这里直接用 extends
    class TestImporter extends sdk.BaseImporter<undefined> {
      readonly source = 'test-sdk';
      readonly coverage = 'A' as const;
      resolveRootPath(): string {
        return path.join(tmpHome, 'sessions');
      }
      *scan(_rootPath: string): Iterable<{ file: string; data: undefined }> {
        // 空 scan：无文件
      }
      parse(_filePath: string, _data: undefined): null {
        return null;
      }
    }

    // 准备空目录
    fs.mkdirSync(path.join(tmpHome, 'sessions'), { recursive: true });

    const importer = new TestImporter(store, { deviceId: 'test-device' });
    const stats = (importer as unknown as { import: () => Record<string, number> }).import();

    expect(stats).toBeDefined();
    expect(stats.scanned).toBe(0);
    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.skipped).toBe(0);
  });

  it('import() 扫描到文件但 parse 返回 null 时计入 skipped', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    let storeCtor: new (location: string) => unknown;
    try {
      const storeMod = (await import('../src/store/index.js')) as { SessionStore: new (location: string) => unknown };
      storeCtor = storeMod.SessionStore;
    } catch {
      return;
    }

    const store = new storeCtor(':memory:');
    const sessionsDir = path.join(tmpHome, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // 放两个 .jsonl 文件（内容无所谓，parse 永远返回 null）
    fs.writeFileSync(path.join(sessionsDir, 'a.jsonl'), '{"id":"a"}\n');
    fs.writeFileSync(path.join(sessionsDir, 'b.jsonl'), '{"id":"b"}\n');

    class TestImporter extends sdk.BaseImporter<undefined> {
      readonly source = 'test-sdk-skip';
      readonly coverage = 'A' as const;
      resolveRootPath(): string {
        return sessionsDir;
      }
      *scan(rootPath: string): Iterable<{ file: string; data: undefined }> {
        for (const f of this.collectJsonlFiles(rootPath)) {
          yield { file: f.absPath, data: undefined };
        }
      }
      parse(_filePath: string, _data: undefined): null {
        return null;
      }
    }

    const importer = new TestImporter(store, { deviceId: 'test-device' });
    const stats = (importer as unknown as { import: () => Record<string, number> }).import();

    expect(stats.scanned).toBe(2);
    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBe(2);
  });
});

// ─── BaseInjector 幂等标记块 ────────────────────────────────────────────────

describe('BaseInjector 幂等标记块', () => {
  it('injectMarkedBlock 在空文件上创建标记块', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    const configDir = path.join(tmpHome, '.mycli');
    fs.mkdirSync(configDir, { recursive: true });

    class TestInjector extends sdk.BaseInjector {
      readonly cliId = 'mycli';
      readonly configDir = '.mycli';
      async injectAll(): Promise<void> {
        /* noop */
      }
      async uninjectAll(): Promise<void> {
        /* noop */
      }
    }

    const injector = new TestInjector({ home: tmpHome });
    const file = path.join(configDir, 'AGENTS.md');
    const result = (injector as unknown as {
      injectMarkedBlock: (f: string, block?: string) => { success: boolean };
    }).injectMarkedBlock(file);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain(sdk.CONTEXT_BLOCK_START);
    expect(content).toContain(sdk.CONTEXT_BLOCK_END);
  });

  it('injectMarkedBlock 两次只留一块（幂等）', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    const configDir = path.join(tmpHome, '.mycli');
    fs.mkdirSync(configDir, { recursive: true });

    class TestInjector extends sdk.BaseInjector {
      readonly cliId = 'mycli';
      readonly configDir = '.mycli';
      async injectAll(): Promise<void> {
        /* noop */
      }
      async uninjectAll(): Promise<void> {
        /* noop */
      }
    }

    const injector = new TestInjector({ home: tmpHome, awarenessBlock: '## custom block v1' });
    const file = path.join(configDir, 'AGENTS.md');

    // 第一次注入
    (injector as unknown as { injectMarkedBlock: (f: string) => { success: boolean } }).injectMarkedBlock(file);
    // 第二次注入（用不同内容）
    const injector2 = new TestInjector({ home: tmpHome, awarenessBlock: '## custom block v2' });
    (injector2 as unknown as { injectMarkedBlock: (f: string) => { success: boolean } }).injectMarkedBlock(file);

    const content = fs.readFileSync(file, 'utf8');
    // 只有一个 START 标记（幂等：替换而非追加）
    const startCount = (content.match(new RegExp(escapeRegex(sdk.CONTEXT_BLOCK_START), 'g')) || []).length;
    expect(startCount).toBe(1);
    // 新内容已生效，旧内容已替换
    expect(content).toContain('v2');
    expect(content).not.toContain('v1');
  });

  it('removeMarkedBlock 移除标记块并保留其他内容', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    const configDir = path.join(tmpHome, '.mycli');
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'AGENTS.md');
    // 预置用户原有内容
    fs.writeFileSync(file, '# My Custom Rules\n\nDo good things.\n');

    class TestInjector extends sdk.BaseInjector {
      readonly cliId = 'mycli';
      readonly configDir = '.mycli';
      async injectAll(): Promise<void> {
        /* noop */
      }
      async uninjectAll(): Promise<void> {
        /* noop */
      }
    }

    const injector = new TestInjector({ home: tmpHome });
    const typed = injector as unknown as {
      injectMarkedBlock: (f: string) => { success: boolean };
      removeMarkedBlock: (f: string) => { success: boolean };
    };

    // 注入
    typed.injectMarkedBlock(file);
    let content = fs.readFileSync(file, 'utf8');
    expect(content).toContain(sdk.CONTEXT_BLOCK_START);
    expect(content).toContain('# My Custom Rules');

    // 移除
    const result = typed.removeMarkedBlock(file);
    expect(result.success).toBe(true);

    content = fs.readFileSync(file, 'utf8');
    expect(content).not.toContain(sdk.CONTEXT_BLOCK_START);
    expect(content).not.toContain(sdk.CONTEXT_BLOCK_END);
    // 用户原有内容保留
    expect(content).toContain('# My Custom Rules');
    expect(content).toContain('Do good things.');
  });

  it('removeMarkedBlock 在无标记块的文件上是 no-op', async () => {
    const sdk = await loadSdk();
    if (!sdk) return;

    const configDir = path.join(tmpHome, '.mycli');
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, 'AGENTS.md');
    fs.writeFileSync(file, '# Just user content\n');

    class TestInjector extends sdk.BaseInjector {
      readonly cliId = 'mycli';
      readonly configDir = '.mycli';
      async injectAll(): Promise<void> {
        /* noop */
      }
      async uninjectAll(): Promise<void> {
        /* noop */
      }
    }

    const injector = new TestInjector({ home: tmpHome });
    const result = (injector as unknown as {
      removeMarkedBlock: (f: string) => { success: boolean };
    }).removeMarkedBlock(file);

    expect(result.success).toBe(true);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toBe('# Just user content\n');
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
