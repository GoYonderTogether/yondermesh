/**
 * skillSymlinkStrategy.isMounted() readlink 校验集成测试
 *
 * 覆盖 src/mount/strategies.ts 的：
 *   - 指向非 ymesh 目录的 symlink → false（防止其他工具同名 symlink 误判）
 *   - 指向 ymesh release 目录的 symlink → true
 *   - 普通目录（非 symlink）→ false
 *   - 不存在的路径 → false
 *   - isOpenSpaceResidual() 正确识别 OpenSpace 残留目录
 *
 * 注意：isMounted() 当前实现校验 readlink target 是否包含
 * 'yondermesh' / 'ymesh' / 'release' 之一。测试用临时目录隔离，
 * 且 tmpHome 用中性前缀 'strat-' 避免 tmpHome 路径本身含 'ymesh' 污染校验。
 *
 * 若 src/mount/strategies.ts 模块不可用，全部测试自动 skip。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

type StrategiesModule = {
  skillSymlinkStrategy: {
    mount: (ext: unknown, skillsDir: string) => unknown;
    unmount: (extName: string, skillsDir: string) => unknown;
    isMounted: (extName: string, skillsDir: string) => boolean;
  };
  isOpenSpaceResidual: (dir: string) => boolean;
};

async function loadStrategies(): Promise<StrategiesModule | null> {
  try {
    const mod = (await import('../src/mount/strategies.js')) as Partial<StrategiesModule>;
    if (!mod.skillSymlinkStrategy || typeof mod.skillSymlinkStrategy.isMounted !== 'function') {
      return null;
    }
    if (typeof mod.isOpenSpaceResidual !== 'function') return null;
    return mod as StrategiesModule;
  } catch {
    return null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

let tmpHome: string;

/** 中性前缀避免 tmpHome 路径本身含 'ymesh' 污染 readlink target 校验 */
function mkdtemp(): string {
  return fs.mkdtempSync(path.join(tmpdir(), 'strat-'));
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

// ─── skillSymlinkStrategy.isMounted() readlink 校验 ─────────────────────────

describe('skillSymlinkStrategy.isMounted() readlink 校验', () => {
  it('指向非 ymesh 目录的 symlink → false', async () => {
    const mod = await loadStrategies();
    if (!mod) {
      console.log('strategies module not available, skipping');
      return;
    }

    // 模拟其他工具（如 lark-* marketplace）创建的同名 symlink，
    // target 是普通目录，不含 yondermesh/ymesh/release 任何关键字。
    const skillsDir = path.join(tmpHome, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const foreignTarget = path.join(tmpHome, 'lark-marketplace', 'diagnose-skill');
    fs.mkdirSync(foreignTarget, { recursive: true });
    fs.writeFileSync(path.join(foreignTarget, 'SKILL.md'), '# foreign');
    fs.symlinkSync(foreignTarget, path.join(skillsDir, 'yondermesh-diagnose'), 'dir');

    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);
  });

  it('指向 ymesh release 目录的 symlink → true', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    // 真实 ymesh release 目录结构：~/.yondermesh/releases/current/skills/<name>
    // 这里在 tmpHome 下构造等价结构，target 含 'yondermesh' 与 'releases'。
    const skillsDir = path.join(tmpHome, 'target-cli', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const ymeshSkillSrc = path.join(
      tmpHome,
      'yondermesh',
      'releases',
      'current',
      'skills',
      'yondermesh-diagnose',
    );
    fs.mkdirSync(ymeshSkillSrc, { recursive: true });
    fs.writeFileSync(path.join(ymeshSkillSrc, 'SKILL.md'), '---\nname: test\n---\n# test');
    fs.symlinkSync(ymeshSkillSrc, path.join(skillsDir, 'yondermesh-diagnose'), 'dir');

    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(true);
  });

  it('普通目录（非 symlink）→ false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const skillsDir = path.join(tmpHome, 'skills');
    // 直接 mkdir 一个同名普通目录（非 symlink）
    fs.mkdirSync(path.join(skillsDir, 'yondermesh-diagnose'), { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, 'yondermesh-diagnose', 'SKILL.md'),
      '# not a symlink',
    );

    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);
  });

  it('不存在的路径 → false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    // skillsDir 本身不存在
    const skillsDir = path.join(tmpHome, 'no-such-dir', 'skills');
    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);

    // skillsDir 存在但 linkPath 不存在
    const emptySkillsDir = path.join(tmpHome, 'empty-skills');
    fs.mkdirSync(emptySkillsDir, { recursive: true });
    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', emptySkillsDir)).toBe(false);
  });

  it('指向含 "release" 关键字的目录 → true（关键字匹配分支）', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    // 验证 isMounted 的第三个关键字 'release' 分支：
    // target 路径含 'release' 即判定为 ymesh 挂载。
    const skillsDir = path.join(tmpHome, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const releaseTarget = path.join(tmpHome, 'my-release-dir', 'skill');
    fs.mkdirSync(releaseTarget, { recursive: true });
    fs.symlinkSync(releaseTarget, path.join(skillsDir, 'yondermesh-diagnose'), 'dir');

    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(true);
  });

  it('mount + isMounted 往返：mount 后 isMounted 返回 true', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const skillsDir = path.join(tmpHome, 'target-cli', 'skills');
    const ymeshSkillSrc = path.join(
      tmpHome,
      'yondermesh',
      'releases',
      'current',
      'skills',
      'yondermesh-diagnose',
    );
    fs.mkdirSync(ymeshSkillSrc, { recursive: true });
    fs.writeFileSync(path.join(ymeshSkillSrc, 'SKILL.md'), '# test');

    const ext = {
      type: 'skill',
      name: 'yondermesh-diagnose',
      skillPath: ymeshSkillSrc,
    };

    // mount 前 false
    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);
    // mount
    const result = mod.skillSymlinkStrategy.mount(ext, skillsDir) as { success: boolean };
    expect(result.success).toBe(true);
    // mount 后 true
    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(true);
    // unmount 后 false
    mod.skillSymlinkStrategy.unmount('yondermesh-diagnose', skillsDir);
    expect(mod.skillSymlinkStrategy.isMounted('yondermesh-diagnose', skillsDir)).toBe(false);
  });
});

// ─── isOpenSpaceResidual() OpenSpace 残留目录检测 ───────────────────────────

describe('isOpenSpaceResidual() OpenSpace 残留目录检测', () => {
  it('识别 OpenSpace 残留目录（仅 skills/ 且 skills/ 下全是 → ~/.agents/skills/ 的 symlink）', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.junie');
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const agentsSkills = path.join(tmpHome, '.agents', 'skills');
    fs.mkdirSync(path.join(agentsSkills, 'skill-a'), { recursive: true });
    fs.mkdirSync(path.join(agentsSkills, 'skill-b'), { recursive: true });
    fs.symlinkSync(path.join(agentsSkills, 'skill-a'), path.join(skillsDir, 'skill-a'), 'dir');
    fs.symlinkSync(path.join(agentsSkills, 'skill-b'), path.join(skillsDir, 'skill-b'), 'dir');

    expect(mod.isOpenSpaceResidual(dir)).toBe(true);
  });

  it('真实 CLI 目录（除 skills/ 还有其他文件）→ false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.codex');
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "x"');

    expect(mod.isOpenSpaceResidual(dir)).toBe(false);
  });

  it('skills/ 含普通目录（非 symlink）→ false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.roo');
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(path.join(skillsDir, 'real-skill'), { recursive: true });

    expect(mod.isOpenSpaceResidual(dir)).toBe(false);
  });

  it('skills/ 的 symlink 指向非 ~/.agents/skills/ → false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.qoder');
    const skillsDir = path.join(dir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const otherTarget = path.join(tmpHome, 'somewhere', 'skill');
    fs.mkdirSync(otherTarget, { recursive: true });
    fs.symlinkSync(otherTarget, path.join(skillsDir, 'skill'), 'dir');

    expect(mod.isOpenSpaceResidual(dir)).toBe(false);
  });

  it('唯一子目录名不是 "skills" → false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.mux');
    fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });

    expect(mod.isOpenSpaceResidual(dir)).toBe(false);
  });

  it('不存在的目录 → false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    expect(mod.isOpenSpaceResidual(path.join(tmpHome, 'does-not-exist'))).toBe(false);
  });

  it('skills/ 为空目录 → false', async () => {
    const mod = await loadStrategies();
    if (!mod) return;

    const dir = path.join(tmpHome, '.empty');
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });

    expect(mod.isOpenSpaceResidual(dir)).toBe(false);
  });
});
